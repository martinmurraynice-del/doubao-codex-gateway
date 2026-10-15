#!/usr/bin/env node
// This file is copied verbatim to <installation-root>/bin/mcp.mjs. Keep it
// independent of the deployed source tree and third-party dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launcherFile = fileURLToPath(import.meta.url);
const invalid = () => Object.assign(new Error('Installed MCP metadata or runtime is invalid. Repair the gateway installation before reconnecting.'), { code: 'INSTALLATION' });
const absolutePath = (value) => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

export function resolveInstalledMcp({
  stateDir = process.env.GATEWAY_STATE_DIR || path.join(path.dirname(path.dirname(launcherFile)), 'data'),
} = {}) {
  try {
    if (typeof stateDir !== 'string' || /[\0\r\n]/.test(stateDir)) throw invalid();
    stateDir = path.resolve(stateDir);
    const installationRoot = path.dirname(stateDir);
    const manifest = path.join(installationRoot, 'installation.json');
    const manifestStat = fs.lstatSync(manifest);
    if (!manifestStat.isFile() || manifestStat.size > 64 * 1024) throw invalid();
    const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || !absolutePath(record.runtime)
        || (record.nodeBin !== undefined && !absolutePath(record.nodeBin))) throw invalid();
    const root = fs.realpathSync(installationRoot);
    const deployments = fs.realpathSync(path.join(installationRoot, 'deployments'));
    const runtime = fs.realpathSync(record.runtime);
    if (!inside(root, deployments) || !inside(deployments, runtime) || !fs.statSync(runtime).isDirectory()) throw invalid();
    const mcpPath = fs.realpathSync(path.join(runtime, 'src', 'mcp.mjs'));
    if (!inside(runtime, mcpPath) || !fs.statSync(mcpPath).isFile()) throw invalid();
    const nodeBin = fs.realpathSync(record.nodeBin || process.execPath);
    if (!fs.statSync(nodeBin).isFile()) throw invalid();
    fs.accessSync(nodeBin, fs.constants.X_OK);
    return { stateDir, runtime, mcpPath, nodeBin, installationFile: manifest };
  } catch {
    // Never print manifest contents, arbitrary filesystem errors, tokens, or
    // credential-bearing environment values while diagnosing a broken entry.
    throw invalid();
  }
}

export async function runInstalledMcp(options) {
  const installed = resolveInstalledMcp(options);
  return new Promise((resolve, reject) => {
    const child = spawn(installed.nodeBin, [installed.mcpPath], {
      cwd: installed.runtime,
      env: { ...process.env, GATEWAY_STATE_DIR: installed.stateDir },
      stdio: 'inherit',
      windowsHide: true,
    });
    const forward = (signal) => { if (!child.killed) child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', () => { cleanup(); reject(invalid()); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? (128 + (os.constants.signals[signal] || 1)));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runInstalledMcp().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Installed MCP entrypoint is unavailable. Check gateway installation metadata and runtime files.\n');
    process.exitCode = 1;
  });
}
