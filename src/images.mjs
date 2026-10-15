import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MAX_BYTES = 25 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const STATUS = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

class CaptureError extends Error {
  constructor(code, message, pending = false) {
    super(message);
    this.code = code;
    this.pending = pending;
  }
}

function fail(code, message) { throw new CaptureError(code, message); }
function missing() { throw new CaptureError('IMAGE_NOT_READY', 'The local image file is not available yet.', true); }
function identity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function inside(root, value) {
  const relative = path.relative(root, value);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function checkedPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)
      || /[\x00-\x1f\x7f]/.test(value) || (path.sep !== '\\' && value.includes('\\'))
      || value.split(path.sep).some((segment) => segment === '.' || segment === '..')) {
    fail('INVALID_IMAGE_PATH', 'An image path must be a bounded absolute local path without traversal.');
  }
  return path.normalize(value);
}
function checkedSegment(value) {
  if (typeof value !== 'string' || !SEGMENT.test(value)) fail('INVALID_IMAGE_ID', 'Image, thread, turn, and task identifiers must be safe path segments.');
  return value;
}
function failureSummary(failure) {
  if (!failure || typeof failure !== 'object') return undefined;
  return failure.type === 'usageLimitExceeded'
    ? { code: 'USAGE_LIMIT_EXCEEDED', message: 'Image generation reported a usage limit.' }
    : { code: 'IMAGE_GENERATION_FAILED', message: 'Image generation reported a failure.' };
}

// Directory descriptors keep identities alive. Recheck the entire chain before
// and after file operations, including before writing any bytes to a new file.
// Never follow a symlink below an explicitly selected workspace/cache root.
function holdDirectory(value, held, { missingIsPending = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(value); }
  catch (error) { if (error.code === 'ENOENT' && missingIsPending) missing(); throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_IMAGE_DIRECTORY', 'An image directory is a symlink or not a directory.');
  const fd = fs.openSync(value, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!identity(stat, opened) || !opened.isDirectory()) fail('IMAGE_DIRECTORY_CHANGED', 'An image directory changed during access.');
    const entry = { path: value, stat: opened, fd, real: fs.realpathSync(value) };
    held.push(entry);
    return entry;
  } catch (error) {
    fs.closeSync(fd); throw error;
  }
}
function verifyDirectories(held) {
  for (const entry of held) {
    let current;
    try { current = fs.lstatSync(entry.path); }
    catch { fail('IMAGE_DIRECTORY_CHANGED', 'An image directory changed during access.'); }
    if (current.isSymbolicLink() || !current.isDirectory() || !identity(current, entry.stat)
        || fs.realpathSync(entry.path) !== entry.real) {
      fail('IMAGE_DIRECTORY_CHANGED', 'An image directory changed during access.');
    }
  }
}
function walkDirectory(root, relative, held, { create = false, pending = false } = {}) {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    if (segment === '.' || segment === '..') fail('INVALID_IMAGE_PATH', 'Image directory traversal is not allowed.');
    current = path.join(current, segment);
    verifyDirectories(held);
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    holdDirectory(current, held, { missingIsPending: pending });
  }
  return current;
}
function readCheckedFile(file, held, { pending = false, expectedSize, privateExisting = false } = {}) {
  verifyDirectories(held);
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' && pending) missing(); throw error; }
  if (before.isSymbolicLink() || !before.isFile()) fail('UNSAFE_IMAGE_FILE', 'The image path is a symlink or not a regular file.');
  if (before.size <= 0 || before.size > MAX_BYTES) fail('IMAGE_SIZE_LIMIT', 'The image must be nonempty and at most 25 MiB.');
  if (expectedSize !== undefined && before.size !== expectedSize) fail('ARTIFACT_CONFLICT', 'A different file already exists at the image delivery path.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    verifyDirectories(held);
    if (!opened.isFile() || !identity(before, opened) || opened.size !== before.size) fail('IMAGE_FILE_CHANGED', 'The image file changed during access.');
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) fail('IMAGE_FILE_CHANGED', 'The image file changed during reading.');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    verifyDirectories(held);
    if (!identity(opened, current) || current.isSymbolicLink() || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      fail('IMAGE_FILE_CHANGED', 'The image file changed during reading.');
    }
    if (privateExisting && (after.mode & 0o077)) fail('UNSAFE_IMAGE_PERMISSIONS', 'An existing artifact is not private; it was not modified.');
    return buffer;
  } finally { fs.closeSync(fd); }
}

