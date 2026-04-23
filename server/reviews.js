const fs = require('fs');
const path = require('path');
const { sidecarFor } = require('./paths');
const { readPlan } = require('./plan');

function emptyShape(planPath) {
  return {
    planFile: path.basename(planPath),
    reviews: [],
  };
}

function loadSidecar(planPath) {
  const p = sidecarFor(planPath);
  if (!fs.existsSync(p)) return emptyShape(planPath);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Corrupt sidecar at ${p}: ${err.message}`);
  }
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveSidecar(planPath, data) {
  atomicWrite(sidecarFor(planPath), JSON.stringify(data, null, 2) + '\n');
}

function sliceQuote(content, startLine, endLine) {
  const lines = content.split('\n');
  const a = Math.max(1, startLine) - 1;
  const b = Math.min(lines.length, endLine);
  return lines.slice(a, b).join('\n');
}

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}_${rand}`;
}

function appendReview(planPath, { summary, comments }) {
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error('At least one comment is required');
  }
  const plan = readPlan(planPath);
  const doc = loadSidecar(planPath);

  const review = {
    id: newId('rev'),
    createdAt: new Date().toISOString(),
    planSha: plan.sha256,
    summary: summary || '',
    status: 'open',
    comments: comments.map((c, i) => {
      const start = Number(c.startLine);
      const end = Number(c.endLine ?? start);
      if (!Number.isInteger(start) || start < 1) throw new Error(`Invalid startLine on comment ${i}`);
      if (!Number.isInteger(end) || end < start) throw new Error(`Invalid endLine on comment ${i}`);
      if (typeof c.body !== 'string' || !c.body.trim()) throw new Error(`Empty body on comment ${i}`);
      const quotedText =
        typeof c.quotedText === 'string' && c.quotedText.length > 0
          ? c.quotedText
          : sliceQuote(plan.content, start, end);
      return {
        id: newId('c'),
        startLine: start,
        endLine: end,
        body: c.body,
        quotedText,
      };
    }),
  };

  doc.reviews.push(review);
  saveSidecar(planPath, doc);
  return review;
}

function patchReview(planPath, id, patch) {
  const doc = loadSidecar(planPath);
  const idx = doc.reviews.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const allowed = ['status', 'summary'];
  for (const k of allowed) {
    if (k in patch) doc.reviews[idx][k] = patch[k];
  }
  saveSidecar(planPath, doc);
  return doc.reviews[idx];
}

module.exports = { loadSidecar, appendReview, patchReview };
