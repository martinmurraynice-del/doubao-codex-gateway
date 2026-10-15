import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startServer } from '../src/server.mjs';
import { GatewayClient } from '../src/client.mjs';
import { Store } from '../src/store.mjs';

class FakeCodex extends EventEmitter {
  constructor(threads = new Map()) { super(); this.ready = false; this.threads = threads; this.calls = []; this.startCalls = 0; this.stopCalls = 0; }
  async start() { this.startCalls++; await this.onStart?.(); this.ready = true; }
  async stop() { this.stopCalls++; this.ready = false; this.onStop?.(); this.emit('disconnect', { expected: true }); }
  respond() {}
  reject() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      const thread = { id: `thread-${this.threads.size + 1}`, cwd: params.cwd, turns: [] };
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread) };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: structuredClone(this.threads.get(params.threadId)) };
    if (method === 'turn/start') {
      const thread = this.threads.get(params.threadId);
      const turn = { id: `turn-${thread.turns.length + 1}`, status: 'inProgress', items: [] };
      thread.turns.push(turn);
      return { turn: structuredClone(turn) };
    }
    if (method === 'turn/interrupt') {
      const turn = this.threads.get(params.threadId).turns.find((turn) => turn.id === params.turnId);
      turn.status = 'interrupted';
      this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: structuredClone(turn) } });
      return {};
    }
    if (method === 'model/list') return { data: [], nextCursor: null };
    throw new Error(`Unexpected fake method ${method}`);
  }
}

async function setup(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-server-test-')));
  const workspace = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const config = { allowedRoots: [workspace], port: 0, maxConcurrent: 1, codexBin: 'unused' };
  const codex = options.client || new FakeCodex();
  let service;
  t.after(async () => { await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  service = await startServer({ config, stateDir, client: codex, tickIntervalMs: options.tickIntervalMs ?? 20, reconnectOptions: options.reconnectOptions });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const rpc = new GatewayClient({ stateDir });
  return { root, workspace, stateDir, config, codex, service, token, headers, rpc };
}

async function until(check) {
  const end = Date.now() + 2_000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for gateway state');
}

// Exercise retry timing without waiting for production backoff intervals.
class RetryClock {
  constructor() { this.time = 1_000_000; this.sequence = 0; this.timers = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay) => { const id = ++this.sequence; this.timers.set(id, { callback, at: this.time + delay }); return id; };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(delta) {
    const target = this.time + delta;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('idle Codex disconnect reconnects automatically without a business RPC', async t => {
  const clock = new RetryClock();
  const { codex, rpc } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 40 }, tickIntervalMs: 60_000 });
  codex.ready = false; codex.emit('disconnect', { code: 'TEST_EXIT' });
  const health = await rpc.call('health');
  assert.equal(health.codexConnected, false);
  assert.deepEqual(health.connection, { status: 'reconnecting', attempts: 0, nextRetryAt: new Date(clock.now() + 10).toISOString() });
  await clock.advance(9); assert.equal(codex.startCalls, 1);
  await clock.advance(1);
  assert.equal(codex.startCalls, 2); assert.equal(codex.ready, true);
  assert.deepEqual(codex.calls, [], 'transport recovery must not inspect or start any task');
  assert.deepEqual((await rpc.call('health')).connection, { status: 'connected', attempts: 0, nextRetryAt: null });
});

test('reconnect failures back off exponentially up to the cap without logging raw errors', async t => {
  const clock = new RetryClock(); const logs = [];
  const { codex, rpc } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 25, logger: (...entry) => logs.push(entry) }, tickIntervalMs: 60_000 });
  let failures = 2;
  codex.onStart = async () => {
    if (failures-- > 0) { codex.emit('disconnect', { code: 'RETRY_FAILED' }); throw new Error('PRIVATE_ERROR_SENTINEL'); }
  };
  codex.ready = false; codex.emit('disconnect');
  await clock.advance(10);
  assert.equal(codex.startCalls, 2);
  assert.deepEqual((await rpc.call('health')).connection, { status: 'reconnecting', attempts: 1, nextRetryAt: new Date(clock.now() + 20).toISOString() });
  await clock.advance(19); assert.equal(codex.startCalls, 2);
  await clock.advance(1); assert.equal(codex.startCalls, 3);
  assert.deepEqual((await rpc.call('health')).connection, { status: 'reconnecting', attempts: 2, nextRetryAt: new Date(clock.now() + 25).toISOString() });
  codex.emit('disconnect'); codex.emit('disconnect');
  await clock.advance(24); assert.equal(codex.startCalls, 3);
  await clock.advance(1); assert.equal(codex.startCalls, 4); assert.equal(codex.ready, true);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(logs.map(([event]) => event), ['codex_transport_reconnect_failed', 'codex_transport_reconnect_failed', 'codex_transport_reconnected']);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_ERROR_SENTINEL'));
});

