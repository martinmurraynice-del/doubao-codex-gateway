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
  constructor(threads = new Map()) { super(); this.ready = false; this.threads = threads; this.calls = []; }
  async start() { this.ready = true; }
  async stop() { this.ready = false; this.emit('disconnect', { expected: true }); }
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
  service = await startServer({ config, stateDir, client: codex, tickIntervalMs: 20 });
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

test('HTTP health is minimal, RPC requires authentication, and credentials stay private', async (t) => {
  const { service, stateDir, token, headers, rpc } = await setup(t);
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