function imageType(buffer) {
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8;
    let header = false;
    let pixels = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) break;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !buffer.readUInt32BE(offset + 8) || !buffer.readUInt32BE(offset + 12)) break;
        header = true;
      }
      if (type === 'IDAT' && length > 0) pixels = true;
      offset += length + 12;
      if (type === 'IEND') {
        if (length === 0 && header && pixels && offset === buffer.length) return { extension: 'png', mimeType: 'image/png' };
        break;
      }
    }
  } else if (buffer.length >= 24 && buffer[0] === 0xff && buffer[1] === 0xd8
      && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    let offset = 2;
    let dimensions = false;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) break;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === undefined) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length - 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || !buffer.readUInt16BE(offset + 3) || !buffer.readUInt16BE(offset + 5)) break;
        dimensions = true;
      }
      if (marker === 0xda && dimensions && length >= 6 && offset + length < buffer.length - 2) {
        return { extension: 'jpg', mimeType: 'image/jpeg' };
      }
      offset += length;
    }
  } else if (buffer.length >= 26 && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.readUInt32LE(4) === buffer.length - 8 && buffer.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12;
    let pixels = false;
    while (offset + 8 <= buffer.length) {
      const kind = buffer.toString('ascii', offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (length > buffer.length - start) break;
      if (kind === 'VP8L' && length >= 5 && buffer[start] === 0x2f) pixels = true;
      if (kind === 'VP8 ' && length >= 10 && buffer.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
          && (buffer.readUInt16LE(start + 6) & 0x3fff) && (buffer.readUInt16LE(start + 8) & 0x3fff)) pixels = true;
      offset = start + length + (length % 2);
      if (offset === buffer.length && pixels) return { extension: 'webp', mimeType: 'image/webp' };
    }
  }
  fail('INVALID_IMAGE', 'The local file is not a complete supported PNG, JPEG, or WebP image.');
}

function publish(buffer, destination, held, sha256) {
  const sameExisting = () => {
    const existing = readCheckedFile(destination, held, { expectedSize: buffer.length, privateExisting: true });
    if (crypto.createHash('sha256').update(existing).digest('hex') !== sha256) fail('ARTIFACT_CONFLICT', 'A different file already exists at the image delivery path.');
  };
  try { fs.lstatSync(destination); sameExisting(); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(destination), `.${crypto.randomUUID()}.image-part`);
  let fd;
  let created;
  try {
    verifyDirectories(held);
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    created = fs.fstatSync(fd);
    verifyDirectories(held);
    if (!created.isFile() || !identity(created, fs.lstatSync(temporary))) fail('IMAGE_FILE_CHANGED', 'The image destination changed during creation.');
    fs.fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) fail('IMAGE_WRITE_FAILED', 'The image copy could not be completed.');
      offset += count;
    }
    fs.fsyncSync(fd);
    if (fs.fstatSync(fd).size !== buffer.length) fail('IMAGE_WRITE_FAILED', 'The image copy could not be verified.');
    verifyDirectories(held);
    // An exclusive hard link publishes the complete file atomically and never
    // overwrites a pre-existing destination, including concurrent deliveries.
    try { fs.linkSync(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; sameExisting(); }
    verifyDirectories(held);
    const delivered = readCheckedFile(destination, held, { expectedSize: buffer.length, privateExisting: true });
    if (crypto.createHash('sha256').update(delivered).digest('hex') !== sha256) fail('IMAGE_WRITE_FAILED', 'The delivered image hash did not match.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) {
      try {
        verifyDirectories(held);
        const current = fs.lstatSync(temporary);
        if (identity(created, current) && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(temporary);
      } catch { /* Do not delete through a changed or untrusted directory. */ }
    }
  }
}

