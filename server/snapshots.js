const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { fetchFileContent, parseUnifiedDiff, sideBySide } = require('./diff');

function snapshotRoot(target) {
  const base = target.kind === 'plan' ? path.dirname(target.path) : target.repoRoot;
  return path.join(base, '.plan-review', 'snapshots');
}

function snapshotDir(target, reviewId) {
  return path.join(snapshotRoot(target), reviewId);
}

function planSnapshotPath(dir) {
  return path.join(dir, 'plan.md');
}

function writeSnapshot(target, reviewId) {
  const dir = snapshotDir(target, reviewId);
  fs.mkdirSync(dir, { recursive: true });
  if (target.kind === 'plan') {
    const content = fs.readFileSync(target.path, 'utf8');
    fs.writeFileSync(planSnapshotPath(dir), content);
    return;
  }
  for (const f of target.files) {
    if (f.status === 'deleted') continue;
    const content = fetchFileContent(target, f.path, 'right');
    if (content == null) continue;
    const outPath = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
  }
}

function readSnapshotFile(target, reviewId, filePath) {
  const dir = snapshotDir(target, reviewId);
  const p = target.kind === 'plan' ? planSnapshotPath(dir) : path.join(dir, filePath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function listSnapshots(target) {
  const root = snapshotRoot(target);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function gitDiffNoIndex(cwd, leftPath, rightPath, contextLines) {
  const args = [
    'diff',
    '--no-color',
    '--no-index',
    `--unified=${contextLines}`,
    leftPath,
    rightPath,
  ];
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // git diff --no-index exits 1 when files differ — normal, capture stdout.
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout;
    throw err;
  }
}

function fetchInterdiff(target, filePath, reviewId, contextLines = 3) {
  const dir = snapshotDir(target, reviewId);
  if (!fs.existsSync(dir)) return { isInterdiff: false };

  const snapPath = target.kind === 'plan' ? planSnapshotPath(dir) : path.join(dir, filePath);
  if (!fs.existsSync(snapPath)) return { isInterdiff: false };

  const current =
    target.kind === 'plan'
      ? fs.readFileSync(target.path, 'utf8')
      : fetchFileContent(target, filePath, 'right');
  if (current == null) return { isInterdiff: false };

  const tmpFile = path.join(os.tmpdir(), `plan-review-cur-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpFile, current);
  try {
    const out = gitDiffNoIndex(
      target.kind === 'plan' ? path.dirname(target.path) : target.repoRoot,
      snapPath,
      tmpFile,
      contextLines,
    );
    const hunks = parseUnifiedDiff(out);
    return { isInterdiff: true, hunks, sideBySide: sideBySide(hunks) };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

module.exports = { writeSnapshot, readSnapshotFile, listSnapshots, fetchInterdiff };
