import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CodexClient } from './codex.mjs';
import { Engine } from './engine.mjs';
import { Store } from './store.mjs';
import { GatewayError, STATE_DIR } from './config.mjs';
import { TransportSupervisor } from './reconnect.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const mutations = new Set(['bind_workspace', 'submit', 'rework', 'recover', 'cancel', 'accept', 'collect_images']);

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function acquireLock(stateDir, instanceId) {
  const lockDir = path.join(stateDir, 'daemon.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, instanceId }), { mode: 0o600, flag: 'wx' });
      } catch (error) {
        fs.rmdirSync(lockDir);
        throw error;
      }
      return () => {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { return; }
        if (owner.pid !== process.pid || owner.instanceId !== instanceId) return;
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lockDir);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
    catch {
      throw new GatewayError('DAEMON_LOCKED', 'Gateway lock ownership is not readable. Check whether another daemon is starting.');
    }
    if (pidExists(owner.pid)) {
      throw new GatewayError('DAEMON_RUNNING', 'A gateway daemon already owns this state directory.');
    }
    // Only one contender may remove a stale lock. Recheck its owner after
    // acquiring the reaper directory, so a fresh daemon can never be reaped.
    const reaper = path.join(lockDir, 'reaping');
    try { fs.mkdirSync(reaper, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new GatewayError('DAEMON_LOCKED', 'Another process is inspecting the stale daemon lock.');
    }
    let latest;
    try { latest = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
    catch {
      fs.rmdirSync(reaper);
      throw new GatewayError('DAEMON_LOCKED', 'Daemon lock ownership changed while checking it.');
    }
    if (latest.pid !== owner.pid || latest.instanceId !== owner.instanceId || pidExists(latest.pid)) {
      fs.rmdirSync(reaper);
      throw new GatewayError('DAEMON_RUNNING', 'A gateway daemon owns this state directory.');
    }
    const staleDir = path.join(stateDir, `.stale-daemon-${crypto.randomUUID()}`);
    fs.renameSync(lockDir, staleDir);
    fs.unlinkSync(path.join(staleDir, 'owner.json'));
    fs.rmdirSync(path.join(staleDir, 'reaping'));
    fs.rmdirSync(staleDir);
  }
  throw new GatewayError('DAEMON_LOCKED', 'Could not acquire the gateway daemon lock.');
}

function writePrivateJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      finish(new GatewayError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.'));
      return;
    }
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) finish(new GatewayError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.'));
      else chunks.push(chunk);
    });
    req.once('end', () => {
      if (settled) return;
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new GatewayError('INVALID_JSON', 'Request body must contain valid JSON.')); }
    });
    req.once('aborted', () => finish(new GatewayError('REQUEST_ABORTED', 'Request was interrupted.')));
    req.once('error', () => finish(new GatewayError('REQUEST_ABORTED', 'Request was interrupted.')));
  });
}

function reply(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function validateParams(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new GatewayError('INVALID_INPUT', 'RPC params must be an object.');
  }
  if (['get', 'wait', 'events', 'cancel', 'rework', 'recover', 'accept', 'collect_images'].includes(method)) {
    if (typeof params.id !== 'string' || !params.id.trim() || params.id.length > 256) {
      throw new GatewayError('INVALID_INPUT', 'A valid task id is required.');
    }
  }
  for (const field of ['threadId', 'model']) {
    if (params[field] !== undefined && (typeof params[field] !== 'string' || !params[field] || params[field].length > 256)) {
      throw new GatewayError('INVALID_INPUT', `${field} must be nonempty text of at most 256 characters.`);
    }
  }
  if (params.after !== undefined && (!Number.isSafeInteger(params.after) || params.after < 0)) {
    throw new GatewayError('INVALID_INPUT', 'after must be a nonnegative integer.');
  }
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > (method === 'events' ? 500 : 100))) {
    throw new GatewayError('INVALID_INPUT', 'limit is outside the supported range.');
  }
  if (method === 'wait' && params.timeoutSeconds !== undefined
      && (!Number.isInteger(params.timeoutSeconds) || params.timeoutSeconds < 1 || params.timeoutSeconds > 50)) {
    throw new GatewayError('INVALID_INPUT', 'wait timeoutSeconds must be between 1 and 50.');
  }
}

