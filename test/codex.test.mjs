import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexClient } from '../src/codex.mjs';
import { TransportSupervisor } from '../src/reconnect.mjs';

// This subprocess exercises the real stdio transport, not a mocked request().
const fixture = `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const markerIndex = process.argv.indexOf('--fail-first-marker');
const failureMarker = markerIndex < 0 ? null : process.argv[markerIndex + 1];
const failInitialization = failureMarker && !fs.existsSync(failureMarker);
if (failInitialization) {
  fs.writeFileSync(failureMarker,'failed-once');
  process.on('SIGTERM', () => setTimeout(() => process.exit(7), 70));
}
const initializeDelay = process.argv.includes('--slow-initialize') ? 150 : 5;
if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {});
let initialized = false;
let initializeCount = 0;
const approvals = new Map();
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initializeCount++;
    const notice = JSON.stringify({method:'boot',params:{early:true}}) + '\\n';
    process.stdout.write(notice.slice(0,8));
    if (process.argv.includes('--partial-initialize')) return;
    setTimeout(() => {
      process.stdout.write(notice.slice(8));
      if (failInitialization) send({id:message.id,error:{code:-32000,message:'Expected fixture initialization failure'}});
      else send({id:message.id,result:{initializeCount}});
    },initializeDelay);
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'ping') {
    send({id:message.id,result:{...message.params,initialized}});
  } else if (message.method === 'late') {
    setTimeout(() => send({id:message.id,result:true}),80);
  } else if (message.method === 'approval') {
    const id = 'approval-' + message.id;
    approvals.set(id,message.id);
    send({id,method:message.params.method,params:{threadId:'test-thread'}});
  } else if (message.method === 'die') {
    process.exit(9);
  } else if (message.method === 'bad') {
    process.stdout.write('NOT-JSON\\n');
  } else if (message.method === 'truncated') {
    process.stdout.end('{"id":');
  } else if (message.method === 'large') {
    send({id:message.id,result:{text:'PRIVATE_PROTOCOL_PAYLOAD'.repeat(message.params.repeat)}});
  } else if (message.method === 'stderr') {
    process.stderr.write('private-token-do-not-log');
    send({id:message.id,result:true});
  } else if (!message.method && approvals.has(message.id)) {
    send({id:approvals.get(message.id),result:message});
    approvals.delete(message.id);
  }
});
`;

