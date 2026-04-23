const fs = require('fs');
const crypto = require('crypto');

function sha256(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function readPlan(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  return {
    path: planPath,
    content,
    sha256: sha256(content),
    lines: content.split('\n').length,
  };
}

module.exports = { readPlan, sha256 };
