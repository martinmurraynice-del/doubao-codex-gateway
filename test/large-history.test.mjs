import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexClient } from '../src/codex.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const THREAD = 'large-history-thread';
const HISTORY_TEXT = 'Original context: preserve the project, 图片路径, and every earlier turn.';
const IMAGE_RESULT_BYTES = 17 * 1024 * 1024;

// An actual child process exercises the production STDIO parser. It never
// invokes the installed Codex executable, a model, or any network service.
const fixture = String.raw`#!/usr/bin/env node
import readline from 'node:readline';
import { once } from 'node:events';
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const workspace = argument('--fixture-workspace');
const savedPath = argument('--fixture-image');
const threadId = 'large-history-thread';
const contextMarker = 'original-context-never-rewritten';
const historyText = 'Original context: preserve the project, 图片路径, and every earlier turn.';
const imageResult = 'PRIVATE_IMAGE_BYTES_'.padEnd(17 * 1024 * 1024, 'A');
const image = id => ({ type: 'imageGeneration', id, status: 'completed', savedPath, result: imageResult, failure: null });
const report = (id, text) => ({ type: 'agentMessage', id: 'message-' + id, phase: 'final_answer', text: JSON.stringify({ status: 'completed', text, artifacts: [], data: null }) });
const thread = { id: threadId, cwd: workspace, contextMarker, turns: [
  { id: 'old-a', status: 'completed', items: [image('old-image-a'), { type: 'agentMessage', id: 'old-text', text: historyText, phase: 'commentary' }], error: null },
  { id: 'old-b', status: process.argv.includes('--external-active') ? 'inProgress' : 'completed', items: [image('old-image-b')], error: null },
] };
let sequence = 0;
let loseNextStart = false;
const calls = [];
async function send(value) {
  const line = JSON.stringify(value) + '\n';
  // Do not depend on pipe chunk boundaries, and respect backpressure when
  // emitting a response that is larger than the old 32 MiB transport limit.
  for (let offset = 0; offset < line.length; offset += 65521) {
    if (!process.stdout.write(line.slice(offset, offset + 65521))) await once(process.stdout, 'drain');
  }
}
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method !== 'fixture/inspect') calls.push({ method, params });
  if (method === 'initialize') return send({ id, result: {} });
  if (method === 'initialized') return;
  if (method === 'thread/read' || method === 'thread/resume') {
    if (params.threadId !== threadId) return send({ id, error: { code: -32600, message: 'Wrong fixture thread' } });
    return send({ id, result: { thread, model: 'fixture-model' } });
  }
  if (method === 'turn/start') {
    const turn = { id: 'owned-' + (++sequence), status: 'inProgress', items: [], error: null };
    thread.turns.push(turn);
    if (loseNextStart) {
      loseNextStart = false;
      return send({ id, error: { code: -32001, message: 'Fixture lost the start result after accepting the turn' } });
    }
    // A late historical completion arrives before the new start reply. All
    // old IDs must survive history parsing so it cannot claim the new run.
    await send({ method: 'turn/completed', params: { threadId, turn: { id: 'old-a', status: 'completed', items: [report('old-a', 'WRONG_OLD_RESULT')], error: null } } });
    return send({ id, result: { turn } });
  }
  if (method === 'fixture/finish') {
    const turn = thread.turns.find(value => value.id === params.turnId);
    if (!turn) throw new Error('Unknown fixture turn');
    turn.status = params.status || 'completed';
    turn.items = [...(params.image ? [image(turn.id + '-image')] : []), report(turn.id, params.text || 'Lightweight task finished.')];
    if (params.notify) await send({ method: 'turn/completed', params: { threadId, turn } });
    return send({ id, result: {} });
  }
  if (method === 'fixture/lose-next-start') { loseNextStart = true; return send({ id, result: {} }); }
  if (method === 'fixture/inspect') return send({ id, result: { calls, contextMarker, turnIds: thread.turns.map(turn => turn.id), rawImageBytes: 2 * imageResult.length } });
  return send({ id, error: { code: -32601, message: 'Unexpected fixture RPC: ' + method } });
}
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => {
  queue = queue.then(() => handle(JSON.parse(line))).catch(() => process.exit(2));
});
`;