test('repeated disconnect events share one timer and one in-flight initialization', async t => {
  const clock = new RetryClock();
  const { codex, rpc } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 40 }, tickIntervalMs: 60_000 });
  let release; const pending = new Promise(resolve => { release = resolve; });
  codex.onStart = () => pending;
  codex.ready = false;
  for (let i = 0; i < 5; i++) codex.emit('disconnect');
  assert.equal(clock.timers.size, 1);
  await clock.advance(10); assert.equal(codex.startCalls, 2);
  for (let i = 0; i < 5; i++) codex.emit('disconnect');
  await clock.advance(1000);
  assert.equal(codex.startCalls, 2); assert.equal(clock.timers.size, 0);
  assert.deepEqual((await rpc.call('health')).connection, { status: 'reconnecting', attempts: 1, nextRetryAt: null });
  release(); await clock.advance(0);
  assert.equal(codex.ready, true); assert.equal(codex.startCalls, 2);
});

test('transport reconnect preserves uncertain capacity and does not replay or reconcile a turn', async t => {
  const clock = new RetryClock();
  const { codex, rpc, service, workspace } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 40 } });
  const first = await rpc.call('submit', { workspace, task: 'Task with an uncertain result', idempotencyKey: 'uncertain-reconnect' });
  await until(() => service.engine.get(first.id).status === 'running');
  const running = service.engine.get(first.id);
  const second = await rpc.call('submit', { workspace, task: 'Wait for its workspace', idempotencyKey: 'queued-after-disconnect' });
  const callsBefore = codex.calls.length;
  codex.ready = false; codex.emit('disconnect');
  assert.equal(service.engine.get(first.id).status, 'uncertain');
  await clock.advance(10);
  await service.engine.tick();
  const current = service.engine.get(first.id);
  assert.equal(codex.ready, true);
  assert.equal(current.status, 'uncertain'); assert.equal(current.holdsCapacity, true);
  assert.equal(current.turnId, running.turnId); assert.equal(current.attempt, running.attempt);
  assert.equal(service.engine.get(second.id).status, 'queued');
  assert.deepEqual(codex.calls.slice(callsBefore), [], 'reconnect must not call thread/read, thread/resume, or turn/start');
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('close cancels scheduled retries and cannot resurrect a stopped transport', async t => {
  const clock = new RetryClock();
  const { codex, service } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 40 }, tickIntervalMs: 60_000 });
  codex.ready = false; codex.emit('disconnect');
  assert.equal(clock.timers.size, 1);
  await service.close();
  assert.equal(clock.timers.size, 0);
  codex.emit('disconnect'); await clock.advance(1000);
  assert.equal(codex.startCalls, 1); assert.equal(codex.ready, false);
});

test('close drains an in-flight reconnect and stops even a late successful initialization', async t => {
  const clock = new RetryClock();
  const { codex, service, stateDir } = await setup(t, { reconnectOptions: { clock, initialDelayMs: 10, maxDelayMs: 40 }, tickIntervalMs: 60_000 });
  let release; const pending = new Promise(resolve => { release = resolve; });
  codex.onStart = () => pending;
  codex.onStop = () => release();
  codex.ready = false; codex.emit('disconnect'); await clock.advance(10);
  assert.equal(codex.startCalls, 2);
  await service.close();
  assert.equal(codex.ready, false);
  assert.ok(codex.stopCalls >= 2, 'a transport that completed after the first stop must be stopped again');
  await clock.advance(1000); assert.equal(codex.startCalls, 2);
  assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
});

