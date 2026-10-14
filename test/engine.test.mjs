import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

class FakeCodex extends EventEmitter {
  constructor(threads = new Map()) {
    super();
    this.threads = threads;
    this.calls = [];
    this.ready = false;
    this.sequence = 0;
  }
  async start() { this.ready = true; return {}; }
  async stop() { this.ready = false; }
  respond() {}
  reject() {}
  count(method) { return this.calls.filter((call) => call.method === method).length; }
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'thread/start') {
      const thread = { id: `thread-${this.threads.size + 1}`, cwd: params.cwd, turns: [] };
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread) };
    }
    if (method === 'thread/resume' || method === 'thread/read') {
      const thread = this.threads.get(params.threadId);
      if (!thread) throw new Error('Thread not found');
      if(this.rejectEmptyRollouts&&!thread.turns.length) {
        const error=new Error(`no rollout found for thread id ${params.threadId}`);
        error.code=-32600;
        throw error;
      }
      return { thread: structuredClone(thread) };
    }
    if (method === 'turn/start') {
      const thread = this.threads.get(params.threadId);
      const turn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [], error: null };
      thread.turns.push(turn);
      if (this.onTurnStart) await this.onTurnStart({ thread, turn });
      return { turn: structuredClone(turn) };
    }
    if (method === 'turn/interrupt') return {};
    if (method === 'model/list') return { data: [], nextCursor: null };
    throw new Error(`Unhandled test method: ${method}`);
  }
  complete(threadId, turnId, text = 'Task finished.') {
    const turn = this.threads.get(threadId).turns.find((item) => item.id === turnId);
    assert.ok(turn, `Known test turn ${turnId}`);
    turn.status = 'completed';
    const report = typeof text === 'string' ? { status: 'completed', text, artifacts: [], data: null } : text;
    turn.items = [{ type: 'agentMessage', id: `message-${turnId}`, text: JSON.stringify(report), phase: 'final_answer' }];
    this.emit('notification', {
      method: 'turn/completed', params: { threadId, turn: structuredClone(turn) },
    });
  }
}

function setup(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-engine-test-')));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(root, 'state'));
  const client = new FakeCodex();
  const config = { allowedRoots: [workspace], maxConcurrent: 1, model: null, ...options };
  const engine = new Engine({ store, client, config });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, store, client, config, engine };
}