/**
 * Copy one completed local generation into its task workspace. No inference,
 * network download, conversion, result/base64 persistence, or source deletion.
 * Filesystem and header/container checks do not decode or re-encode image pixels.
 */
export function captureImage({ run, item, turnId, cacheRoot } = {}) {
  const safeId = (value) => typeof value === 'string' && SEGMENT.test(value) ? value : null;
  const record = {
    itemId: safeId(item?.id), threadId: safeId(run?.threadId), turnId: safeId(turnId ?? run?.turnId),
    attempt: Number.isSafeInteger(run?.attempt) && run.attempt > 0 && run.attempt <= 1_000_000 ? run.attempt : null,
    status: typeof item?.status === 'string' && STATUS.test(item.status) ? item.status : 'unknown',
    savedPath: null, artifact: null, delivery: { status: 'pending' },
  };
  const failure = failureSummary(item?.failure);
  if (failure) record.failure = failure;
  const held = [];
  try {
    checkedSegment(run?.id); checkedSegment(record.itemId); checkedSegment(record.threadId); checkedSegment(record.turnId);
    if (record.attempt === null || record.status === 'unknown') fail('INVALID_IMAGE_METADATA', 'Image attempt and status metadata are invalid.');
    if (record.status !== 'completed') {
      if (failure || ['failed', 'cancelled', 'canceled'].includes(record.status)) {
        record.delivery = { status: 'failed', error: failure ?? { code: 'IMAGE_GENERATION_FAILED', message: 'Image generation did not complete.' } };
      }
      return record;
    }
    const workspaceInput = checkedPath(run.workspace);
    if (workspaceInput === path.parse(workspaceInput).root) fail('INVALID_IMAGE_WORKSPACE', 'A specific image workspace is required.');
    const workspaceEntry = holdDirectory(workspaceInput, held);
    const workspace = workspaceEntry.real;
    const cacheInput = checkedPath(cacheRoot ?? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images'));
    const threadCacheInput = path.join(cacheInput, record.threadId);
    const sourceInput = item.savedPath === undefined || item.savedPath === null || item.savedPath === ''
      ? path.join(threadCacheInput, `${record.itemId}.png`) : checkedPath(item.savedPath);
    let root;
    let source;
    if (inside(workspaceInput, sourceInput)) {
      root = workspace;
      source = path.join(workspace, path.relative(workspaceInput, sourceInput));
    } else if (inside(workspace, sourceInput)) {
      root = workspace;
      source = sourceInput;
    } else if (inside(threadCacheInput, sourceInput)) {
      record.savedPath = sourceInput;
      const cacheEntry = holdDirectory(cacheInput, held, { missingIsPending: true });
      root = walkDirectory(cacheEntry.real, record.threadId, held, { pending: true });
      source = path.join(root, path.relative(threadCacheInput, sourceInput));
    } else {
      fail('IMAGE_SOURCE_DENIED', 'The local image is outside this workspace and this thread image cache.');
    }
    record.savedPath = source;
    walkDirectory(root, path.relative(root, path.dirname(source)), held, { pending: true });
    const buffer = readCheckedFile(source, held, { pending: true });
    const type = imageType(buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const directory = walkDirectory(workspace, path.join('.doubao-codex', 'artifacts', run.id, `attempt-${record.attempt}`), held, { create: true });
    const destination = path.join(directory, `${record.itemId}.${type.extension}`);
    publish(buffer, destination, held, sha256);
    record.artifact = { path: destination, name: path.relative(workspace, destination), bytes: buffer.length, sha256, mimeType: type.mimeType };
    record.delivery = { status: 'copied' };
  } catch (error) {
    record.delivery = {
      status: error instanceof CaptureError && error.pending ? 'pending' : 'failed',
      error: error instanceof CaptureError ? { code: error.code, message: error.message }
        : { code: 'IMAGE_IO_FAILED', message: 'The local image could not be safely read or copied.' },
    };
  } finally {
    for (const entry of held.reverse()) { try { fs.closeSync(entry.fd); } catch {} }
  }
  return record;
}
