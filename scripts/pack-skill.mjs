import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = 'doubao-codex-executor';
const source = path.join(root, 'skills', skill);
const files = fs.readdirSync(source);
// The release contains only the reviewed, self-contained Skill, never runtime state.
if (files.length !== 1 || files[0] !== 'SKILL.md') {
  throw new Error('Review and update the package allowlist before adding Skill files.');
}
const content = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
if (!content.startsWith(`---\nname: ${skill}\n`) || !content.includes('\ndescription: ')) {
  throw new Error('Skill frontmatter is missing its expected name or description.');
}
const dist = path.join(root, 'dist');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-skill-package-'));
const archive = `${skill}.zip`;
try {
  execFileSync('zip', ['-q', '-X', path.join(temporary, archive), `${skill}/SKILL.md`], {
    cwd: path.join(root, 'skills'), stdio: 'inherit',
  });
  fs.mkdirSync(dist, {recursive: true});
  fs.copyFileSync(path.join(temporary, archive), path.join(dist, archive));
  const checksum = createHash('sha256').update(fs.readFileSync(path.join(dist, archive))).digest('hex');
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${checksum}  ${archive}\n`);
  console.log(`Created dist/${archive} and dist/SHA256SUMS`);
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
