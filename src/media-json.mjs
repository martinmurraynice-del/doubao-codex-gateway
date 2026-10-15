// A bounded NDJSON decoder. Image bytes stay in Codex's own history/cache;
// gateway consumers receive the complete protocol tree except image result.
export const MEDIA_JSON_LIMITS = Object.freeze({ retainedBytes: 32 * 1024 * 1024, wireBytes: 512 * 1024 * 1024, depth: 128, values: 500_000 });

export class MediaProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaProtocolError'; this.code = code; }
}
const invalid = () => { throw new MediaProtocolError('PROTOCOL_ERROR', 'Codex sent invalid JSON.'); };
const tooLarge = () => { throw new MediaProtocolError('CODEX_MESSAGE_TOO_LARGE', 'Codex non-media protocol data exceeds the retained message limit.'); };
const own = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
// null denotes an actual array index, never an object key spelled "*" or "0".
const ITEM_PATHS = [
  ['params', 'item'], ['params', 'turn', 'items', null], ['params', 'thread', 'turns', null, 'items', null],
  ['result', 'turn', 'items', null], ['result', 'thread', 'turns', null, 'items', null],
  ['result', 'data', null, 'items', null], ['result', 'data', null, 'item'],
  ['result', 'initialTurnsPage', 'data', null, 'items', null],
];
function itemPath(parts) {
  return ITEM_PATHS.some(pattern => pattern.length === parts.length && pattern.every((part, index) =>
    part === null ? typeof parts[index] === 'number' : parts[index] === part));
}
class DeferredResult {
  constructor() { this.parts = []; this.bytes = 0; this.discarded = false; }
}

class FrameParser {
  constructor(limits) {
    this.limits = limits; this.stack = []; this.rootSet = false; this.root = undefined;
    this.token = null; this.bytes = 0; this.values = 0; this.candidates = new Set(); this.omitted = 0;
  }
  discard(candidate) {
    this.bytes -= candidate.bytes; candidate.bytes = 0; candidate.parts = []; candidate.discarded = true;
  }
  retain(part, candidate) {
    if (!part) return;
    if (candidate?.discarded) return;
    const bytes = Buffer.byteLength(part);
    if (candidate && this.bytes + bytes > this.limits.retainedBytes) { this.discard(candidate); return; }
    if (!candidate && this.bytes + bytes > this.limits.retainedBytes) {
      // Field ordering is unrestricted. A result preceding type may be an
      // image: defer that decision until its containing object closes. If it
      // is not an image, a discarded candidate fails closed, never truncates.
      for (const pending of this.candidates) {
        if (!pending.discarded) this.discard(pending);
        if (this.bytes + bytes <= this.limits.retainedBytes) break;
      }
    }
    if (this.bytes + bytes > this.limits.retainedBytes) tooLarge();
    this.bytes += bytes;
    if (candidate) { candidate.bytes += bytes; candidate.parts.push(part); }
    else this.token?.parts.push(part);
  }
  frame() { return this.stack.at(-1); }
  valuePath() {
    const frame = this.frame();
    return !frame ? [] : [...frame.path, frame.kind === 'array' ? frame.value.length : frame.key];
  }
  expectsValue() {
    const frame = this.frame();
    return !frame ? !this.rootSet : ['value', 'valueOrEnd'].includes(frame.state);
  }
  attach(value) {
    if (++this.values > this.limits.values) tooLarge();
    const frame = this.frame();
    if (!frame) { if (this.rootSet) invalid(); this.root = value; this.rootSet = true; return; }
    if (!this.expectsValue()) invalid();
    if (frame.kind === 'array') frame.value.push(value);
    else {
      const previous = frame.value[frame.key];
      if (previous instanceof DeferredResult) { this.discard(previous); this.candidates.delete(previous); }
      own(frame.value, frame.key, value);
    }
    frame.state = 'commaOrEnd';
  }
  close(kind) {
    const frame = this.frame();
    if (!frame || frame.kind !== kind || !['commaOrEnd', kind === 'object' ? 'keyOrEnd' : 'valueOrEnd'].includes(frame.state)) invalid();
    if (kind === 'object' && frame.value.result instanceof DeferredResult) {
      const candidate = frame.value.result;
      if (frame.value.type === 'imageGeneration') {
        this.discard(candidate); delete frame.value.result; this.omitted++;
      } else {
        if (candidate.discarded) tooLarge();
        try { own(frame.value, 'result', JSON.parse(candidate.parts.join(''))); } catch { invalid(); }
      }
      this.candidates.delete(candidate);
    }
    this.stack.pop(); this.attach(frame.value);
  }
  stringDone() {
    const token = this.token; this.token = null;
    let value;
    if (token.candidate) value = token.candidate;
    else { try { value = JSON.parse(token.parts.join('')); } catch { invalid(); } }
    if (token.key) { const frame = this.frame(); frame.key = value; frame.state = 'colon'; }
    else this.attach(value);
  }
  primitiveDone() {
    const token = this.token; this.token = null;
    let value;
    try { value = JSON.parse(token.parts.join('')); } catch { invalid(); }
    if (value && typeof value === 'object' || typeof value === 'string') invalid();
    this.attach(value);
  }
  feed(text) {
    let offset = 0;
    while (offset < text.length) {
      const token = this.token;
      if (token?.kind === 'string') {
        const append = part => this.retain(part, token.candidate);
        if (token.unicode) {
          if (!/[0-9a-f]/i.test(text[offset])) invalid();
          append(text[offset++]); token.unicode--; continue;
        }
        if (token.escape) {
          const c = text[offset++];
          if (!'"\\/bfnrtu'.includes(c)) invalid();
          append(c); token.escape = false; if (c === 'u') token.unicode = 4;
          continue;
        }
        const special = /["\\\x00-\x1f]/g; special.lastIndex = offset;
        const match = special.exec(text); const end = match ? match.index : text.length;
        append(text.slice(offset, end)); offset = end;
        if (!match) continue;
        const c = text[offset++];
        if (c === '"') { append(c); this.stringDone(); }
        else if (c === '\\') { append(c); token.escape = true; }
        else invalid();
        continue;
      }
      if (token?.kind === 'primitive') {
        const delimiter = /[\s,\]}]/g; delimiter.lastIndex = offset;
        const match = delimiter.exec(text); const end = match ? match.index : text.length;
        this.retain(text.slice(offset, end)); offset = end;
        if (match) this.primitiveDone();
        continue;
      }
      const c = text[offset++];
      if (' \t\r'.includes(c)) continue;
      const frame = this.frame();
      if (c === '"') {
        const key = frame?.kind === 'object' && ['key', 'keyOrEnd'].includes(frame.state);
        if (!key && !this.expectsValue()) invalid();
        const candidate = !key && frame?.kind === 'object' && frame.imageItem && frame.key === 'result' ? new DeferredResult() : null;
        if (candidate) this.candidates.add(candidate);
        this.token = { kind: 'string', key, candidate, parts: [], escape: false, unicode: 0 };
        this.retain(c, candidate);
      } else if (c === '{' || c === '[') {
        if (!this.expectsValue()) invalid();
        this.retain(c);
        if (this.stack.length >= this.limits.depth) tooLarge();
        const location = this.valuePath();
        this.stack.push(c === '{' ? { kind: 'object', value: {}, state: 'keyOrEnd', key: null, path: location, imageItem: itemPath(location) }
          : { kind: 'array', value: [], state: 'valueOrEnd', path: location });
      } else if (c === '}' || c === ']') {
        this.retain(c); this.close(c === '}' ? 'object' : 'array');
      } else if (c === ':') {
        if (frame?.kind !== 'object' || frame.state !== 'colon') invalid();
        this.retain(c); frame.state = 'value';
      } else if (c === ',') {
        if (frame?.state !== 'commaOrEnd') invalid();
        this.retain(c); frame.state = frame.kind === 'object' ? 'key' : 'value';
      } else {
        if (!this.expectsValue() || !/[-0-9tfn]/.test(c)) invalid();
        this.token = { kind: 'primitive', parts: [] }; this.retain(c);
      }
    }
  }
  finish() {
    if (this.token?.kind === 'primitive') this.primitiveDone();
    if (this.token || this.stack.length) invalid();
    return this.rootSet ? { message: this.root, retainedBytes: this.bytes, omittedImageResults: this.omitted } : null;
  }
}

