import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GatewayClient, GatewayError } from '../src/client.mjs';

async function fixture(t, handler) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'doubao-mcp-test-'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const token = 'private-test-token';
  const connection = { url: `http://127.0.0.1:${server.address().port}`, tokenFile: 'token', pid: process.pid };
  await writeFile(path.join(stateDir, 'token'), token, { mode: 0o600 });
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify(connection));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  return { client: new GatewayClient({ stateDir }), stateDir, token, connection };
}

test('client authenticates local RPC and preserves task/result parameters', async (t) => {
  let observed;
  const { client, token } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { id: 'task-one', status: 'queued' } }));
  });
  assert.deepEqual(await client.call('submit', { workspace: '/tmp/example', task: 'A', idempotencyKey: 'one' }), {
    id: 'task-one', status: 'queued',
  });
  assert.deepEqual(observed, {
    method: 'POST', url: '/rpc', authorization: `Bearer ${token}`,
    body: { method: 'submit', params: { workspace: '/tmp/example', task: 'A', idempotencyKey: 'one' } },
  });
});

test('client refuses remote endpoints before sending credentials', async (t) => {
  let requests = 0;
  const { client, stateDir, connection } = await fixture(t, (_req, res) => { requests++; res.end('{}'); });
  for (const url of ['https://example.org', 'http://example.org', 'http://127.0.0.1.evil.test', 'http://user@127.0.0.1', 'http://127.0.0.1/path']) {
    await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ ...connection, url }));
    await assert.rejects(client.call('health'), (error) => error.code === 'INVALID_CONNECTION');
  }
  assert.equal(requests, 0);
});

test('client does not follow redirects or retry a submitted task', async (t) => {
  const paths = [];
  const { client } = await fixture(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(307, { location: '/elsewhere' });
    res.end();
  });
  await assert.rejects(client.call('submit', { task: 'A' }), (error) => {
    assert.equal(error.code, 'GATEWAY_UNAVAILABLE');
    assert.equal(error.outcomeUnknown, true);
    assert.ok(!error.message.includes('private-test-token'));
    return true;
  });
  assert.deepEqual(paths, ['/rpc']);
});

test('client reports an uncertain outcome after timeout, with exactly one request', async (t) => {
  let requests = 0;
  const { client } = await fixture(t, () => { requests++; });
  await assert.rejects(client.call('submit', { task: 'A' }, { timeoutMs: 80 }), (error) => {
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  assert.equal(requests, 1);
});

test('client propagates application errors and rejects invalid response envelopes', async (t) => {
  let response = { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Key already belongs to another action.' } };
  const { client } = await fixture(t, (_req, res) => res.end(JSON.stringify(response)));
  await assert.rejects(client.call('submit', {}), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
  response = { unexpected: true };
  await assert.rejects(client.call('get', { id: 'one' }), (error) => error.code === 'INVALID_RESPONSE');
});

test('MCP exposes all gateway tools, validates inputs and relays structured results/errors', async (t) => {
  const [{ createMcpServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../src/mcp.mjs'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const calls = [];
  const server = createMcpServer({ client: { async call(method, params) {
    calls.push({ method, params });
    if (method === 'get') throw new GatewayError('Task not found.', { code: 'NOT_FOUND' });
    return { id: 'task-mcp', status: 'queued' };
  } } });
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.equal(tools.find((tool) => tool.name === 'codex_wait').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'codex_submit').annotations.idempotentHint, true);
  const arguments_ = { workspace: '/tmp/example', task: 'Build A', idempotencyKey: 'mcp-one' };
  const submitted = await client.callTool({ name: 'codex_submit', arguments: arguments_ });
  assert.deepEqual(submitted.structuredContent, { result: { id: 'task-mcp', status: 'queued' } });
  assert.deepEqual(calls, [{ method: 'submit', params: arguments_ }]);
  const invalid = await client.callTool({ name: 'codex_submit', arguments: { workspace: '/tmp/example', task: 'Build A' } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 1);
  const notFound = await client.callTool({ name: 'codex_get', arguments: { id: 'missing' } });
  assert.equal(notFound.isError, true);
  assert.equal(notFound.structuredContent.error.code, 'NOT_FOUND');
});

test('MCP image collection validates task IDs and forwards partial image results unchanged', async (t) => {
  const [{ createMcpServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../src/mcp.mjs'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const calls = [];
  const task = {
    id: 'task-images', status: 'cancelled', review: 'pending', threadId: 'thread-original', turnId: 'turn-original',
    images: [{ path: '/tmp/project/images/original.png', name: 'original.png', bytes: 68 }],
    error: { code: 'INTERRUPTED', message: 'Task was interrupted after producing an image.' },
  };
  const server = createMcpServer({ client: { async call(method, params) {
    calls.push({ method, params });
    return task;
  } } });
  const client = new Client({ name: 'image-collection-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const collect = tools.find((tool) => tool.name === 'codex_collect_images');
  assert.equal(collect.annotations.readOnlyHint, false);
  assert.equal(collect.annotations.idempotentHint, true);
  assert.equal(collect.annotations.destructiveHint, false);
  for (const args of [{}, { id: '' }, { id: '  ' }, { id: 123 }, { id: 'x'.repeat(257) }]) {
    const invalid = await client.callTool({ name: 'codex_collect_images', arguments: args });
    assert.equal(invalid.isError, true);
  }
  assert.equal(calls.length, 0);
  const result = await client.callTool({ name: 'codex_collect_images', arguments: { id: task.id } });
  assert.deepEqual(calls, [{ method: 'collect_images', params: { id: task.id } }]);
  assert.deepEqual(result.structuredContent, { result: task });
  assert.deepEqual(JSON.parse(result.content[0].text), { result: task });
  assert.equal(result.structuredContent.result.status, 'cancelled');
  assert.equal(result.structuredContent.result.review, 'pending');
});