/** Start one durable scheduler and its authenticated, loopback-only RPC endpoint. */
export async function startServer({ config, stateDir = STATE_DIR, client: injectedClient, tickIntervalMs = 500, reconnectOptions } = {}) {
  if (!config) throw new GatewayError('CONFIG', 'Gateway configuration is required.');
  stateDir = path.resolve(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const instanceId = crypto.randomUUID();
  const releaseLock = acquireLock(stateDir, instanceId);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuffer = Buffer.from(`Bearer ${token}`);
  const tokenFile = path.join(stateDir, 'token');
  const connectionFile = path.join(stateDir, 'connection.json');
  const client = injectedClient || new CodexClient({ bin: config.codexBin });
  let store;
  let engine;
  let server;
  let timer;
  let reconnect;
  let url;
  let closing = false;
  let tokenWritten = false;
  let closePromise;
  let queue = Promise.resolve();
  let tickQueued = false;
  const requests = new Set();
  const serialize = (operation) => {
    const result = queue.then(() => {
      if (closing) throw new GatewayError('SHUTTING_DOWN', 'Gateway is shutting down.');
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  };
  const scheduleTick = () => {
    if (closing || tickQueued) return;
    tickQueued = true;
    serialize(() => engine.tick()).catch(() => {
      if (!closing) process.stderr.write('Gateway scheduler tick failed; durable task state has been retained.\n');
    }).finally(() => { tickQueued = false; });
  };
  const cleanupConnection = () => {
    let connection;
    try { connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8')); } catch { /* Not published yet. */ }
    if (connection?.instanceId === instanceId) fs.unlinkSync(connectionFile);
    if (tokenWritten) {
      try { fs.unlinkSync(tokenFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      tokenWritten = false;
    }
  };
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    if (engine) engine.closing = true;
    clearInterval(timer);
    reconnect?.pause();
    closePromise = (async () => {
      let serverClosed = Promise.resolve();
      if (server?.listening) {
        serverClosed = new Promise((resolve) => server.close(resolve));
        server.closeIdleConnections();
      }
      // Mutations already in progress finish their durable transition before
      // stopping Codex. Pending mutations fail with SHUTTING_DOWN.
      await queue;
      await client.stop().catch(() => {});
      // Stop cancels an initialization already in progress. Drain its promise
      // before closing durable state, and stop again if it completed late.
      await reconnect?.settled();
      if (client.ready || client.child) await client.stop().catch(() => {});
      if (store) {
        for (const run of store.all().filter((run) => run.holdsCapacity)) {
          store.save({ ...run, status: 'uncertain', error: {
            code: 'GATEWAY_STOPPED',
            message: 'Gateway stopped while the turn was active. Restart will inspect the saved turn; no work is automatically replayed.',
          } });
        }
      }
      server?.closeAllConnections();
      await Promise.allSettled([...requests]);
      await serverClosed;
      cleanupConnection();
      store?.close();
      releaseLock();
    })();
    return closePromise;
  };
  try {
    store = new Store(stateDir);
    engine = new Engine({ store, client, config });
    reconnect = new TransportSupervisor({ ...reconnectOptions, client });
    await client.start();
    await engine.restore();
    const handlers = {
      health: () => ({ ok: true, service: 'doubao-codex-gateway', codexConnected: Boolean(client.ready), connection: reconnect.snapshot(), connectionScope: 'transport_only', lastProtocolError: client.lastProtocolError ?? null, pid: process.pid }),
      models: () => engine.models(),
      bind_workspace: (params) => engine.bindWorkspace(params),
      workspaces: () => store.bindings(),
      submit: (params) => engine.submit(params),
      get: ({ id }) => engine.get(id),
      collect_images: (params) => engine.collectImages(params),
      list: ({ limit }) => engine.list(limit),
      wait: (params) => engine.wait(params),
      events: ({ id, after = 0, limit = 100 }) => {
        engine.get(id);
        const events = store.events(id, after, limit);
        return { events, cursor: events.at(-1)?.seq ?? after, latestCursor: store.cursor(id) };
      },
      cancel: ({ id }) => engine.cancel(id),
      rework: (params) => engine.rework(params),
      accept: (params) => engine.accept(params),
      recover: (params) => engine.recover(params),
    };
    const handle = async (req, res) => {
      try {
        const expectedHost = `127.0.0.1:${server.address()?.port}`;
        const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length;
        if (req.headers.origin !== undefined || req.headers.host !== expectedHost || hostCount !== 1) {
          reply(res, 403, { error: { code: 'FORBIDDEN', message: 'Only direct local gateway clients are permitted.' } });
          req.resume();
          return;
        }
        if (closing) {
          reply(res, 503, { error: { code: 'SHUTTING_DOWN', message: 'Gateway is shutting down.' } });
          req.resume();
          return;
        }
        if (req.method === 'GET' && req.url === '/health') {
          reply(res, 200, { ok: true, service: 'doubao-codex-gateway' });
          return;
        }
        const supplied = Buffer.from(req.headers.authorization || '');
        if (supplied.length !== tokenBuffer.length || !crypto.timingSafeEqual(supplied, tokenBuffer)) {
          reply(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Gateway authentication is required.' } });
          req.resume();
          return;
        }
        if (req.method !== 'POST' || req.url !== '/rpc') {
          reply(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown gateway endpoint.' } });
          req.resume();
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          reply(res, 415, { error: { code: 'CONTENT_TYPE', message: 'Use Content-Type: application/json.' } });
          req.resume();
          return;
        }
        const envelope = await readBody(req);
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
            || typeof envelope.method !== 'string' || !Object.hasOwn(handlers, envelope.method)) {
          throw new GatewayError('METHOD_NOT_FOUND', 'Unknown gateway RPC method.');
        }
        const params = envelope.params ?? {};
        validateParams(envelope.method, params);
        const operation = () => handlers[envelope.method](params);
        const result = mutations.has(envelope.method) ? await serialize(operation) : await operation();
        reply(res, 200, { result: result ?? null });
        if (mutations.has(envelope.method) && envelope.method !== 'collect_images') scheduleTick();
      } catch (error) {
        const known = error instanceof GatewayError || typeof error.code === 'string' || typeof error.code === 'number';
        reply(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'Gateway request failed. Inspect local service status.',
        } });
      }
    };
    server = http.createServer((req, res) => {
      const request = handle(req, res);
      requests.add(request);
      request.finally(() => requests.delete(request)).catch(() => {});
    });
    server.requestTimeout = 65_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    url = `http://127.0.0.1:${server.address().port}`;
    const tempToken = `${tokenFile}.${instanceId}.tmp`;
    try {
      fs.writeFileSync(tempToken, token, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempToken, tokenFile);
      tokenWritten = true;
    } finally {
      try { fs.unlinkSync(tempToken); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    writePrivateJson(connectionFile, { url, tokenFile, pid: process.pid, instanceId });
    reconnect.activate();
    timer = setInterval(scheduleTick, tickIntervalMs);
    timer.unref();
    scheduleTick();
    return { server, engine, store, client, close, url };
  } catch (error) {
    await close();
    throw error;
  }
}
