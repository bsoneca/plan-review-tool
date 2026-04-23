const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function sha256(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function planTarget(planPath) {
  const abs = path.resolve(planPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Plan file not found: ${abs}`);
  }
  return { kind: 'plan', path: abs };
}

function readPlan(target) {
  const content = fs.readFileSync(target.path, 'utf8');
  return {
    path: target.path,
    content,
    sha256: sha256(content),
    lines: content.split('\n').length,
  };
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function findRepoRoot(cwd = process.cwd()) {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}

function resolveRef(repoRoot, ref) {
  try {
    return git(repoRoot, ['rev-parse', '--verify', ref]).trim();
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

function listDiffFiles(repoRoot, base, head) {
  const args = ['diff', '--name-status', '--no-renames'];
  if (head === 'WORKING') {
    args.push(base);
  } else {
    args.push(`${base}..${head}`);
  }
  const out = git(repoRoot, args);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const code = line.slice(0, tab);
    const filePath = line.slice(tab + 1);
    let status;
    switch (code[0]) {
      case 'A': status = 'added'; break;
      case 'D': status = 'deleted'; break;
      case 'M': status = 'modified'; break;
      default:  status = 'modified'; break;
    }
    files.push({ path: filePath, status });
  }
  return files;
}

function slugify(base, head) {
  const raw = head === 'WORKING'
    ? (base === 'HEAD' ? 'working' : `working-vs-${base}`)
    : `${base}..${head}`;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function diffTarget(base, head) {
  const repoRoot = findRepoRoot();
  const baseSha = resolveRef(repoRoot, base);
  const headSha = head === 'WORKING' ? 'WORKING' : resolveRef(repoRoot, head);
  const files = listDiffFiles(repoRoot, base, head);
  return {
    kind: 'diff',
    repoRoot,
    base,
    baseSha,
    head,
    headSha,
    files,
    slug: slugify(base, head),
  };
}

module.exports = { planTarget, diffTarget, readPlan, sha256 };