async function until(check, description = 'state transition') {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function input(workspace, suffix = 'one') {
  return { workspace, task: `Create the requested output ${suffix}.`, idempotencyKey: `submit-${suffix}` };
}

test('submission is durable and idempotent; conflicting payloads are rejected', async (t) => {
  const { engine, store, workspace, client } = setup(t);
  const args = input(workspace);
  const first = await engine.submit(args);
  const replay = await engine.submit(args);
  assert.equal(first.id, replay.id);
  assert.equal(store.all().length, 1);
  await assert.rejects(async () => engine.submit({ ...args, task: 'A different task' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await engine.tick();
  await until(() => engine.get(first.id).turnId);
  assert.equal(client.count('turn/start'), 1);
  assert.ok(store.events(first.id).length > 0);
});

test('same workspace queues tasks serially, preserving the thread', async (t) => {
  const { engine, workspace, client } = setup(t, { maxConcurrent: 2 });
  const first = await engine.submit(input(workspace, 'first'));
  const second = await engine.submit(input(workspace, 'second'));
  await engine.tick();
  await until(() => engine.get(first.id).turnId);
  assert.equal(client.count('turn/start'), 1);
  assert.equal(engine.get(second.id).status, 'queued');
  const running = engine.get(first.id);
  client.complete(running.threadId, running.turnId);
  await until(() => engine.get(first.id).status === 'completed');
  await engine.tick();
  await until(() => engine.get(second.id).turnId);
  assert.equal(client.count('turn/start'), 2);
  assert.equal(engine.get(second.id).threadId, running.threadId);
});

test('disconnect after dispatch becomes uncertain and never replays work', async (t) => {
  const { engine, workspace, client } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  await until(() => engine.get(run.id).turnId);
  client.emit('disconnect', { code: 1, expected: false });
  await until(() => engine.get(run.id).status === 'uncertain');
  await engine.tick();
  await engine.tick();
  const replay = await engine.submit(input(workspace));
  assert.equal(replay.id, run.id);
  assert.equal(client.count('turn/start'), 1);
  assert.equal(engine.get(run.id).status, 'uncertain');
});

test('restart and recovery inspect the saved turn without dispatching another turn', async (t) => {
  const { engine, workspace, client, store, config } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  await until(() => engine.get(run.id).turnId);
  const running = engine.get(run.id);
  const nextClient = new FakeCodex(client.threads);
  const restarted = new Engine({ store, client: nextClient, config });
  await restarted.restore();
  await restarted.recover({ id: run.id, note: 'Process restarted; inspect saved turn only.' });
  assert.equal(nextClient.count('turn/start'), 0);
  assert.equal(restarted.get(run.id).threadId, running.threadId);
  assert.equal(restarted.get(run.id).turnId, running.turnId);
  assert.ok(nextClient.count('thread/read') > 0);
});

test('rework uses the same run and thread, and ignores late events from the old turn', async (t) => {
  const { engine, workspace, client } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  await until(() => engine.get(run.id).turnId);
  const first = engine.get(run.id);
  client.complete(first.threadId, first.turnId, 'First result');
  await until(() => engine.get(run.id).status === 'completed');
  const args = { id: run.id, feedback: 'The output is missing its required title.', idempotencyKey: 'rework-one' };
  await engine.rework(args);
  await engine.rework(args);
  await engine.tick();
  await until(() => engine.get(run.id).turnId && engine.get(run.id).turnId !== first.turnId);
  const second = engine.get(run.id);
  assert.equal(second.id, first.id);
  assert.equal(second.threadId, first.threadId);
  assert.equal(client.count('turn/start'), 2);
  client.complete(first.threadId, first.turnId, 'Late old result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.get(run.id).turnId, second.turnId);
  assert.notEqual(engine.get(run.id).status, 'completed');
  client.complete(second.threadId, second.turnId, 'Corrected result');
  await until(() => engine.get(run.id).status === 'completed');
});

test('completion needs separate acceptance; outside-workspace symlinks cannot be evidence', async (t) => {
  const { engine, root, workspace, client } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  await until(() => engine.get(run.id).turnId);
  const running = engine.get(run.id);
  await assert.rejects(async () => engine.accept({ id: run.id, evidence: 'Not finished yet' }));
  client.complete(running.threadId, running.turnId);
  await until(() => engine.get(run.id).status === 'completed');
  assert.notEqual(engine.get(run.id).review, 'accepted');
  const outside = path.join(root, 'private.txt');
  fs.writeFileSync(outside, 'Not a project artifact');
  const link = path.join(workspace, 'escape.txt');
  fs.symlinkSync(outside, link);
  await assert.rejects(async () => engine.accept({ id: run.id, evidence: 'Read output', artifactPaths: [link] }));
  const artifact = path.join(workspace, 'output.txt');
  fs.writeFileSync(artifact, 'Reviewed project result');
  await engine.accept({ id: run.id, evidence: 'Opened output.txt and checked its required content.', artifactPaths: [artifact] });
  assert.equal(engine.get(run.id).status, 'completed');
  assert.equal(engine.get(run.id).review, 'accepted');
});

test('late completion from an old attempt is ignored before the new start reply arrives', async (t) => {
  const { engine, workspace, client } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  const first = engine.get(run.id);
  client.complete(first.threadId, first.turnId, 'First attempt');
  await engine.rework({ id: run.id, feedback: 'Repair the first attempt.', idempotencyKey: 'late-rework' });
  client.onTurnStart = () => client.complete(first.threadId, first.turnId, 'Delayed event for old attempt');
  await engine.tick();
  const second = engine.get(run.id);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(second.status, 'running');
  assert.equal(second.holdsCapacity, true);
});

test('simultaneous retries with one idempotency key return the same task', async (t) => {
  const { engine, workspace, store, client } = setup(t);
  const args = input(workspace);
  const runs = await Promise.all([engine.submit(args), engine.submit(args)]);
  assert.equal(runs[0].id, runs[1].id);
  assert.equal(store.all().length, 1);
  await engine.tick();
  assert.equal(client.count('turn/start'), 1);
});

test('lost start reply preserves uncertainty even with no recorded turn id', async (t) => {
  const { engine, workspace, client } = setup(t);
  client.onTurnStart = () => {
    const error = new Error('Transport lost the start reply');
    error.code = 'RPC_TIMEOUT';
    error.sent = true;
    throw error;
  };
  const run = await engine.submit(input(workspace));
  await engine.tick();
  assert.equal(engine.get(run.id).status, 'uncertain');
  assert.equal(engine.get(run.id).turnId, null);
  await engine.restore();
  await engine.recover({ id: run.id, note: 'Inspect the uncertain start reply.' });
  await engine.tick();
  assert.equal(engine.get(run.id).status, 'uncertain');
  assert.equal(engine.get(run.id).holdsCapacity, true);
  assert.equal(client.count('turn/start'), 1);
});

test('Codex final reports cannot export artifacts through an escaping symlink', async (t) => {
  const { engine, workspace, root, client } = setup(t);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'Outside workspace');
  fs.symlinkSync(outside, path.join(workspace, 'reported-output.txt'));
  const run = await engine.submit({ ...input(workspace), output: 'artifacts' });
  await engine.tick();
  const running = engine.get(run.id);
  client.complete(running.threadId, running.turnId, {
    status: 'completed', text: 'Produced file', artifacts: ['reported-output.txt'], data: null,
  });
  assert.equal(engine.get(run.id).status, 'failed');
  assert.equal(engine.get(run.id).error.code, 'INVALID_OUTPUT');
  assert.notEqual(engine.get(run.id).review, 'accepted');
});

test('cancellation keeps execution capacity reserved until interruption is confirmed', async (t) => {
  const { engine, workspace, client } = setup(t);
  const first = await engine.submit(input(workspace, 'active'));
  const second = await engine.submit(input(workspace, 'queued'));
  await engine.tick();
  const running = engine.get(first.id);
  await engine.cancel(first.id);
  assert.equal(engine.get(first.id).status, 'cancel_requested');
  assert.equal(engine.get(first.id).holdsCapacity, true);
  await engine.tick();
  assert.equal(engine.get(second.id).status, 'queued');
  assert.equal(client.count('turn/start'), 1);
  client.threads.get(running.threadId).turns[0].status = 'interrupted';
  client.emit('notification', {
    method: 'turn/completed', params: { threadId: running.threadId, turn: { id: running.turnId, status: 'interrupted', items: [] } },
  });
  assert.equal(engine.get(first.id).status, 'cancelled');
  assert.equal(engine.get(first.id).holdsCapacity, false);
  await engine.tick();
  assert.equal(client.count('turn/start'), 2);
});

test('old events from an earlier task cannot complete the next task in the same thread', async (t) => {
  const { engine, workspace, client } = setup(t);
  const first = await engine.submit(input(workspace, 'previous'));
  const next = await engine.submit(input(workspace, 'next'));
  await engine.tick();
  const previous = engine.get(first.id);
  client.complete(previous.threadId, previous.turnId, 'Previous task output');
  client.onTurnStart = () => client.complete(previous.threadId, previous.turnId, 'Delayed previous task output');
  await engine.tick();
  assert.equal(engine.get(next.id).status, 'running');
  assert.notEqual(engine.get(next.id).turnId, previous.turnId);
  assert.equal(engine.get(next.id).result, null);
});

test('changing a binding model resumes its existing thread instead of creating another', async (t) => {
  const { engine, workspace, client } = setup(t);
  const original = await engine.bindWorkspace({ workspace, model: 'model-a' });
  const seed=await engine.submit(input(workspace,'seed'));
  await engine.tick();
  client.complete(original.threadId,engine.get(seed.id).turnId);
  const changed = await engine.bindWorkspace({ workspace, model: 'model-b' });
  assert.equal(changed.threadId, original.threadId);
  assert.equal(changed.model, 'model-b');
  assert.equal(client.count('thread/start'), 1);
  assert.equal(client.calls.findLast((call) => call.method === 'thread/resume').params.model, 'model-b');
});

test('a persisted interrupted binding creation never starts a duplicate thread', async (t) => {
  const { engine, workspace, store, client } = setup(t);
  store.bind({ workspace, status: 'creating', threadId: null, model: null });
  await assert.rejects(engine.bindWorkspace({ workspace }), { code: 'BINDING_UNCERTAIN' });
  await assert.rejects(engine.submit(input(workspace)), { code: 'BINDING_UNCERTAIN' });
  assert.equal(client.count('thread/start'), 0);
});

test('external active turns reserve capacity without being claimed, cancelled, or resumed on recovery', async (t) => {
  const { engine, workspace, client } = setup(t);
  const binding = await engine.bindWorkspace({ workspace });
  client.threads.get(binding.threadId).turns.push({ id: 'external-turn', status: 'inProgress', items: [] });
  const first = await engine.submit(input(workspace, 'blocked'));
  const next = await engine.submit(input(workspace, 'waiting'));
  await engine.tick();
  assert.equal(engine.get(first.id).error.code, 'THREAD_BUSY');
  assert.equal(engine.get(first.id).holdsCapacity, true);
  assert.equal(engine.get(first.id).turnId, null);
  assert.equal(client.count('turn/start'), 0);
  const resumesBeforeRecovery = client.count('thread/resume');
  await engine.recover({ id: first.id, note: 'Inspect external turn state.' });
  assert.equal(client.count('thread/resume'), resumesBeforeRecovery);
  assert.equal(engine.get(first.id).holdsCapacity, true);
  await engine.cancel(first.id);
  assert.equal(client.count('turn/interrupt'), 0);
  client.complete(binding.threadId, 'external-turn', 'External work must not become our result');
  assert.equal(engine.get(first.id).result, null);
  assert.equal(engine.get(first.id).holdsCapacity, true);
  await engine.recover({ id: first.id, note: 'External turn finished; inspect exact turn.' });
  assert.equal(engine.get(first.id).status, 'blocked');
  assert.equal(engine.get(first.id).holdsCapacity, false);
  assert.equal(engine.get(first.id).result, null);
  await engine.tick();
  assert.equal(engine.get(next.id).status, 'running');
  assert.equal(client.count('turn/start'), 1);
});

test('strict final output envelope still returns arbitrary JSON data to the caller', async (t) => {
  const { engine, workspace, client } = setup(t);
  const run = await engine.submit({ ...input(workspace), output: 'json' });
  await engine.tick();
  const start = client.calls.find((call) => call.method === 'turn/start');
  assert.equal(start.params.outputSchema.additionalProperties, false);
  assert.deepEqual(start.params.outputSchema.required, ['status', 'text', 'artifacts', 'data']);
  const value = { anything: ['nested', { count: 3 }], enabled: true };
  const running = engine.get(run.id);
  client.complete(running.threadId, running.turnId, {
    status: 'completed', text: 'Structured result', artifacts: [], data: JSON.stringify(value),
  });
  assert.equal(engine.get(run.id).status, 'completed');
  assert.deepEqual(engine.get(run.id).result.data, value);
});

test('long polling releases promptly on shutdown so the SQLite store can close', async (t) => {
  const { engine, workspace } = setup(t);
  const run = await engine.submit(input(workspace));
  await engine.tick();
  const waiting = engine.wait({ id: run.id, timeoutSeconds: 30 });
  setTimeout(() => { engine.closing = true; }, 10);
  const result = await waiting;
  assert.equal(result.shuttingDown, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.run.id, run.id);
});

test('fresh empty Codex threads dispatch directly before any rollout exists', async (t) => {
  const { engine, workspace, client } = setup(t);
  client.rejectEmptyRollouts=true;
  const run=await engine.submit(input(workspace));
  await engine.tick();
  assert.equal(engine.get(run.id).status,'running');
  assert.equal(client.count('thread/start'),1);
  assert.equal(client.count('thread/resume'),0);
  assert.equal(client.count('turn/start'),1);
  const running=engine.get(run.id);
  client.complete(running.threadId,running.turnId);
  await engine.rework({id:run.id,feedback:'Add verification evidence.',idempotencyKey:'fresh-rework'});
  await engine.tick();
  assert.equal(client.count('thread/resume'),1);
  assert.equal(client.count('thread/start'),1);
});

test('model changes before a fresh thread first turn take effect without resume', async (t) => {
  const { engine, workspace, client } = setup(t);
  client.rejectEmptyRollouts=true;
  const original=await engine.bindWorkspace({workspace,model:'model-a'});
  const changed=await engine.bindWorkspace({workspace,model:'model-b'});
  assert.equal(changed.threadId,original.threadId);
  await engine.submit(input(workspace));
  await engine.tick();
  assert.equal(client.calls.find(call=>call.method==='turn/start').params.model,'model-b');
  assert.equal(client.count('thread/start'),1);
});

test('restart can replace a lost empty thread only when no dispatch intent ever existed', async (t) => {
  const { engine, workspace, client, store, config } = setup(t);
  client.rejectEmptyRollouts=true;
  const run=await engine.submit(input(workspace));
  const previousThread=run.threadId;
  const nextClient=new FakeCodex(client.threads);
  nextClient.rejectEmptyRollouts=true;
  const restarted=new Engine({store,client:nextClient,config});
  await restarted.restore();
  await restarted.tick();
  const running=restarted.get(run.id);
  assert.equal(running.status,'running');
  assert.notEqual(running.threadId,previousThread);
  assert.equal(nextClient.count('thread/start'),1);
  assert.equal(nextClient.count('turn/start'),1);
  assert.equal(store.binding(workspace).threadId,running.threadId);
});

test('missing rollout after any durable dispatch intent never creates or submits a replacement', async (t) => {
  const { engine, workspace, client, store, config } = setup(t);
  const run=await engine.submit(input(workspace));
  store.save({...store.get(run.id),status:'queued',dispatchStartedAt:new Date().toISOString()});
  const nextClient=new FakeCodex(client.threads);
  nextClient.rejectEmptyRollouts=true;
  const restarted=new Engine({store,client:nextClient,config});
  await restarted.tick();
  assert.equal(restarted.get(run.id).status,'blocked');
  assert.equal(restarted.get(run.id).error.code,'EMPTY_THREAD_NOT_PERSISTED');
  assert.equal(nextClient.count('thread/start'),0);
  assert.equal(nextClient.count('turn/start'),0);
});
