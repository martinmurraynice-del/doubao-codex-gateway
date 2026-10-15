import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const sourceLauncher = fileURLToPath(new URL('../src/installed-mcp.mjs', import.meta.url));

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao installed mcp ')));
  const installationRoot = path.join(root, 'gateway');
  const stateDir = path.join(installationRoot, 'data');
  const launcher = path.join(installationRoot, 'bin', 'mcp.mjs');
  const manifest = path.join(installationRoot, 'installation.json');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(stateDir);
  fs.copyFileSync(sourceLauncher, launcher);
  fs.writeFileSync(path.join(stateDir, 'token'), 'PRIVATE_LAUNCHER_TOKEN_SENTINEL');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = (name, program) => {
    const dir = path.join(installationRoot, 'deployments', name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'mcp.mjs'), program ?? `
      import fs from 'node:fs';
      process.stdout.write(JSON.stringify({generation:${JSON.stringify(name)},stateDir:process.env.GATEWAY_STATE_DIR,
        cwd:process.cwd(),input:fs.readFileSync(0,'utf8')}));
    `);
    return dir;
  };
  const writeManifest = (record) => fs.writeFileSync(manifest, typeof record === 'string' ? record : JSON.stringify(record));
  const run = ({ input = 'MCP_REQUEST\n', stateEnv = stateDir } = {}) => {
    const env = { ...process.env };
    if (stateEnv === null) delete env.GATEWAY_STATE_DIR;
    else env.GATEWAY_STATE_DIR = stateEnv;
    return spawnSync(process.execPath, [launcher], { cwd: root, env, input, encoding: 'utf8', timeout: 5000 });
  };
  return { root, installationRoot, stateDir, launcher, manifest, runtime, writeManifest, run };
}

test('standalone launcher selects the latest deployment at each start and preserves STDIO/state environment', (t) => {
  const f = setup(t);
  const first = f.runtime('first');
  f.writeManifest({ runtime: first, nodeBin: process.execPath });
  const before = fs.readFileSync(f.launcher, 'utf8');
  const initial = f.run();
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), { generation: 'first', stateDir: f.stateDir, cwd: first, input: 'MCP_REQUEST\n' });
  const second = f.runtime('second');
  f.writeManifest({ runtime: second, nodeBin: process.execPath });
  const upgraded = f.run({ input: 'NEXT_REQUEST\n' });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.deepEqual(JSON.parse(upgraded.stdout), { generation: 'second', stateDir: f.stateDir, cwd: second, input: 'NEXT_REQUEST\n' });
  assert.equal(fs.readFileSync(f.launcher, 'utf8'), before, 'Deployments must not require changing the connector entrypoint');
  assert.equal(initial.stderr + upgraded.stderr, '');
  assert.ok(!(initial.stdout + upgraded.stdout).includes('PRIVATE_LAUNCHER_TOKEN_SENTINEL'));
});

test('legacy manifests work without Node metadata and the copied launcher resolves default state beside itself', (t) => {
  const f = setup(t);
  const runtime = f.runtime('legacy');
  f.writeManifest({ runtime, source: f.root });
  const result = f.run({ stateEnv: null });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stateDir, f.stateDir);
  assert.equal(JSON.parse(result.stdout).generation, 'legacy');
});

test('invalid metadata fails closed without starting its program or printing sensitive contents', (t) => {
  const f = setup(t);
  const runtime = f.runtime('safe');
  const cases = [
    'PRIVATE_LAUNCHER_TOKEN_SENTINEL not JSON',
    { runtime: '../PRIVATE_LAUNCHER_TOKEN_SENTINEL' },
    { runtime: f.root },
    { runtime, nodeBin: '/missing/PRIVATE_LAUNCHER_TOKEN_SENTINEL' },
    { runtime: path.join(f.installationRoot, 'deployments', 'missing') },
    { runtime, nodeBin: 'relative/node' },
    null,
  ];
  for (const record of cases) {
    f.writeManifest(record);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Installed MCP entrypoint is unavailable/);
    assert.ok(!result.stderr.includes('PRIVATE_LAUNCHER_TOKEN_SENTINEL'));
  }
  fs.unlinkSync(f.manifest);
  const missing = f.run();
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
});

test('runtime and MCP entrypoint cannot escape deployment directories through symlinks', (t) => {
  const f = setup(t);
  const runtime = f.runtime('safe');
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'src', 'mcp.mjs'), 'process.stdout.write("ESCAPED_RUNTIME");');
  const alias = path.join(f.installationRoot, 'deployments', 'escape');
  fs.symlinkSync(outside, alias, 'dir');
  f.writeManifest({ runtime: alias });
  assert.equal(f.run().status, 1);
  const entry = path.join(runtime, 'src', 'mcp.mjs');
  fs.unlinkSync(entry);
  fs.symlinkSync(path.join(outside, 'src', 'mcp.mjs'), entry);
  f.writeManifest({ runtime });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('launcher returns child failure status instead of reporting a healthy connection', (t) => {
  const f = setup(t);
  const runtime = f.runtime('failure', 'process.exitCode = 7;');
  f.writeManifest({ runtime });
  const result = f.run();
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
});

test('launcher forwards termination to its MCP child', async (t) => {
  const f = setup(t);
  const runtime = f.runtime('persistent', 'process.stdout.write(`${process.pid}\\n`); setInterval(()=>{},1000);');
  f.writeManifest({ runtime });
  const child = spawn(process.execPath, [f.launcher], { env: { ...process.env, GATEWAY_STATE_DIR: f.stateDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Launcher child did not start')), 3000);
    child.stdout.once('data', (data) => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
    child.once('error', reject);
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 143);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
