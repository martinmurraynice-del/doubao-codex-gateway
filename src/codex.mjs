import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export class CodexRpcError extends Error {
  constructor(message, { code, data, method, requestId, sent = false } = {}) {
    super(message);
    this.name = 'CodexRpcError';
    Object.assign(this, { code, data, method, requestId, sent });
  }
}

/**
 * One long-lived, initialized Codex app-server connection.
 * `args` contains extra app-server arguments, e.g. ['-c', 'model="..."'].
 * Install notification/serverRequest/disconnect listeners before calling start().
 * Requests are never retried: a timeout after writing may mean work was accepted.
 */
export class CodexClient extends EventEmitter {
  constructor({ bin = 'codex', args = [], logger } = {}) {
    super();
    if (typeof bin !== 'string' || !bin) throw new TypeError('Codex bin must be a nonempty string');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('Codex args must be an array of strings');
    }
    this.bin = bin;
    this.args = [...args];
    this.logger = logger;
    this.child = null;
    this.pending = new Map();
    this.serverRequests = new Set();
    this.sequence = 0;
    this.ready = false;
    this.initialization = null;
    this.starting = null;
    this.stopping = null;
  }

  async start() {
    if (this.stopping) await this.stopping;
    if (this.ready) return this.initialization;
    if (this.starting) return this.starting;
    const operation = this.#start();
    this.starting = operation;
    try {
      return await operation;
    } finally {
      if (this.starting === operation) this.starting = null;
    }
  }

  async #start() {
    const child = spawn(this.bin, ['app-server', '--listen', 'stdio://', ...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let buffer = '';
    let disconnected = false;
    const disconnect = (reason) => {
      if (disconnected) return;
      disconnected = true;
      if (this.child === child) {
        this.ready = false;
        this.initialization = null;
        this.child = null;
        this.serverRequests.clear();
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new CodexRpcError('Codex app-server disconnected', {
            code: 'CODEX_DISCONNECTED', method: pending.method, requestId: id,
            sent: pending.sent,
          }));
        }
        this.pending.clear();
      }
      this.emit('disconnect', { ...reason, expected: Boolean(this.stopping) });
    };
    child.once('error', (error) => disconnect({ code: error.code ?? 'SPAWN_ERROR' }));
    child.once('exit', (code, signal) => disconnect({ code, signal }));
    // Register all streams before initialization so notifications cannot fall
    // into a gap between starting the process and installing the protocol.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
          this.#protocolFailure(child, 'Codex message exceeds transport limit');
          return;
        }
        this.#receive(line, child);
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        buffer = '';
        this.#protocolFailure(child, 'Codex message exceeds transport limit');
      }
    });
    child.stdout.on('error', () => this.#protocolFailure(child, 'Codex stdout stream failed'));
    child.stdin.on('error', () => {
      disconnect({ code: 'STDIN_ERROR' });
      child.kill('SIGTERM');
    });
    // Drain stderr, but deliberately never log its content: it can contain
    // sensitive prompts, credentials, or values inherited from user settings.
    child.stderr.on('data', (chunk) => this.#log('codex_stderr', { bytes: chunk.length }));
    child.stderr.on('error', () => this.#log('codex_stderr_error', {}));
    try {
      const initialized = await this.#sendRequest('initialize', {
        clientInfo: { name: 'doubao_codex_gateway', title: 'Doubao Codex Gateway', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, 30_000);
      if (this.child !== child || disconnected) throw new Error('Codex disconnected during initialization');
      this.#write({ method: 'initialized' });
      this.initialization = initialized;
      this.ready = true;
      return initialized;
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  async request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (typeof method !== 'string' || !method) throw new TypeError('RPC method must be a nonempty string');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    await this.start();
    return this.#sendRequest(method, params, timeoutMs);
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    if (!this.serverRequests.has(id)) return false;
    this.#write({ id, result });
    this.serverRequests.delete(id);
    return true;
  }

  reject(id, message = 'This server request is not supported', code = -32601) {
    if (!this.serverRequests.has(id)) return false;
    this.#write({ id, error: { code, message } });
    this.serverRequests.delete(id);
    return true;
  }

  #sendRequest(method, params, timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, method, sent: false, timer: null };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex request timed out: ${method}`, {
          code: 'RPC_TIMEOUT', method, requestId: id, sent: pending.sent,
        }));
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        this.#write({ id, method, params });
        pending.sent = true;
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new CodexRpcError('Codex app-server is not connected', { code: 'CODEX_DISCONNECTED' });
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line, child) {
    if (this.child !== child) return;
    let message;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid envelope');
    } catch {
      this.#protocolFailure(child, 'Codex sent invalid JSON');
      return;
    }
    if (typeof message.method === 'string') {
      const request = { method: message.method, params: message.params ?? {} };
      if (Object.hasOwn(message, 'id')) {
        request.id = message.id;
        this.serverRequests.add(message.id);
        if (this.listenerCount('serverRequest')) {
          this.emit('serverRequest', request);
        } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          this.respond(message.id, { decision: 'decline' });
        } else {
          this.reject(message.id);
        }
      } else {
        this.emit('notification', request);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late response to an expired request; never resend it.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CodexRpcError(message.error.message ?? 'Codex request failed', {
        code: message.error.code, data: message.error.data, method: pending.method,
        requestId: message.id, sent: pending.sent,
      }));
    } else if (Object.hasOwn(message, 'result')) {
      pending.resolve(message.result);
    } else {
      pending.reject(new CodexRpcError('Codex response has no result or error', {
        code: 'PROTOCOL_ERROR', method: pending.method, requestId: message.id, sent: pending.sent,
      }));
    }
  }

  #protocolFailure(child, message) {
    this.#log('codex_protocol_error', { message });
    this.emit('protocolError', new CodexRpcError(message, { code: 'PROTOCOL_ERROR' }));
    child.kill('SIGTERM');
  }

  #log(event, details) {
    try {
      if (typeof this.logger === 'function') this.logger(event, details);
      else this.logger?.warn?.({ event, ...details });
    } catch { /* Logging must never break the transport. */ }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.ready = false;
    this.stopping = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.once('close', () => {
        clearTimeout(terminate);
        clearTimeout(force);
        resolve();
      });
      child.stdin.end();
    });
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }
}
