import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { captureImage } from '../src/images.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
// Marker/container fixture: this module checks headers, not pixel decoding.
const JPEG = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-images-test-')));
  const workspace = path.join(root, 'workspace');
  const cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const run = { id: 'dcg-test', workspace, threadId: 'thread-test', turnId: 'turn-test', attempt: 1 };
  const item = { id: 'exec-test', type: 'imageGeneration', status: 'completed', result: 'DO_NOT_PERSIST_BASE64', failure: null };
  const cached = path.join(cacheRoot, run.threadId, `${item.id}.png`);
  const destination = path.join(workspace, '.doubao-codex', 'artifacts', run.id, 'attempt-1', `${item.id}.png`);
  const capture = (overrides = {}) => captureImage({ run, item, turnId: run.turnId, cacheRoot, ...overrides });
  const save = (file = cached, bytes = PNG) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, cacheRoot, run, item, cached, destination, capture, save };
}

test('completed cache PNG is preserved and privately delivered with hash and bounded metadata', t => {
  const f = setup(t); f.save();
  const record = f.capture();
  assert.deepEqual(record.delivery, { status: 'copied' });
  assert.equal(record.savedPath, f.cached);
  assert.equal(record.status, 'completed');
  assert.equal(record.itemId, f.item.id);
  assert.equal(record.turnId, f.run.turnId);
  assert.equal(record.threadId, f.run.threadId);
  assert.equal(record.attempt, 1);
  assert.deepEqual(record.artifact, {
    path: f.destination, name: path.relative(f.workspace, f.destination), bytes: PNG.length,
    sha256: crypto.createHash('sha256').update(PNG).digest('hex'), mimeType: 'image/png',
  });
  assert.deepEqual(fs.readFileSync(f.destination), PNG);
  assert.deepEqual(fs.readFileSync(f.cached), PNG);
  assert.equal(fs.statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.destination)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(record).includes(f.item.result));
  assert.ok(!Object.hasOwn(record, 'result'));
});

test('absent cache, thread directory, and source stay pending until a retry can copy', t => {
  const f = setup(t);
  for (let step = 0; step < 3; step++) {
    const record = f.capture();
    assert.equal(record.delivery.status, 'pending');
    assert.equal(record.delivery.error.code, 'IMAGE_NOT_READY');
    assert.equal(record.savedPath, f.cached);
    assert.equal(record.artifact, null);
    assert.equal(fs.existsSync(path.join(f.workspace, '.doubao-codex')), false);
    fs.mkdirSync(step === 0 ? f.cacheRoot : path.dirname(f.cached), { recursive: true });
  }
  f.save();
  assert.equal(f.capture().delivery.status, 'copied');
});

test('savedPath in workspace works and extension is selected from bytes, not filename', t => {
  const f = setup(t);
  const savedPath = f.save(path.join(f.workspace, '自定义目录', 'looks-like-a-jpeg.jpg'));
  const record = f.capture({ item: { ...f.item, savedPath } });
  assert.equal(record.delivery.status, 'copied');
  assert.equal(record.savedPath, savedPath);
  assert.equal(record.artifact.path, f.destination);
  assert.equal(record.artifact.mimeType, 'image/png');
  assert.equal(fs.existsSync(f.cacheRoot), false);
});

test('JPEG and WebP headers preserve original formats without conversion', t => {
  const f = setup(t);
  for (const [id, bytes, extension, mimeType] of [['jpeg-item', JPEG, 'jpg', 'image/jpeg'], ['webp-item', WEBP, 'webp', 'image/webp']]) {
    const savedPath = f.save(path.join(f.workspace, `${id}.png`), bytes);
    const record = f.capture({ item: { ...f.item, id, savedPath } });
    assert.equal(record.delivery.status, 'copied', JSON.stringify(record.delivery));
    assert.equal(path.extname(record.artifact.path), `.${extension}`);
    assert.equal(record.artifact.mimeType, mimeType);
    assert.deepEqual(fs.readFileSync(record.artifact.path), bytes);
  }
});

test('duplicate captures are byte-for-byte idempotent and leave no staging files', t => {
  const f = setup(t); f.save();
  const first = f.capture();
  const before = fs.statSync(f.destination);
  const second = f.capture();
  assert.deepEqual(second, first);
  const after = fs.statSync(f.destination);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ['exec-test.png']);
});