async function setup(t, { externalActive = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-large-history-')));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const savedPath = path.join(workspace, 'original.png');
  fs.writeFileSync(savedPath, PNG);
  const bin = path.join(root, 'fixture.mjs');
  fs.writeFileSync(bin, fixture, { mode: 0o700 });
  const client = new CodexClient({ bin, args: ['--fixture-workspace', workspace, '--fixture-image', savedPath, ...(externalActive ? ['--external-active'] : [])] });
  const store = new Store(path.join(root, 'state'));
  const config = { allowedRoots: [workspace], maxConcurrent: 1, model: null };
  store.bind({ workspace, threadId: THREAD, status: 'ready', model: 'fixture-model', updatedAt: new Date().toISOString() });
  const engine = new Engine({ store, client, config, imageCacheRoot: path.join(root, 'generated-images') });
  t.after(async () => {
    engine.closing = true;
    try { await client.stop(); } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await client.start();
  return { engine, store, client, workspace, savedPath };
}

const input = (workspace, key) => ({ workspace, task: 'Perform this lightweight fixture task without changing its original thread context.', idempotencyKey: key, output: 'text', timeoutSeconds: 300 });
const count = (inspection, method) => inspection.calls.filter(call => call.method === method).length;
function assertContextUnchanged(inspection) {
  assert.equal(inspection.contextMarker, 'original-context-never-rewritten');
  assert.equal(count(inspection, 'thread/start'), 0);
  for (const call of inspection.calls.filter(call => ['thread/read', 'thread/resume', 'turn/start'].includes(call.method))) {
    assert.equal(call.params.threadId, THREAD);
    assert.equal(Object.hasOwn(call.params, 'history'), false, 'never replace server-owned model history');
    assert.equal(Object.hasOwn(call.params, 'thread'), false, 'never inject a pruned thread as model context');
    if (call.method === 'thread/resume') {
      assert.equal(call.params.approvalPolicy, 'never');
      assert.equal(call.params.sandbox, 'workspace-write');
    }
  }
}

test('large multi-image history survives real STDIO and two tasks retain the same context and all prior IDs', { timeout: 120_000 }, async t => {
  const { engine, client, workspace, savedPath } = await setup(t);
  const initial = await client.request('thread/read', { threadId: THREAD, includeTurns: true });
  assert.deepEqual(initial.thread.turns.map(turn => turn.id), ['old-a', 'old-b']);
  assert.equal(initial.thread.contextMarker, 'original-context-never-rewritten');
  assert.equal(initial.thread.turns[0].items[1].text, HISTORY_TEXT);
  for (const turn of initial.thread.turns) {
    const item = turn.items[0];
    assert.equal(item.type, 'imageGeneration');
    assert.equal(item.status, 'completed');
    assert.equal(item.savedPath, savedPath);
    assert.ok(item.result === undefined || item.result === null || item.result === '', 'inline image bytes must not survive transport stripping');
  }
  const first = await engine.submit(input(workspace, 'large-first'));
  await engine.tick();
  const running = engine.get(first.id);
  assert.equal(running.status, 'running');
  assert.equal(running.turnId, 'owned-1');
  assert.deepEqual(running.priorTurnIds, ['old-a', 'old-b']);
  assert.equal(running.result, null, 'old completion cannot claim the new task');
  await client.request('fixture/finish', { turnId: running.turnId, text: 'First exact result.', notify: true });
  assert.equal(engine.get(first.id).result.text, 'First exact result.');
  const second = await engine.submit(input(workspace, 'large-second'));
  await engine.tick();
  const next = engine.get(second.id);
  assert.equal(next.status, 'running');
  assert.equal(next.threadId, running.threadId);
  assert.equal(next.turnId, 'owned-2');
  assert.deepEqual(next.priorTurnIds, ['old-a', 'old-b', 'owned-1']);
  await client.request('fixture/finish', { turnId: next.turnId, text: 'Second exact result.', notify: true });
  assert.equal(engine.get(second.id).result.text, 'Second exact result.');
  const inspection = await client.request('fixture/inspect');
  assert.equal(inspection.rawImageBytes, 2 * IMAGE_RESULT_BYTES);
  assert.ok(inspection.rawImageBytes > 32 * 1024 * 1024);
  assert.equal(count(inspection, 'turn/start'), 2);
  assertContextUnchanged(inspection);
});

test('an external active turn after large image history blocks dispatch and is never claimed or interrupted', { timeout: 120_000 }, async t => {
  const { engine, client, workspace } = await setup(t, { externalActive: true });
  const submitted = await engine.submit(input(workspace, 'external-active'));
  await engine.tick();
  const blocked = engine.get(submitted.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error.code, 'THREAD_BUSY');
  assert.equal(blocked.blockingTurnId, 'old-b');
  assert.equal(blocked.turnId, null);
  assert.equal(blocked.holdsCapacity, true);
  await engine.cancel(submitted.id);
  await client.request('fixture/finish', { turnId: 'old-b', notify: false });
  const recovered = await engine.recover({ id: submitted.id, note: 'Verify only that the exact external turn has ended.' });
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.holdsCapacity, false);
  assert.equal(recovered.result, null);
  const inspection = await client.request('fixture/inspect');
  assert.equal(count(inspection, 'turn/start'), 0);
  assert.equal(count(inspection, 'turn/interrupt'), 0);
  assert.equal(count(inspection, 'thread/resume'), 1, 'external recovery only reads its exact turn');
  assertContextUnchanged(inspection);
});

test('large-history recovery and image collection use only the exact owned turn without replaying work', { timeout: 120_000 }, async t => {
  const { engine, store, client, workspace, savedPath } = await setup(t);
  const submitted = await engine.submit(input(workspace, 'recover-owned'));
  await engine.tick();
  const running = engine.get(submitted.id);
  await client.request('fixture/finish', { turnId: running.turnId, image: true, text: 'Recovered exact owned result.', notify: false });
  store.save({ ...store.get(submitted.id), status: 'uncertain', error: { code: 'SIMULATED_RECONNECT', message: 'The final notification was not observed.' } });
  const recovered = await engine.recover({ id: submitted.id, note: 'Read the saved exact turn; do not repeat the work.' });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.review, 'pending');
  assert.equal(recovered.turnId, running.turnId);
  assert.equal(recovered.result.text, 'Recovered exact owned result.');
  assert.equal(recovered.images.length, 1, 'images from the old turns must not be collected into this task');
  const image = recovered.images[0];
  assert.equal(image.itemId, `${running.turnId}-image`);
  assert.equal(image.turnId, running.turnId);
  assert.equal(image.savedPath, savedPath);
  assert.equal(image.delivery.status, 'copied');
  assert.ok(image.artifact.path.startsWith(path.join(workspace, '.doubao-codex', 'artifacts', submitted.id, 'attempt-1') + path.sep));
  assert.deepEqual(fs.readFileSync(image.artifact.path), PNG);
  const collected = await engine.collectImages({ id: submitted.id });
  const repeated = await engine.collectImages({ id: submitted.id });
  assert.deepEqual(repeated, collected, 'repeated collection is a metadata and event no-op');
  for (const field of ['status', 'review', 'holdsCapacity', 'attempt', 'turnId', 'cursor']) assert.deepEqual(collected[field], recovered[field]);
  assert.ok(!JSON.stringify({ run: repeated, events: store.events(submitted.id) }).includes('PRIVATE_IMAGE_BYTES_'));
  const inspection = await client.request('fixture/inspect');
  assert.equal(count(inspection, 'turn/start'), 1);
  assert.equal(count(inspection, 'thread/resume'), 1, 'completed recovery and collection must not resume');
  assert.equal(count(inspection, 'turn/interrupt'), 0);
  assertContextUnchanged(inspection);
});

test('unknown start outcome remains reserved across large-history recovery and an idempotent retry', { timeout: 120_000 }, async t => {
  const { engine, client, workspace } = await setup(t);
  await client.request('fixture/lose-next-start');
  const request = input(workspace, 'unknown-start');
  const submitted = await engine.submit(request);
  await engine.tick();
  const unknown = engine.get(submitted.id);
  assert.equal(unknown.status, 'uncertain');
  assert.equal(unknown.turnId, null);
  assert.equal(unknown.holdsCapacity, true);
  const recovered = await engine.recover({ id: submitted.id, note: 'Inspect without guessing which turn owns the lost reply.' });
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.turnId, null);
  assert.equal(recovered.holdsCapacity, true);
  assert.equal((await engine.submit(request)).id, submitted.id);
  await engine.tick();
  const inspection = await client.request('fixture/inspect');
  assert.equal(count(inspection, 'turn/start'), 1, 'unknown work is never automatically replayed');
  assert.equal(count(inspection, 'turn/interrupt'), 0);
  assertContextUnchanged(inspection);
});