async function clientFor(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-codex-transport-'));
  const bin = join(directory, 'fixture.mjs');
  await writeFile(bin, fixture, { mode: 0o700 });
  const { failFirst = false, slowInitialize = false, ...clientOptions } = options;
  const args = [...(clientOptions.args || [])];
  if (failFirst) args.push('--fail-first-marker', join(directory, 'failed-once'));
  if (slowInitialize) args.push('--slow-initialize');
  const client = new CodexClient({ bin, ...clientOptions, args });
  t.after(async () => {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return client;
}

test('deduplicates initialization and delivers fragmented early notifications', async (t) => {
  const client = await clientFor(t);
  const notices = [];
  client.on('notification', (notice) => notices.push(notice));
  const results = await Promise.all([client.start(), client.start(), client.request('ping', { n: 3 })]);
  assert.equal(results[0].initializeCount, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[2], { n: 3, initialized: true });
  assert.deepEqual(notices, [{ method: 'boot', params: { early: true } }]);
});

test('timeout retains uncertainty without retrying or poisoning following responses', async (t) => {
  const client = await clientFor(t);
  await assert.rejects(client.request('late', {}, { timeoutMs: 10 }), (error) => {
    assert.equal(error.code, 'RPC_TIMEOUT');
    assert.equal(error.sent, true);
    return true;
  });
  assert.deepEqual(await client.request('ping', { check: 1 }), { check: 1, initialized: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await client.request('ping', { check: 2 }), { check: 2, initialized: true });
  assert.equal(client.pending.size, 0);
});

test('declines approvals by default and permits explicit server request handlers', async (t) => {
  const client = await clientFor(t);
  const declined = await client.request('approval', { method: 'item/commandExecution/requestApproval' });
  assert.equal(declined.result.decision, 'decline');
  const unknown = await client.request('approval', { method: 'unsupported/request' });
  assert.equal(unknown.error.code, -32601);
  client.on('serverRequest', ({ id }) => client.respond(id, { decision: 'cancel' }));
  const handled = await client.request('approval', { method: 'item/fileChange/requestApproval' });
  assert.equal(handled.result.decision, 'cancel');
  assert.equal(client.serverRequests.size, 0);
});

test('process exit rejects every outstanding request and supports later reconnection', async (t) => {
  const client = await clientFor(t);
  await client.start();
  const disconnected = once(client, 'disconnect');
  const pending = client.request('hang');
  const dying = client.request('die');
  const results = await Promise.allSettled([pending, dying]);
  assert.equal((await disconnected)[0].code, 9);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'CODEX_DISCONNECTED');
    assert.equal(result.reason.sent, true);
  }
  assert.equal(client.pending.size, 0);
  assert.equal((await client.request('ping')).initialized, true);
});

test('malformed protocol data fails closed and stderr content never reaches logger', async (t) => {
  const logs = [];
  const client = await clientFor(t, { logger: (...entry) => logs.push(entry) });
  await client.request('stderr');
  const failure = once(client, 'protocolError');
  await assert.rejects(client.request('bad'), { code: 'PROTOCOL_ERROR' });
  assert.equal((await failure)[0].code, 'PROTOCOL_ERROR');
  assert.equal(JSON.stringify(logs).includes('private-token'), false);
});

test('oversized nonmedia frames reject pending calls with observable cause and retain sent uncertainty', async t => {
  const logs = [];
  const client = await clientFor(t, { protocolLimits: { retainedBytes: 512 }, logger: (...entry) => logs.push(entry) });
  await client.start();
  const results = await Promise.allSettled([client.request('hang'), client.request('large', { repeat: 100 })]);
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'CODEX_MESSAGE_TOO_LARGE'); assert.equal(result.reason.sent, true);
  }
  assert.equal(client.ready, false); assert.equal(client.pending.size, 0);
  const failure = structuredClone(client.lastProtocolError);
  assert.equal(failure.code, 'CODEX_MESSAGE_TOO_LARGE'); assert.ok(!Number.isNaN(Date.parse(failure.at)));
  assert.ok(!JSON.stringify({ logs, failure }).includes('PRIVATE_PROTOCOL_PAYLOAD'));
  assert.equal((await client.request('ping')).initialized, true);
  assert.deepEqual(client.lastProtocolError, failure, 'reconnection must not erase the diagnostic cause');
});

test('unexpected EOF with a partial frame is a protocol error', async t => {
  const client = await clientFor(t);
  await assert.rejects(client.request('truncated'), { code: 'PROTOCOL_ERROR', sent: true });
  assert.equal(client.lastProtocolError.code, 'PROTOCOL_ERROR');
  assert.equal(client.ready, false);
});

test('intentional shutdown with a partial initialization frame is not a protocol error', async t => {
  const client = await clientFor(t, { args: ['--partial-initialize'] });
  const starting = client.start().catch(error => error);
  await once(client.child.stdout, 'data');
  await client.stop();
  assert.equal((await starting).code, 'CODEX_DISCONNECTED');
  assert.equal(client.lastProtocolError, null);
});

test('protocol failure forcibly reaps a SIGTERM-ignoring child before any replacement initializes', async t => {
  const client = await clientFor(t, { args: ['--ignore-term'] });
  await client.start(); const retired = client.child;
  await assert.rejects(client.request('bad'), { code: 'PROTOCOL_ERROR' });
  const restart = client.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.child, null, 'a replacement must wait while the protocol-invalid child is alive');
  assert.equal(retired.exitCode, null); assert.equal(retired.signalCode, null);
  await restart;
  assert.equal(retired.signalCode, 'SIGKILL');
  assert.notEqual(client.child, retired); assert.equal(client.ready, true);
});

