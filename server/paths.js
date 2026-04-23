const path = require('path');

function sidecarFor(planPath) {
  const dir = path.dirname(planPath);
  const base = path.basename(planPath, path.extname(planPath));
  return path.join(dir, `${base}.comments.json`);
}

module.exports = { sidecarFor };
