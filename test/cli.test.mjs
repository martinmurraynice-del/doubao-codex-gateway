import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateConfig } from '../src/config.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(project, 'src', 'cli.mjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-cli-test-')));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const stateDir = path.join(root, 'gateway', 'data');
  const configFile = path.join(root, 'gateway', 'config.local.json');
  const env = { ...process.env, GATEWAY_STATE_DIR: stateDir, GATEWAY_CONFIG: configFile };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args, overrides = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
  });
  return { root, workspace, stateDir, configFile, env, run };
}

function readResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('init creates private, portable config and keeps model unspecified by default', (t) => {
  const f = fixture(t);
  const result = readResult(f.run(['init', '--allow-root', f.workspace]));
  assert.equal(result.file, f.configFile);
  assert.equal(result.model, null);
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.deepEqual(config.allowedRoots, [f.workspace]);
  assert.equal(config.model, null);
  assert.equal(config.codexBin, 'codex');
  assert.equal(config.port, 18593);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o700);
  }
  const again = f.run(['init', '--allow-root', f.workspace]);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stderr).error.code, 'CONFIG_EXISTS');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), config);
});

test('init persists an explicit catalog model and canonicalizes repeated workspace roots', (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, 'project-alias');
  fs.symlinkSync(f.workspace, alias, 'dir');
  const result = readResult(f.run(['init', '--allow-root', f.workspace, '--allow-root', alias,
    '--model', 'catalog-model-example', '--port', '19371', '--codex-bin', process.execPath]));
  assert.equal(result.model, 'catalog-model-example');
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.deepEqual(config.allowedRoots, [f.workspace]);
  assert.equal(config.model, 'catalog-model-example');
  assert.equal(config.port, 19371);
  assert.equal(config.codexBin, process.execPath);
});

test('relative configuration and state environment paths become absolute diagnostics', (t) => {
  const f = fixture(t);
  const relativeEnv = { GATEWAY_CONFIG: 'settings/custom.json', GATEWAY_STATE_DIR: 'private/data' };
  const result = readResult(f.run(['init', '--allow-root', f.workspace], relativeEnv));
  assert.equal(result.file, path.join(f.root, 'settings', 'custom.json'));
  const paths = readResult(f.run(['paths'], relativeEnv));
  assert.equal(paths.configFile, result.file);
  assert.equal(paths.stateDir, path.join(f.root, 'private', 'data'));
  assert.equal(paths.serviceLabel, 'io.github.doubao-codex-gateway');
  const connector = readResult(f.run(['connector-config'], relativeEnv));
  assert.equal(connector.env.GATEWAY_STATE_DIR, paths.stateDir);
});

test('invalid or incomplete init options never write config or state', (t) => {
  const f = fixture(t);
  const invalid = [
    [], ['--allow-root'], ['--allow-root', 'relative/project'],
    ['--allow-root', path.join(f.root, 'missing')],
    ['--allow-root', f.workspace, '--unknown', 'value'],
    ['--allow-root', f.workspace, '--model'],
    ['--allow-root', f.workspace, '--model', 'Display Name With Spaces'],
    ['--allow-root', f.workspace, '--model', ''],
    ['--allow-root', f.workspace, '--port', '1e4'],
    ['--allow-root', f.workspace, '--port', '1023'],
    ['--allow-root', f.workspace, '--port', '65536'],
    ['--allow-root', f.workspace, '--port', '19371', '--port', '19372'],
    ['--allow-root', f.workspace, '--codex-bin', './relative-codex'],
  ];
  for (const args of invalid) {
    const result = f.run(['init', ...args]);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).error.code, 'INPUT', result.stderr);
    assert.equal(fs.existsSync(f.configFile), false);
    assert.equal(fs.existsSync(f.stateDir), false);
  }
});