test('shutdown cancels a restart that was waiting for protocol-invalid child retirement', async t => {
  const client = await clientFor(t, { args: ['--ignore-term'] });
  await client.start(); const retired = client.child;
  await assert.rejects(client.request('bad'), { code: 'PROTOCOL_ERROR' });
  const restart = client.start().catch(error => error);
  await client.stop();
  assert.equal((await restart).code, 'CODEX_STOPPING');
  assert.equal(retired.signalCode, 'SIGKILL'); assert.equal(client.child, null); assert.equal(client.ready, false);
});

test('failed initialization drains its child before retry and cannot emit a late stale disconnect', async t => {
  const client = await clientFor(t, { failFirst: true });
  const notices = []; const disconnects = [];
  client.on('notification', message => notices.push(message));
  client.on('disconnect', reason => disconnects.push(reason));
  const first = client.start(); const retired = client.child;
  const results = await Promise.allSettled([first, client.start(), client.request('ping')]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === -32000));
  assert.ok(retired.exitCode !== null || retired.signalCode !== null, 'start rejection must wait until child termination');
  assert.equal(client.child, null);
  assert.equal(disconnects.length, 1);
  assert.equal(notices.length, 1, 'concurrent callers must share the failed initialization');
  const restarted = await Promise.all([client.start(), client.request('ping', { afterFailure: true }), client.start()]);
  assert.equal(restarted[1].afterFailure, true);
  assert.equal(restarted[1].initialized, true);
  assert.equal(notices.length, 2, 'only one replacement process may initialize');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(disconnects.length, 1, 'a retired child must not disconnect its replacement');
  assert.equal(client.ready, true);
});

test('supervisor and concurrent business RPCs share one real subprocess initialization', async t => {
  const client = await clientFor(t, { slowInitialize: true });
  const notices = [];
  client.on('notification', message => notices.push(message));
  let retry;
  const supervisor = new TransportSupervisor({ client, initialDelayMs: 1, maxDelayMs: 10,
    clock: { now: Date.now, setTimeout: callback => { retry = callback; return 1; }, clearTimeout: () => { retry = undefined; } } });
  t.after(() => supervisor.pause());
  await client.start(); supervisor.activate();
  await assert.rejects(client.request('die'), { code: 'CODEX_DISCONNECTED' });
  assert.equal(typeof retry, 'function');
  retry();
  await Promise.resolve(); // Enter the supervisor's start before business RPCs.
  const replacement = client.child;
  assert.ok(replacement);
  const results = await Promise.all([client.request('ping', { number: 1 }), client.start(), client.request('ping', { number: 2 })]);
  await supervisor.settled();
  assert.equal(client.child, replacement);
  assert.equal(notices.length, 2, 'one boot notice for the original and one for the shared replacement');
  assert.equal(results[0].initialized, true); assert.equal(results[2].initialized, true);
  assert.equal(client.pending.size, 0);
});

test('stop during initialization rejects new starts instead of resurrecting the child', async t => {
  const client = await clientFor(t, { slowInitialize: true });
  const starting = client.start(); const child = client.child;
  const result = starting.catch(error => error);
  const stopped = client.stop();
  await assert.rejects(client.start(), { code: 'CODEX_STOPPING' });
  await assert.rejects(client.request('ping'), { code: 'CODEX_STOPPING' });
  await stopped;
  assert.equal((await result).code, 'CODEX_DISCONNECTED');
  assert.equal(client.lastProtocolError, null);
  assert.equal(client.ready, false); assert.equal(client.child, null);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(client.starting, null); assert.equal(client.stopping, null);
  assert.equal((await client.request('ping', { explicitlyRestarted: true })).explicitlyRestarted, true);
});
