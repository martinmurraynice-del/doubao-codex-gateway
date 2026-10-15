/** Restore only the transport; never inspect, resume, replay, or release work. */
export class TransportSupervisor {
  constructor({ client, initialDelayMs = 1000, maxDelayMs = 30_000, clock, logger } = {}) {
    if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1
        || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
      throw new TypeError('Reconnect delays must be positive integers with max >= initial.');
    }
    this.client = client;
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.clock = clock ?? { now: Date.now, setTimeout, clearTimeout };
    this.logger = logger;
    this.active = false;
    this.closed = false;
    this.timer = null;
    this.flight = null;
    this.attempts = 0;
    this.nextRetryAt = null;
    this.disconnected = (reason = {}) => {
      if (!reason.expected) this.#schedule();
    };
    client.on('disconnect', this.disconnected);
  }

  activate() {
    if (this.closed) return;
    this.active = true;
    this.#schedule();
  }

  snapshot() {
    const connected = Boolean(this.client.ready);
    return {
      status: this.closed ? 'stopped' : connected ? 'connected' : 'reconnecting',
      attempts: connected ? 0 : this.attempts,
      nextRetryAt: connected ? null : this.nextRetryAt,
    };
  }

  #schedule() {
    if (!this.active || this.closed || this.timer !== null || this.flight || this.client.ready) return;
    const delay = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.min(this.attempts, 30));
    this.nextRetryAt = new Date(this.clock.now() + delay).toISOString();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.nextRetryAt = null;
      if (this.closed || !this.active) return;
      if (this.client.ready) { this.attempts = 0; return; }
      // Assign the single flight before start(), which can synchronously emit
      // another disconnect. Business RPCs share CodexClient.start's own lock.
      const operation = Promise.resolve().then(async () => {
        if (this.closed || this.client.ready) return;
        this.attempts++;
        try {
          await this.client.start();
          if (!this.client.ready) throw new Error('Transport initialization did not remain connected');
          this.attempts = 0;
          this.#log('codex_transport_reconnected');
        } catch {
          // Never include raw errors, prompts, authentication, or stderr.
          this.#log('codex_transport_reconnect_failed');
        }
      });
      this.flight = operation;
      operation.finally(() => {
        if (this.flight === operation) this.flight = null;
        this.#schedule();
      }).catch(() => {});
    }, delay);
    this.timer?.unref?.();
  }

  #log(event) {
    try { this.logger?.(event, { attempts: this.attempts }); } catch { /* Observability cannot break reconnect. */ }
  }

  pause() {
    this.closed = true;
    this.active = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
    this.client.off('disconnect', this.disconnected);
  }

  async settled() { await this.flight; }
}
