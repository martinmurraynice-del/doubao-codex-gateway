import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: root, encoding: 'utf8'}).trim();
if (fs.realpathSync(gitRoot) !== fs.realpathSync(root)) {
  throw new Error('Run release checks in the standalone gateway Git repository, not its parent.');
}
const files = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
const required = ['README.md', 'LICENSE', 'config.example.json', 'package-lock.json',
  'skills/doubao-codex-executor/SKILL.md', 'docs/architecture.md', 'docs/tools.md',
  'docs/troubleshooting.md', 'docs/verification.md', 'docs/release-checklist.md'];
const problems = required.filter(file => !files.includes(file)).map(file => `Missing tracked file: ${file}`);
const privateFile = /(^|\/)(node_modules|data|dist|smoke-workspace)(\/|$)|(^|\/)(config\.local\.json|connection\.json|installation\.json|token|\.env(?:\..*)?)$|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|pem|key|zip)$/i;
const privateContent = [
  [/\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//, 'machine-specific home path'],
  [/dcg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'real-looking task identifier'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/, 'GitHub credential'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, 'API credential'],
];
for (const file of files) {
  if (privateFile.test(file)) problems.push(`Private/generated file is tracked: ${file}`);
  const target = path.join(root, file);
  if (!fs.existsSync(target)) { problems.push(`Tracked file is missing: ${file}`); continue; }
  if (fs.lstatSync(target).isSymbolicLink()) { problems.push(`Review symlink before release: ${file}`); continue; }
  const content = fs.readFileSync(target, 'utf8');
  for (const [pattern, label] of privateContent) {
    if (pattern.test(content)) problems.push(`${file}: ${label}`);
  }
  if (file.endsWith('.md')) {
    for (const [, destination] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(destination)) continue;
      const local = path.resolve(path.dirname(target), decodeURIComponent(destination.split('#')[0]));
      if (!fs.existsSync(local)) problems.push(`${file}: broken relative link ${destination}`);
    }
  }
}
if (problems.length) throw new Error(`Release checks failed:\n${problems.join('\n')}`);
console.log(`Release checks passed for ${files.length} tracked files (heuristic privacy and documentation checks; not a security audit).`);