test('same delivery filename with different existing bytes fails without overwriting', t => {
  const f = setup(t); f.save();
  const other = Buffer.from(PNG); other[other.length - 1] ^= 1;
  f.save(f.destination, other);
  const record = f.capture();
  assert.equal(record.delivery.status, 'failed');
  assert.equal(record.delivery.error.code, 'ARTIFACT_CONFLICT');
  assert.equal(record.artifact, null);
  assert.deepEqual(fs.readFileSync(f.destination), other);
});

test('existing nonprivate artifact is neither accepted nor chmodded', t => {
  const f = setup(t); f.save(); f.save(f.destination);
  fs.chmodSync(f.destination, 0o644);
  const record = f.capture();
  assert.equal(record.delivery.error.code, 'UNSAFE_IMAGE_PERMISSIONS');
  assert.equal(fs.statSync(f.destination).mode & 0o777, 0o644);
});

test('outside workspace or another thread cache is rejected without reading', t => {
  const f = setup(t);
  for (const savedPath of [f.save(path.join(f.root, 'external.png')), f.save(path.join(f.cacheRoot, 'other-thread', 'image.png'))]) {
    const record = f.capture({ item: { ...f.item, savedPath } });
    assert.equal(record.delivery.status, 'failed');
    assert.equal(record.delivery.error.code, 'IMAGE_SOURCE_DENIED');
    assert.equal(record.savedPath, null);
    assert.equal(record.artifact, null);
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.doubao-codex')), false);
});

test('source file and directory symlinks are rejected, including links within the workspace', t => {
  const f = setup(t);
  const source = f.save(path.join(f.root, 'external', 'image.png'));
  const leaf = path.join(f.workspace, 'leaf.png'); fs.symlinkSync(source, leaf);
  const directory = path.join(f.workspace, 'linked'); fs.symlinkSync(path.dirname(source), directory);
  const internal = f.save(path.join(f.workspace, 'original.png'));
  const internalLink = path.join(f.workspace, 'internal.png'); fs.symlinkSync(internal, internalLink);
  for (const savedPath of [leaf, path.join(directory, 'image.png'), internalLink]) {
    const record = f.capture({ item: { ...f.item, savedPath } });
    assert.equal(record.delivery.status, 'failed');
    assert.match(record.delivery.error.code, /^UNSAFE_IMAGE_(FILE|DIRECTORY)$/);
    assert.equal(record.artifact, null);
  }
});

test('symlinked thread cache is rejected', t => {
  const f = setup(t);
  const outside = path.join(f.root, 'outside'); f.save(path.join(outside, `${f.item.id}.png`));
  fs.mkdirSync(f.cacheRoot); fs.symlinkSync(outside, path.join(f.cacheRoot, f.run.threadId));
  const record = f.capture();
  assert.equal(record.delivery.status, 'failed');
  assert.equal(record.delivery.error.code, 'UNSAFE_IMAGE_DIRECTORY');
});

test('destination directory and destination file symlinks cannot escape or overwrite', t => {
  const f = setup(t); f.save();
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const artifactRoot = path.join(f.workspace, '.doubao-codex'); fs.symlinkSync(outside, artifactRoot);
  assert.equal(f.capture().delivery.error.code, 'UNSAFE_IMAGE_DIRECTORY');
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(artifactRoot);
  const victim = f.save(path.join(outside, 'victim.png'));
  fs.mkdirSync(path.dirname(f.destination), { recursive: true }); fs.symlinkSync(victim, f.destination);
  assert.equal(f.capture().delivery.error.code, 'UNSAFE_IMAGE_FILE');
  assert.deepEqual(fs.readFileSync(victim), PNG);
  assert.equal(fs.lstatSync(f.destination).isSymbolicLink(), true);
});

test('empty, oversized, nonimage, and truncated files fail without creating artifacts', t => {
  const f = setup(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an image'), PNG.subarray(0, 32), WEBP.subarray(0, WEBP.length - 1)]) {
    f.save(f.cached, bytes);
    const record = f.capture();
    assert.equal(record.delivery.status, 'failed');
    assert.equal(record.artifact, null);
  }
  f.save(); fs.truncateSync(f.cached, 25 * 1024 * 1024 + 1);
  assert.equal(f.capture().delivery.error.code, 'IMAGE_SIZE_LIMIT');
  assert.equal(fs.existsSync(path.join(f.workspace, '.doubao-codex')), false);
});

test('noncompleted events do not read or copy, and failure metadata is safely summarized', t => {
  const f = setup(t); f.save();
  const inProgress = f.capture({ item: { ...f.item, status: 'inProgress' } });
  assert.equal(inProgress.status, 'inProgress'); assert.equal(inProgress.delivery.status, 'pending');
  const failed = f.capture({ item: { ...f.item, status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'secret', message: 'data:image/png;base64,SECRET' } } });
  assert.equal(failed.delivery.status, 'failed');
  assert.deepEqual(failed.failure, { code: 'USAGE_LIMIT_EXCEEDED', message: 'Image generation reported a usage limit.' });
  assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.ok(!JSON.stringify(failed).includes('base64'));
  assert.equal(fs.existsSync(path.join(f.workspace, '.doubao-codex')), false);
});