test('HTTP health is minimal, RPC requires authentication, and credentials stay private', async (t) => {
  const { service, stateDir, token, headers, rpc, codex } = await setup(t);
  const health = await fetch(`${service.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'doubao-codex-gateway' });
  for (const authorization of [undefined, 'Bearer invalid']) {
    const response = await fetch(`${service.url}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ method: 'health' }),
    });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(token));
  }
  assert.equal((await rpc.call('health')).codexConnected, true);
  assert.equal((await rpc.call('health')).connectionScope, 'transport_only');
  assert.equal((await rpc.call('health')).lastProtocolError, null);
  codex.lastProtocolError = { code: 'CODEX_MESSAGE_TOO_LARGE', message: 'Codex message exceeds transport limit', at: new Date().toISOString() };
  assert.deepEqual((await rpc.call('health')).lastProtocolError, codex.lastProtocolError);
  assert.equal(fs.statSync(path.join(stateDir, 'token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(stateDir, 'connection.json')).mode & 0o777, 0o600);
  const forbidden = await fetch(`${service.url}/rpc`, { method: 'POST', headers, body: JSON.stringify({ method: '__proto__' }) });
  assert.equal((await forbidden.json()).error.code, 'METHOD_NOT_FOUND');
});

test('HTTP rejects browser origins, foreign Host headers, malformed JSON and oversized bodies', async (t) => {
  const { service, headers } = await setup(t);
  for (const extra of [{ origin: 'https://example.org' }, { origin: 'null' }]) {
    const response = await fetch(`${service.url}/rpc`, { method: 'POST', headers: { ...headers, ...extra }, body: '{"method":"health"}' });
    assert.equal(response.status, 403);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(`${service.url}/health`, { headers: { host: 'evil.example:18593' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  const bad = await fetch(`${service.url}/rpc`, { method: 'POST', headers, body: '{' });
  assert.equal((await bad.json()).error.code, 'INVALID_JSON');
  const wrongType = await fetch(`${service.url}/rpc`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const huge = await fetch(`${service.url}/rpc`, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error.code, 'BODY_TOO_LARGE');
});

test('singleton daemon lock prevents a second scheduler and is released on close', async (t) => {
  const { service, config, stateDir } = await setup(t);
  await assert.rejects(startServer({ config, stateDir, client: new FakeCodex() }), { code: 'DAEMON_RUNNING' });
  await service.close();
  assert.equal(fs.existsSync(path.join(stateDir, 'connection.json')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'token')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  const second = await startServer({ config, stateDir, client: new FakeCodex() });
  await second.close();
});

test('wait does not block cancellation and concurrent submissions keep one task', async (t) => {
  const { rpc, workspace, service, codex } = await setup(t);
  const input = { workspace, task: 'Create output', idempotencyKey: 'one' };
  const [first, duplicate] = await Promise.all([rpc.call('submit', input), rpc.call('submit', input)]);
  assert.equal(first.id, duplicate.id);
  await until(() => service.engine.get(first.id).status === 'running');
  assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 1);
  const running = await rpc.call('get', { id: first.id });
  const waiting = rpc.call('wait', { id: first.id, after: running.cursor, timeoutSeconds: 4 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cancelled = await rpc.call('cancel', { id: first.id }, { timeoutMs: 1000 });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await waiting).timedOut, false);
  const events = await rpc.call('events', { id: first.id, after: 0 });
  assert.ok(events.cursor > 0);
  assert.ok(events.events.length > 0);
});

test('shutdown saves active work as uncertain and restart reconciles its exact turn without replay', async (t) => {
  const { rpc, workspace, service, stateDir, config, codex } = await setup(t);
  const submitted = await rpc.call('submit', { workspace, task: 'A persistent task', idempotencyKey: 'durable' });
  await until(() => service.engine.get(submitted.id).turnId);
  const running = service.engine.get(submitted.id);
  await service.close();
  const persisted = new Store(stateDir);
  assert.equal(persisted.get(submitted.id).status, 'uncertain');
  assert.equal(persisted.get(submitted.id).turnId, running.turnId);
  persisted.close();
  const turn = codex.threads.get(running.threadId).turns.find((turn) => turn.id === running.turnId);
  turn.status = 'completed';
  turn.items = [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ status: 'completed', text: 'Verified output.', artifacts: [], data: null }) }];
  const replacementClient = new FakeCodex(codex.threads);
  const replacement = await startServer({ config, stateDir, client: replacementClient });
  try {
    assert.equal(replacement.engine.get(submitted.id).status, 'completed');
    assert.equal(replacement.engine.get(submitted.id).turnId, running.turnId);
    assert.equal(replacementClient.calls.filter((call) => call.method === 'turn/start').length, 0);
  } finally { await replacement.close(); }
});

test('startup failure releases singleton lock and does not publish a connection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new FakeCodex();
  client.start = async () => { throw new Error('Expected startup failure'); };
  await assert.rejects(startServer({ config: { port: 0, allowedRoots: [root], maxConcurrent: 1 }, stateDir: root, client }), /Expected startup failure/);
  assert.equal(fs.existsSync(path.join(root, 'daemon.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'connection.json')), false);
});

test('graceful shutdown drains outstanding long polls before closing SQLite', async (t) => {
  const { rpc, workspace, service } = await setup(t);
  const submitted = await rpc.call('submit', { workspace, task: 'Long-running task', idempotencyKey: 'long-poll' });
  await until(() => service.engine.get(submitted.id).status === 'running');
  const cursor = service.engine.get(submitted.id).cursor;
  const waiting = rpc.call('wait', { id: submitted.id, after: cursor, timeoutSeconds: 50 }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = Date.now();
  await service.close();
  await waiting;
  assert.ok(Date.now() - before < 1500, 'shutdown should not wait for the full 50-second poll');
});

test('confirmed-dead daemon lock is reclaimed; malformed ownership is never guessed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-stale-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, 'daemon.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, instanceId: 'dead-test-owner' }));
  const config = { port: 0, allowedRoots: [root], maxConcurrent: 1 };
  const service = await startServer({ config, stateDir: root, client: new FakeCodex() });
  await service.close();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), '{');
  await assert.rejects(startServer({ config, stateDir: root, client: new FakeCodex() }), { code: 'DAEMON_LOCKED' });
  assert.equal(fs.existsSync(lockDir), true);
});