export class MediaJsonDecoder {
  constructor({ onMessage, limits = {} } = {}) {
    this.limits = { ...MEDIA_JSON_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Protocol limits must be positive integers.');
    this.onMessage = onMessage; this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.parser = new FrameParser(this.limits); this.wireBytes = 0; this.failed = false;
  }
  write(chunk) {
    if (this.failed) return;
    try { this.feed(this.decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true })); }
    catch (error) { this.failed = true; throw error instanceof MediaProtocolError ? error : new MediaProtocolError('PROTOCOL_ERROR', 'Codex sent invalid protocol data.'); }
  }
  feed(text) {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset); const end = newline < 0 ? text.length : newline;
      const part = text.slice(offset, end); this.wireBytes += Buffer.byteLength(part);
      if (this.wireBytes > this.limits.wireBytes) throw new MediaProtocolError('CODEX_MESSAGE_TOO_LARGE', 'Codex raw protocol frame exceeds the wire message limit.');
      this.parser.feed(part);
      if (newline < 0) return;
      this.flush(); offset = newline + 1;
    }
  }
  flush() {
    const result = this.parser.finish(); const wireBytes = this.wireBytes;
    this.parser = new FrameParser(this.limits); this.wireBytes = 0;
    if (result) this.onMessage(result.message, { wireBytes, retainedBytes: result.retainedBytes, omittedImageResults: result.omittedImageResults });
  }
  end() {
    if (this.failed) return;
    try { this.feed(this.decoder.decode()); if (this.wireBytes) this.flush(); }
    catch (error) { this.failed = true; throw error instanceof MediaProtocolError ? error : new MediaProtocolError('PROTOCOL_ERROR', 'Codex sent invalid protocol data.'); }
  }
}