test('filesystem and home roots are refused, including symlink aliases', (t) => {
  const f = fixture(t);
  const homeAlias = path.join(f.root, 'home-alias');
  fs.symlinkSync(os.homedir(), homeAlias, 'dir');
  const file = path.join(f.root, 'not-a-directory');
  fs.writeFileSync(file, 'test');
  for (const workspace of [path.parse(f.root).root, os.homedir(), homeAlias, file]) {
    const result = f.run(['init', '--allow-root', workspace]);
    assert.equal(result.status, 1, workspace);
    assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
    assert.equal(fs.existsSync(f.configFile), false);
  }
  assert.throws(() => validateConfig({ allowedRoots: [homeAlias] }), { code: 'CONFIG' });
  for (const stateDir of [path.parse(f.root).root, os.homedir(), homeAlias]) {
    const result = f.run(['init', '--allow-root', f.workspace], { GATEWAY_STATE_DIR: stateDir });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
    assert.equal(fs.existsSync(f.configFile), false);
  }
});

test('connector config honors installed runtime, Node path, and historical service label metadata', (t) => {
  const f = fixture(t);
  const runtime = path.join(f.root, 'deployment');
  const skill = path.join(runtime, 'skills', 'doubao-codex-executor', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'fixture skill');
  fs.mkdirSync(path.dirname(f.stateDir), { recursive: true });
  const manifest = path.join(path.dirname(f.stateDir), 'installation.json');
  fs.writeFileSync(manifest, JSON.stringify({ runtime, source: project,
    nodeBin: process.execPath, serviceLabel: 'org.example.existing-gateway' }));
  const connector = readResult(f.run(['connector-config']));
  assert.equal(connector.command, process.execPath);
  assert.deepEqual(connector.args, [path.join(runtime, 'src', 'mcp.mjs')]);
  assert.deepEqual(connector.env, { GATEWAY_STATE_DIR: f.stateDir });
  assert.equal(connector.skill, skill);
  const paths = readResult(f.run(['paths']));
  assert.equal(paths.serviceLabel, 'org.example.existing-gateway');
  assert.equal(paths.runtime, runtime);
  if (process.platform === 'darwin') assert.ok(paths.launchAgentPlist.endsWith('org.example.existing-gateway.plist'));
  assert.equal(fs.existsSync(f.stateDir), false, 'Read-only diagnostics must not create state');
});

test('legacy metadata without a service label uses the neutral default and source Skill fallback', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateDir), { recursive: true });
  const runtime = path.join(f.root, 'old-deployment');
  fs.writeFileSync(path.join(path.dirname(f.stateDir), 'installation.json'), JSON.stringify({ runtime, source: project }));
  const connector = readResult(f.run(['connector-config']));
  assert.equal(connector.skill, path.join(project, 'skills', 'doubao-codex-executor', 'SKILL.md'));
  assert.equal(readResult(f.run(['paths'])).serviceLabel, 'io.github.doubao-codex-gateway');
});

test('malformed installation records fail instead of silently selecting a wrong runtime or service', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateDir), { recursive: true });
  const manifest = path.join(path.dirname(f.stateDir), 'installation.json');
  for (const record of ['not JSON', { runtime: './relative' }, { runtime: f.root, serviceLabel: '../other-service' }]) {
    fs.writeFileSync(manifest, typeof record === 'string' ? record : JSON.stringify(record));
    const result = f.run(['connector-config']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INSTALLATION');
  }
});

test('unknown commands and unexpected positional arguments return input errors', (t) => {
  const f = fixture(t);
  for (const args of [['does-not-exist'], ['connector-config', 'extra'], ['paths', '--unexpected'], ['call']]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INPUT');
  }
  const help = f.run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--model CATALOG_ID/);
});

test('configuration loader validation rejects malformed model and executable settings', (t) => {
  const f = fixture(t);
  for (const options of [{ model: 'display name' }, { model: 123 }, { codexBin: './codex' }, { codexBin: '' }, { maxConcurrent: 0 }, { port: '18593' }]) {
    assert.throws(() => validateConfig({ allowedRoots: [f.workspace], ...options }), { code: 'CONFIG' });
  }
  assert.equal(validateConfig({ allowedRoots: [f.workspace], model: null }).model, null);
});
