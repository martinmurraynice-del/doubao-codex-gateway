import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GatewayError } from './config.mjs';

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'gateway.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(workspace TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);`);
    fs.chmodSync(path.join(dir, 'gateway.sqlite'), 0o600);
  }
  all() { return this.db.prepare('SELECT body FROM runs ORDER BY rowid').all().map(row => JSON.parse(row.body)); }
  get(id) {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
    if (!row) throw new GatewayError('NOT_FOUND', 'Unknown task id.');
    return JSON.parse(row.body);
  }
  bindings() { return this.db.prepare('SELECT body FROM bindings ORDER BY workspace').all().map(row => JSON.parse(row.body)); }
  binding(workspace) { const row = this.db.prepare('SELECT body FROM bindings WHERE workspace=?').get(workspace); return row ? JSON.parse(row.body) : null; }
  bind(binding) { this.db.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET body=excluded.body').run(binding.workspace, JSON.stringify(binding)); return binding; }
  byKey(key, fingerprint) {
    const row = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new GatewayError('IDEMPOTENCY_CONFLICT', 'This key has already been used for a different request.');
    return this.get(row.run_id);
  }
  save(run, type = 'state', payload) {
    run.updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, JSON.stringify(run));
      this.event(run.id, type, payload || { status: run.status, review: run.review, attempt: run.attempt, turnId: run.turnId, error: run.error });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return run;
  }
  create(run, key, fingerprint) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.byKey(key, fingerprint);
      if (previous) { this.db.exec('COMMIT'); return previous; }
      this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, fingerprint, run.id);
      this.db.prepare('INSERT INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run));
      this.event(run.id, 'state', {status:run.status,attempt:run.attempt});
      this.db.exec('COMMIT');
      return run;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rework(run, key, fingerprint) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, fingerprint, run.id);
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
      this.event(run.id, 'rework', {attempt:run.attempt,feedback:run.feedback});
      this.db.exec('COMMIT'); return run;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id, type, body) {
    return Number(this.db.prepare('INSERT INTO events(run_id,type,body,created_at) VALUES(?,?,?,?)').run(id,type,JSON.stringify(body),new Date().toISOString()).lastInsertRowid);
  }
  events(id, after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(row=>({seq:row.seq,id:row.run_id,type:row.type,data:JSON.parse(row.body),createdAt:row.created_at}));
  }
  cursor(id) { return this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE run_id=?').get(id).seq || 0; }
  close() { this.db.close(); }
}
