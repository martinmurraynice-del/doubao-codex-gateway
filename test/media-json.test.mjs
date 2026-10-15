import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaJsonDecoder } from '../src/media-json.mjs';

function decode(raw, { chunks = [1, 7, 31, 4096], limits } = {}) {
  const messages = []; const stats = [];
  const decoder = new MediaJsonDecoder({ limits, onMessage: (message, info) => { messages.push(message); stats.push(info); } });
  const bytes = Buffer.from(raw); let offset = 0; let i = 0;
  while (offset < bytes.length) { const end = Math.min(bytes.length, offset + chunks[i++ % chunks.length]); decoder.write(bytes.subarray(offset, end)); offset = end; }
  decoder.end(); return { messages, stats };
}

test('ordinary RPC, primitive result, nested data, escaped strings and UTF-8 survive arbitrary chunk boundaries', () => {
  const expected = [
    { id: 1, result: { data: ['中文😀', '\\ slash " quote \n newline', true, false, null, -1.25e3], result: 'A normal result must remain intact' } },
    { method: 'notice', params: { empty: {}, list: [], result: 42 } },
    { id: 2, result: 'string result' },
  ];
  assert.deepEqual(decode(`\n${expected.map(x => JSON.stringify(x)).join('\r\n')}\n`).messages, expected);
});

test('only imageGeneration string results are omitted, regardless of field order', () => {
  const image = { result: 'SECRET'.repeat(1000), savedPath: '/cache/original.png', failure: null, id: 'image-one', status: 'completed', type: 'imageGeneration' };
  const input = { id: 4, result: { thread: { id: 'thread-one', turns: [{ id: 'turn-one', status: 'completed', items: [image,
    { ...image, type: 'notAnImage', result: 'keep this result' },
    { type: 'imageGeneration', status: 'completed', result: 'ALSO_SECRET'.repeat(1000), savedPath: null, failure: { type: 'usageLimitExceeded' } },
    { type: 'agentMessage', text: '{"type":"imageGeneration","result":"literal text"}' },
  ] }] } } };
  const expected = structuredClone(input); delete expected.result.thread.turns[0].items[0].result; delete expected.result.thread.turns[0].items[2].result;
  const { messages, stats } = decode(JSON.stringify(input), { limits: { retainedBytes: 1024 } });
  assert.deepEqual(messages, [expected]); assert.equal(stats[0].omittedImageResults, 2); assert.ok(stats[0].retainedBytes < 1024);
  assert.ok(!JSON.stringify(messages).includes('SECRET'));
});

test('image frames far larger than retained limit use bounded deferred strings and retain complete history', () => {
  const image = { result: 'a'.repeat(17 * 1024 * 1024), id: 'large-image', type: 'imageGeneration', status: 'completed', savedPath: '/cache/image.png' };
  const envelope = { id: 1, result: { thread: { turns: [{ id: 'old', status: 'completed', items: [image] }, { id: 'new', status: 'inProgress', items: [image] }] } } };
  const { messages, stats } = decode(JSON.stringify(envelope) + '\n', { chunks: [65536], limits: { retainedBytes: 4096 } });
  assert.deepEqual(messages[0].result.thread.turns.map(turn => [turn.id, turn.status]), [['old', 'completed'], ['new', 'inProgress']]);
  assert.equal(stats[0].omittedImageResults, 2); assert.ok(stats[0].wireBytes > 32 * 1024 * 1024); assert.ok(stats[0].retainedBytes < 4096);
  assert.equal(Object.hasOwn(messages[0].result.thread.turns[0].items[0], 'result'), false);
});

test('retained budget can evict a deferred image result before a later type field', () => {
  const input = { params: { item: { result: 'a'.repeat(100), savedPath: 'p'.repeat(80), type: 'imageGeneration' } } };
  const decoded = decode(JSON.stringify(input), { chunks: [1], limits: { retainedBytes: 160 } });
  assert.deepEqual(decoded.messages[0], { params: { item: { savedPath: 'p'.repeat(80), type: 'imageGeneration' } } });
});

