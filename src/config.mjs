import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'DoubaoCodexGateway', 'data');
export const STATE_DIR = path.resolve(process.env.GATEWAY_STATE_DIR || DEFAULT_STATE_DIR);
export const CONFIG_FILE = path.resolve(process.env.GATEWAY_CONFIG || path.join(path.dirname(STATE_DIR), 'config.local.json'));
export class GatewayError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GatewayError('CONFIG', 'Configuration must be a JSON object.');
  const config = { ...input };
  if (!Array.isArray(config.allowedRoots) || !config.allowedRoots.length) throw new GatewayError('CONFIG', 'Configure at least one allowedRoots entry.');
  const home = fs.realpathSync(os.homedir());
  config.allowedRoots = [...new Set(config.allowedRoots.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new GatewayError('CONFIG', 'Allowed roots must be specific absolute project directories.');
    let real;
    try {
      real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch { throw new GatewayError('CONFIG', 'Every allowed root must be an existing directory.'); }
    if (real === path.parse(real).root || real === home) throw new GatewayError('CONFIG', 'Use a specific project directory, not the filesystem root or your entire home directory.');
    return real;
  }))];
  config.port ??= 18593;
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new GatewayError('CONFIG', 'Invalid port.');
  config.maxConcurrent ??= 1;
  if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 4) throw new GatewayError('CONFIG', 'maxConcurrent must be 1–4.');
  config.codexBin ??= 'codex';
  if (typeof config.codexBin !== 'string' || !config.codexBin.trim() || /[\0\r\n]/.test(config.codexBin)
      || (!path.isAbsolute(config.codexBin) && /[\\/]/.test(config.codexBin))) {
    throw new GatewayError('CONFIG', 'codexBin must be an absolute executable path or a command name on PATH.');
  }
  config.model ??= null;
  if (config.model !== null && (typeof config.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(config.model))) {
    throw new GatewayError('CONFIG', 'model must be a catalog model ID without whitespace, or null to use the Codex default.');
  }
  return config;
}
export function loadConfig() {
  const file = CONFIG_FILE;
  if (!fs.existsSync(file)) throw new GatewayError('NOT_CONFIGURED', 'Run node src/cli.mjs init --allow-root /absolute/project first.');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new GatewayError('CONFIG', 'Configuration cannot be read or is not valid JSON.'); }
  return validateConfig(config);
}
export function workspaceFor(config, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new GatewayError('WORKSPACE', 'workspace must be an existing absolute directory.');
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory() || !config.allowedRoots.some(root => inside(root, real))) throw new GatewayError('WORKSPACE_DENIED', 'Workspace is outside configured allowedRoots.');
  return real;
}
