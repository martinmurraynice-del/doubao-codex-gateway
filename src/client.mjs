import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_STATE_DIR } from './config.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class GatewayError extends Error {
  constructor(message, { code = 'GATEWAY_ERROR', outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function checkedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError('Gateway connection file contains an invalid URL.', { code: 'INVALID_CONNECTION' });
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new GatewayError('Gateway URL must be an HTTP loopback address without credentials or a path.', {
      code: 'INVALID_CONNECTION',
    });
  }
  return url;
}

/** Authenticated local client. Calls are sent once; failed submissions are never replayed. */
export class GatewayClient {
  constructor({ stateDir = process.env.GATEWAY_STATE_DIR || DEFAULT_STATE_DIR } = {}) {
    this.stateDir = path.resolve(stateDir);
  }

  async #connection() {
    let connection;
    try {
      const raw = await readFile(path.join(this.stateDir, 'connection.json'), 'utf8');
      if (raw.length > 16_384) throw new Error('oversized');
      connection = JSON.parse(raw);
    } catch (error) {
      throw new GatewayError(error.code === 'ENOENT'
        ? 'Gateway is not running. Start the gateway service before connecting.'
        : 'Gateway connection file cannot be read or is invalid.', { code: 'GATEWAY_UNAVAILABLE' });
    }
    if (!connection || typeof connection.url !== 'string' || typeof connection.tokenFile !== 'string'
        || !connection.tokenFile || connection.tokenFile.includes('\0')) {
      throw new GatewayError('Gateway connection file is missing its URL or token file.', { code: 'INVALID_CONNECTION' });
    }
    const url = checkedUrl(connection.url);
    let token;
    try {
      token = (await readFile(path.resolve(this.stateDir, connection.tokenFile), 'utf8')).trim();
    } catch {
      throw new GatewayError('Gateway authentication token cannot be read.', { code: 'INVALID_CONNECTION' });
    }
    if (!token || token.length > 16_384 || /[\r\n]/.test(token)) {
      throw new GatewayError('Gateway authentication token is invalid.', { code: 'INVALID_CONNECTION' });
    }
    return { url, token };
  }

  async call(method, params = {}, { timeoutMs = 60_000, signal } = {}) {
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_]*$/.test(method)) {
      throw new TypeError('Gateway method must be a lowercase RPC method name.');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('Gateway params must be an object.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      throw new TypeError('Gateway timeout must be between 1 and 300000 milliseconds.');
    }
    const body = JSON.stringify({ method, params });
    const { url, token } = await this.#connection();
    const timeoutSignal = AbortSignal.timeout(Math.ceil(timeoutMs));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    if (requestSignal.aborted) {
      throw new GatewayError('Gateway request was aborted before sending.', { code: 'REQUEST_ABORTED' });
    }
    let response;
    try {
      response = await fetch(new URL('/rpc', url), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: requestSignal,
        redirect: 'error',
      });
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new GatewayError('Gateway response is too large.', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
      }
      // Limit streaming bodies too, including responses without Content-Length.
      const chunks = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            throw new GatewayError('Gateway response is too large.', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
          }
          chunks.push(chunk);
        }
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new GatewayError('Gateway returned an invalid JSON response.', { code: 'INVALID_RESPONSE', outcomeUnknown: true });
      }
      if (payload && typeof payload.error === 'object' && payload.error !== null) {
        throw new GatewayError(typeof payload.error.message === 'string' ? payload.error.message : 'Gateway request failed.', {
          code: payload.error.code ?? 'GATEWAY_ERROR',
        });
      }
      if (!response.ok || !payload || !Object.hasOwn(payload, 'result')) {
        throw new GatewayError(`Gateway returned an unexpected response (HTTP ${response.status}).`, {
          code: response.status === 401 ? 'UNAUTHORIZED' : 'INVALID_RESPONSE',
          outcomeUnknown: response.status !== 401,
        });
      }
      return payload.result;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (requestSignal.aborted) {
        throw new GatewayError(
          'Gateway request timed out or was interrupted. Its outcome may be unknown; inspect existing tasks before taking further action.',
          { code: timeoutSignal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED', outcomeUnknown: true },
        );
      }
      throw new GatewayError(
        'Cannot connect to the gateway. The request was not retried; inspect service status and existing tasks before submitting again.',
        { code: 'GATEWAY_UNAVAILABLE', outcomeUnknown: true },
      );
    }
  }
}