test('collect_images validates IDs and serializes local collection without scheduling execution', async (t) => {
  const { service, rpc, workspace, headers } = await setup(t, { tickIntervalMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const steps = [];
  let releaseCollection;
  const collecting = new Promise((resolve) => { releaseCollection = resolve; });
  const partial = { id: 'partial-images', status: 'failed', review: 'pending', workspace, images: [{ path: path.join(workspace, 'original.png'), bytes: 68 }] };
  service.engine.collectImages = async (params) => {
    assert.deepEqual(params, { id: partial.id });
    steps.push('collect-start');
    await collecting;
    steps.push('collect-end');
    return partial;
  };
  service.engine.bindWorkspace = async () => { steps.push('next-mutation'); return { workspace }; };
  service.engine.tick = async () => { steps.push('tick'); };
  for (const params of [{}, { id: '' }, { id: '  ' }, { id: 123 }, { id: 'x'.repeat(257) }]) {
    await assert.rejects(rpc.call('collect_images', params), { code: 'INVALID_INPUT' });
  }
  const unauthenticated = await fetch(`${service.url}/rpc`, {
    method: 'POST', headers: { 'content-type': headers['content-type'] },
    body: JSON.stringify({ method: 'collect_images', params: { id: partial.id } }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(steps, []);
  const collection = rpc.call('collect_images', { id: partial.id });
  await until(() => steps.includes('collect-start'));
  const following = rpc.call('bind_workspace', { workspace });
  assert.equal((await rpc.call('health')).ok, true, 'read-only queries remain available while collection writes');
  assert.deepEqual(steps, ['collect-start'], 'other mutations cannot overtake collection');
  releaseCollection();
  assert.deepEqual(await collection, partial);
  await following;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['collect-start', 'collect-end', 'next-mutation', 'tick']);
  assert.deepEqual(await rpc.call('collect_images', { id: partial.id }), partial);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['collect-start', 'collect-end', 'next-mutation', 'tick', 'collect-start', 'collect-end']);
});

test('HTTP image collection preserves cancelled task state and copies only its exact turn originals', async (t) => {
  const { rpc, workspace, service, codex } = await setup(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const savedPath = path.join(workspace, 'generated-original.png');
  fs.writeFileSync(savedPath, png);
  const submitted = await rpc.call('submit', {
    workspace, task: 'Produce an image deliverable', output: 'artifacts', idempotencyKey: 'partial-image-delivery',
  });
  await until(() => service.engine.get(submitted.id).status === 'running');
  const cancelled = await rpc.call('cancel', { id: submitted.id });
  assert.equal(cancelled.status, 'cancelled');
  const lifecycle = ({ status, review, holdsCapacity, attempt, threadId, turnId }) => ({ status, review, holdsCapacity, attempt, threadId, turnId });
  const expectedLifecycle = lifecycle(cancelled);
  const thread = codex.threads.get(cancelled.threadId);
  const turn = thread.turns.find((turn) => turn.id === cancelled.turnId);
  const imageItem = {
    type: 'imageGeneration', id: 'image-one', status: 'completed', savedPath,
    result: 'PRIVATE_BASE64_SENTINEL', failure: null,
  };
  // The persisted image arrives after cancellation, without an item notification.
  // Collection must inspect the original turn rather than the newest thread turn.
  turn.items.push(imageItem);
  thread.turns.push({
    id: 'unrelated-later-turn', status: 'completed',
    items: [{ ...imageItem, id: 'image-from-another-turn' }],
  });
  const callsBeforeCollection = codex.calls.length;
  const collected = await rpc.call('collect_images', { id: submitted.id });
  assert.deepEqual(lifecycle(collected), expectedLifecycle);
  assert.equal(collected.images.length, 1);
  const image = collected.images[0];
  assert.equal(image.savedPath, savedPath);
  assert.equal(image.delivery.status, 'copied');
  const artifactRoot = path.join(workspace, '.doubao-codex', 'artifacts', submitted.id, 'attempt-1');
  assert.equal(path.dirname(image.artifact.path), artifactRoot);
  assert.notEqual(image.artifact.path, savedPath);
  assert.deepEqual(fs.readFileSync(image.artifact.path), png);
  assert.equal(image.artifact.bytes, png.length);
  const repeated = await rpc.call('collect_images', { id: submitted.id });
  assert.deepEqual(lifecycle(repeated), expectedLifecycle);
  assert.equal(repeated.images.length, 1);
  assert.deepEqual(repeated.images, collected.images);
  assert.equal(repeated.cursor, collected.cursor, 'idempotent collection must not create duplicate image events');
  const current = await rpc.call('get', { id: submitted.id });
  const events = await rpc.call('events', { id: submitted.id, after: 0 });
  assert.deepEqual(lifecycle(current), expectedLifecycle);
  assert.ok(!JSON.stringify({ collected, repeated, current, events }).includes('PRIVATE_BASE64_SENTINEL'));
  assert.deepEqual(codex.calls.slice(callsBeforeCollection), [
    { method: 'thread/read', params: { threadId: cancelled.threadId, includeTurns: true } },
    { method: 'thread/read', params: { threadId: cancelled.threadId, includeTurns: true } },
  ], 'collecting originals must not submit, resume, or interrupt a turn');
});
