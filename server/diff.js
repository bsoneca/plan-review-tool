const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parseUnifiedDiff(diffText) {
  const hunks = [];
  let current = null;
  for (const line of diffText.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] == null ? 1 : Number(m[4]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      current.lines.push({ kind: line[0], text: line.slice(1) });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function sideBySide(hunks) {
  const out = [];
  for (const h of hunks) {
    const rows = [];
    let oldLn = h.oldStart;
    let newLn = h.newStart;
    const removed = [];
    const added = [];

    const flush = () => {
      const max = Math.max(removed.length, added.length);
      for (let i = 0; i < max; i++) {
        rows.push({
          left: removed[i] || null,
          right: added[i] || null,
        });
      }
      removed.length = 0;
      added.length = 0;
    };

    for (const l of h.lines) {
      if (l.kind === '-') {
        removed.push({ line: oldLn, text: l.text, kind: '-' });
        oldLn++;
      } else if (l.kind === '+') {
        added.push({ line: newLn, text: l.text, kind: '+' });
        newLn++;
      } else {
        flush();
        rows.push({
          left: { line: oldLn, text: l.text, kind: ' ' },
          right: { line: newLn, text: l.text, kind: ' ' },
        });
        oldLn++;
        newLn++;
      }
    }
    flush();
    out.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      rows,
    });
  }
  return out;
}

function fetchDiff(target, filePath, contextLines = 3) {
  const { repoRoot, base, head } = target;
  const args = ['diff', '--no-color', `--unified=${contextLines}`];
  if (head === 'WORKING') {
    args.push(base);
  } else {
    args.push(`${base}..${head}`);
  }
  args.push('--', filePath);
  const out = git(repoRoot, args);
  return parseUnifiedDiff(out);
}

function fetchDiffBetween(target, filePath, fromContent, toContent, contextLines = 3) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'plan-review-diff-'));
  const leftPath = path.join(tmpDir, 'from');
  const rightPath = path.join(tmpDir, 'to');
  fs.writeFileSync(leftPath, fromContent || '');
  fs.writeFileSync(rightPath, toContent || '');
  try {
    const args = [
      'diff',
      '--no-color',
      '--no-index',
      `--unified=${contextLines}`,
      leftPath,
      rightPath,
    ];
    let out;
    try {
      out = execFileSync('git', args, {
        cwd: target.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      if (err.status === 1 && typeof err.stdout === 'string') out = err.stdout;
      else throw err;
    }
    return parseUnifiedDiff(out);
  } finally {
    try { fs.unlinkSync(leftPath); } catch {}
    try { fs.unlinkSync(rightPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

function fetchFileContent(target, filePath, side) {
  const { repoRoot, base, head } = target;
  if (side === 'left') {
    try {
      return git(repoRoot, ['show', `${base}:${filePath}`]);
    } catch {
      return null;
    }
  }
  if (head === 'WORKING') {
    try {
      return fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    return git(repoRoot, ['show', `${head}:${filePath}`]);
  } catch {
    return null;
  }
}

module.exports = { fetchDiff, fetchDiffBetween, sideBySide, fetchFileContent, parseUnifiedDiff };