test('large ordinary result strings and text fail closed instead of silently truncating', () => {
  for (const message of [{ id: 1, result: 'x'.repeat(1024) }, { id: 1, result: { type: 'nonImage', result: 'x'.repeat(1024) } }, { id: 1, result: { text: 'x'.repeat(1024) } }]) {
    assert.throws(() => decode(JSON.stringify(message), { limits: { retainedBytes: 256 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
  }
  assert.deepEqual(decode(JSON.stringify({ id: 1, result: 'x'.repeat(1024) }), { limits: { retainedBytes: 2048 } }).messages, [{ id: 1, result: 'x'.repeat(1024) }]);
});

test('final duplicate type determines omission and cannot smuggle a truncated nonimage result', () => {
  assert.throws(() => decode(`{"params":{"item":{"type":"imageGeneration","result":"${'x'.repeat(1000)}","type":"normal"}}}`, { limits: { retainedBytes: 128 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
  assert.deepEqual(decode('{"params":{"item":{"type":"normal","result":"bytes","type":"imageGeneration"}}}').messages, [{ params: { item: { type: 'imageGeneration' } } }]);
});

test('omitted strings still require correct quotes, escapes and unicode syntax', () => {
  for (const suffix of ['\\q"}}', '\\uZZZZ"}}', '\\u123"}}', '\n"}}', '']) {
    assert.throws(() => decode(`{"params":{"item":{"type":"imageGeneration","result":"${'x'.repeat(500)}${suffix}`, { limits: { retainedBytes: 128 } }), { code: 'PROTOCOL_ERROR' });
  }
  assert.deepEqual(decode('{"params":{"item":{"type":"imageGeneration","result":"escaped \\" quote \\\\ slash \\u4e2d"}}}').messages, [{ params: { item: { type: 'imageGeneration' } } }]);
});

test('invalid JSON grammar and malformed UTF-8 never produce a usable frame', () => {
  for (const raw of ['{"x":1,}', '[1,]', '{"x" 1}', '{"x":}', '{"x":true false}', '{}{}', 'NaN', '{x:1}', '[,]', '{"x":"unterminated']) {
    assert.throws(() => decode(raw), { code: 'PROTOCOL_ERROR' }, raw);
  }
  const decoder = new MediaJsonDecoder({ onMessage: () => assert.fail('invalid frame cannot emit') });
  assert.throws(() => decoder.write(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), { code: 'PROTOCOL_ERROR' });
});

test('wire, nesting, and node limit checks reject excessive structures', () => {
  assert.throws(() => decode(JSON.stringify({ type: 'imageGeneration', result: 'x'.repeat(1000) }), { limits: { wireBytes: 128, retainedBytes: 64 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
  assert.throws(() => decode('[[[[[1]]]]]', { limits: { depth: 4 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
  assert.throws(() => decode('[1,2,3,4]', { limits: { values: 3 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
});

test('lookalike business objects and MCP structured content are not image protocol items', () => {
  const business = { type: 'imageGeneration', result: 'this is business data' };
  const envelope = { id: 1, result: { thread: { turns: [{ items: [{ type: 'mcpToolCall', result: { structuredContent: business } }] }] }, data: business } };
  assert.deepEqual(decode(JSON.stringify(envelope)).messages, [envelope]);
  assert.deepEqual(decode(JSON.stringify(business)).messages, [business]);
  assert.throws(() => decode(JSON.stringify({ ...business, result: 'x'.repeat(1024) }), { limits: { retainedBytes: 256 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
});

test('slash-containing object keys and literal star or number keys cannot impersonate protocol array paths', () => {
  const image = { type: 'imageGeneration', result: 'business result' };
  for (const message of [
    { 'params/item': image },
    { 'result/thread/turns/*/items/*': image },
    { result: { thread: { turns: { '*': { items: { '*': image } } } } } },
    { result: { thread: { turns: { 0: { items: [image] } } } } },
    { result: { thread: { turns: [{ 'items/*': image }] } } },
  ]) assert.deepEqual(decode(JSON.stringify(message)).messages, [message]);
  assert.throws(() => decode(JSON.stringify({ 'params/item': { ...image, result: 'x'.repeat(1024) } }),
    { limits: { retainedBytes: 256 } }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
});

test('actual notification and paginated item positions omit media without changing metadata', () => {
  const image = { result: 'inline', type: 'imageGeneration', status: 'completed', savedPath: '/cache/image.png' };
  const without = { type: 'imageGeneration', status: 'completed', savedPath: '/cache/image.png' };
  const wrap = item => [
    { params: { item } }, { params: { turn: { items: [item] } } },
    { params: { thread: { turns: [{ items: [item] }] } } },
    { result: { turn: { items: [item] } } }, { result: { thread: { turns: [{ items: [item] }] } } },
    { result: { data: [{ items: [item] }], nextCursor: 'more' } },
    { result: { data: [{ item }], nextCursor: 'more' } },
    { result: { initialTurnsPage: { data: [{ items: [item] }] } } },
  ];
  assert.deepEqual(decode(wrap(image).map(value => JSON.stringify(value)).join('\n')).messages, wrap(without));
});

test('prototype-looking keys remain own properties without changing prototypes', () => {
  const raw = '{"id":1,"result":{"__proto__":{"polluted":true},"constructor":"value","result":"safe"}}';
  const actual = decode(raw).messages[0];
  assert.deepEqual(actual, JSON.parse(raw));
  assert.equal(Object.getPrototypeOf(actual.result), Object.prototype);
  assert.equal({}.polluted, undefined);
});
