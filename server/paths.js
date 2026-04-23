const fs = require('fs');
const path = require('path');

function sidecarFor(target) {
  if (target.kind === 'plan') {
    const dir = path.dirname(target.path);
    const base = path.basename(target.path, path.extname(target.path));
    return path.join(dir, `${base}.comments.json`);
  }
  if (target.kind === 'diff') {
    const dir = path.join(target.repoRoot, '.plan-review');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${target.slug}.comments.json`);
  }
  throw new Error(`Unknown target kind: ${target.kind}`);
}

module.exports = { sidecarFor };
