const fs = require('fs');
const path = require('path');
const { sidecarFor } = require('./paths');
const { readPlan } = require('./target');
const { fetchFileContent } = require('./diff');
const { writeSnapshot } = require('./snapshots');

const COMMENT_STATES = new Set(['open', 'done', 'ack', 'resolved']);

function emptyShape(target) {
  if (target.kind === 'plan') {
    return {
      planFile: path.basename(target.path),
      reviews: [],
    };
  }
  return {
    target: {
      kind: 'diff',
      repoRoot: target.repoRoot,
      base: target.base,
      head: target.head,
      slug: target.slug,
    },
    reviews: [],
  };
}

function loadSidecar(target) {
  const p = sidecarFor(target);
  if (!fs.existsSync(p)) return emptyShape(target);
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

function saveSidecar(target, data) {
  atomicWrite(sidecarFor(target), JSON.stringify(data, null, 2) + '\n');
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

function deriveReviewStatus(review) {
  const anyOpen = review.comments.some((c) => (c.state || 'open') === 'open');
  return anyOpen ? 'open' : 'closed';
}

function buildPlanComment(plan, c, i) {
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
    state: 'open',
  };
}

function buildDiffComment(target, fileContents, c, i) {
  const loc = c.location;
  if (!loc || loc.kind !== 'diff') throw new Error(`Comment ${i} missing diff location`);
  if (!target.files.some((f) => f.path === loc.file)) {
    throw new Error(`Comment ${i} references unknown file: ${loc.file}`);
  }
  if (loc.side !== 'left' && loc.side !== 'right') {
    throw new Error(`Comment ${i} has invalid side: ${loc.side}`);
  }
  const start = Number(loc.startLine);
  const end = Number(loc.endLine ?? start);
  if (!Number.isInteger(start) || start < 1) throw new Error(`Invalid startLine on comment ${i}`);
  if (!Number.isInteger(end) || end < start) throw new Error(`Invalid endLine on comment ${i}`);
  if (typeof c.body !== 'string' || !c.body.trim()) throw new Error(`Empty body on comment ${i}`);

  let quotedText = typeof c.quotedText === 'string' ? c.quotedText : '';
  if (!quotedText) {
    const content = fileContents[`${loc.side}:${loc.file}`] ||= (fetchFileContent(target, loc.file, loc.side) || '');
    quotedText = sliceQuote(content, start, end);
  }

  return {
    id: newId('c'),
    location: {
      kind: 'diff',
      file: loc.file,
      side: loc.side,
      startLine: start,
      endLine: end,
    },
    body: c.body,
    quotedText,
    state: 'open',
  };
}

function appendReview(target, { summary, comments }) {
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error('At least one comment is required');
  }
  const doc = loadSidecar(target);

  let review;
  if (target.kind === 'plan') {
    const plan = readPlan(target);
    review = {
      id: newId('rev'),
      createdAt: new Date().toISOString(),
      planSha: plan.sha256,
      summary: summary || '',
      status: 'open',
      comments: comments.map((c, i) => buildPlanComment(plan, c, i)),
    };
  } else {
    const fileContents = {};
    review = {
      id: newId('rev'),
      createdAt: new Date().toISOString(),
      baseSha: target.baseSha,
      headSha: target.headSha,
      summary: summary || '',
      status: 'open',
      comments: comments.map((c, i) => buildDiffComment(target, fileContents, c, i)),
    };
  }

  doc.reviews.push(review);
  saveSidecar(target, doc);
  try {
    writeSnapshot(target, review.id);
  } catch (err) {
    console.warn(`Snapshot failed for review ${review.id}: ${err.message}`);
  }
  return review;
}

function patchReview(target, id, patch) {
  const doc = loadSidecar(target);
  const idx = doc.reviews.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const allowed = ['status', 'summary'];
  for (const k of allowed) {
    if (k in patch) doc.reviews[idx][k] = patch[k];
  }
  saveSidecar(target, doc);
  return doc.reviews[idx];
}

function patchComment(target, reviewId, commentId, patch) {
  const doc = loadSidecar(target);
  const review = doc.reviews.find((r) => r.id === reviewId);
  if (!review) return null;
  const comment = review.comments.find((c) => c.id === commentId);
  if (!comment) return null;

  if ('state' in patch) {
    if (!COMMENT_STATES.has(patch.state)) {
      throw new Error(`Invalid state: ${patch.state}. Expected one of: ${[...COMMENT_STATES].join(', ')}`);
    }
    comment.state = patch.state;
  }
  if ('resolutionNote' in patch) {
    if (patch.resolutionNote == null) {
      delete comment.resolutionNote;
    } else if (typeof patch.resolutionNote === 'string') {
      comment.resolutionNote = patch.resolutionNote;
    } else {
      throw new Error('resolutionNote must be a string or null');
    }
  }

  review.status = deriveReviewStatus(review);
  saveSidecar(target, doc);
  return comment;
}

module.exports = { loadSidecar, appendReview, patchReview, patchComment };