test('malformed IDs, attempts, remote URLs, and traversal never enter filesystem records', t => {
  const f = setup(t);
  for (const id of ['../escape', 'a/b', 'a\\b', '', 'a'.repeat(201), 'data:image/png;base64,SECRET']) {
    const record = f.capture({ item: { ...f.item, id } });
    assert.equal(record.delivery.status, 'failed'); assert.equal(record.itemId, null);
    assert.ok(!JSON.stringify(record).includes('SECRET'));
  }
  for (const attempt of [-1, 0, 1.5, 1_000_001]) assert.equal(f.capture({ run: { ...f.run, attempt } }).delivery.status, 'failed');
  for (const savedPath of ['https://secret.example/image.png', 'data:image/png;base64,SECRET', 'relative.png', `${f.workspace}/../outside.png`, `${f.workspace}/x\u0000y`]) {
    const record = f.capture({ item: { ...f.item, savedPath } });
    assert.equal(record.delivery.status, 'failed'); assert.equal(record.savedPath, null);
    assert.ok(!JSON.stringify(record).includes('secret.example'));
    assert.ok(!JSON.stringify(record).includes('SECRET'));
  }
});

test('source directory replacement between open and read fails before reading bytes', t => {
  const f = setup(t); f.save();
  const open = fs.openSync; const read = fs.readSync; let reads = 0; let swapped = false;
  fs.readSync = (...args) => { reads++; return read(...args); };
  fs.openSync = (...args) => {
    const fd = open(...args);
    if (args[0] === f.cached && !swapped) {
      swapped = true;
      fs.renameSync(path.dirname(f.cached), path.join(f.cacheRoot, 'moved'));
      fs.mkdirSync(path.dirname(f.cached));
    }
    return fd;
  };
  let record;
  try { record = f.capture(); } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(swapped, true); assert.equal(reads, 0);
  assert.equal(record.delivery.status, 'failed');
  assert.equal(record.delivery.error.code, 'IMAGE_DIRECTORY_CHANGED');
});

test('destination directory replacement after staging open fails before writing image bytes', t => {
  const f = setup(t); f.save();
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const open = fs.openSync; const write = fs.writeSync; let writes = 0; let swapped = false;
  fs.writeSync = (...args) => { writes++; return write(...args); };
  fs.openSync = (...args) => {
    const fd = open(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.image-part') && !swapped) {
      swapped = true;
      fs.renameSync(path.dirname(f.destination), path.join(path.dirname(path.dirname(f.destination)), 'moved'));
      fs.symlinkSync(outside, path.dirname(f.destination));
    }
    return fd;
  };
  let record;
  try { record = f.capture(); } finally { fs.openSync = open; fs.writeSync = write; }
  assert.equal(swapped, true); assert.equal(writes, 0);
  assert.equal(record.delivery.status, 'failed');
  assert.equal(record.delivery.error.code, 'IMAGE_DIRECTORY_CHANGED');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('CODEX_HOME default is resolved into generated_images and does not inspect result', t => {
  const f = setup(t);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(f.root, 'codex-home');
  const cached = f.save(path.join(process.env.CODEX_HOME, 'generated_images', f.run.threadId, `${f.item.id}.png`));
  let record;
  try { record = captureImage({ run: f.run, item: { ...f.item, result: 'https://remote.example/SECRET' } }); }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  assert.equal(record.delivery.status, 'copied');
  assert.equal(record.savedPath, cached);
  assert.ok(!JSON.stringify(record).includes('remote.example'));
});
