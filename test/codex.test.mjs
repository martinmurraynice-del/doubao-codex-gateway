import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexClient } from '../src/codex.mjs';

// This subprocess exercises the real stdio transport, not a mocked request().
const fixture = `#!/usr/bin/env node
import readline from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let initialized = false;
let initializeCount = 0;
const approvals = new Map();
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initializeCount++;
    const notice = JSON.stringify({method:'boot',params:{early:true}}) + '\\n';
    process.stdout.write(notice.slice(0,8));
    setTimeout(() => {
      process.stdout.write(notice.slice(8));
      send({id:message.id,result:{initializeCount}});
    },5);
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
  const client = new CodexClient({ bin, ...options });
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
  await assert.rejects(client.request('bad'), { code: 'CODEX_DISCONNECTED' });
  assert.equal((await failure)[0].code, 'PROTOCOL_ERROR');
  assert.equal(JSON.stringify(logs).includes('private-token'), false);
});
