const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { readPlan } = require('./target');
const { sidecarFor } = require('./paths');
const { fetchDiff, fetchDiffBetween, sideBySide, fetchFileContent } = require('./diff');
const { loadSidecar, appendReview, patchReview, patchComment, addReply } = require('./reviews');
const { listSnapshots, readSnapshotFile } = require('./snapshots');

function resolveContent(target, filePath, ref) {
  if (!ref || ref === 'BASE') return fetchFileContent(target, filePath, 'left');
  if (ref === 'CURRENT') return fetchFileContent(target, filePath, 'right');
  return readSnapshotFile(target, ref, filePath);
}

function createApp(target) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  let currentApply = null;

  app.post('/api/apply', (req, res) => {
    if (currentApply) {
      return res.status(409).json({ error: 'An apply is already in progress' });
    }
    let sidecar;
    try {
      sidecar = sidecarFor(target);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    const cwd = target.kind === 'diff' ? target.repoRoot : path.dirname(target.path);
    const child = spawn('claude', ['-p', `/apply-review "${sidecar}"`], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentApply = { startedAt: new Date().toISOString(), pid: child.pid };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      currentApply = null;
      if (!res.headersSent) {
        res.status(500).json({ error: `Could not spawn claude: ${err.message}` });
      }
    });
    child.on('exit', (code) => {
      currentApply = null;
      if (!res.headersSent) {
        res.json({ exitCode: code, stdout, stderr });
      }
    });
  });

  app.get('/api/apply/status', (req, res) => {
    res.json({ running: !!currentApply, startedAt: currentApply?.startedAt || null });
  });

  app.get('/api/target', (req, res) => {
    try {
      if (target.kind === 'plan') {
        res.json({
          kind: 'plan',
          path: target.path,
        });
      } else {
        res.json({
          kind: 'diff',
          repoRoot: target.repoRoot,
          base: target.base,
          baseSha: target.baseSha,
          head: target.head,
          headSha: target.headSha,
          files: target.files,
          slug: target.slug,
        });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const requireDiff = (req, res, next) => {
    if (target.kind !== 'diff') return res.status(404).json({ error: 'Not a diff target' });
    next();
  };

  app.get('/api/diff/files', requireDiff, (req, res) => {
    res.json(target.files);
  });

  app.get('/api/diff/file', requireDiff, (req, res) => {
    const filePath = String(req.query.path || '');
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!target.files.some((f) => f.path === filePath)) {
      return res.status(404).json({ error: 'File not part of this diff' });
    }
    const context = Math.max(0, Number(req.query.context ?? 1000000));
    const fromRef = req.query.from ? String(req.query.from) : 'BASE';
    const toRef = req.query.to ? String(req.query.to) : 'CURRENT';
    try {
      // Fast path: BASE → CURRENT uses git's native base..head diff.
      if (fromRef === 'BASE' && toRef === 'CURRENT') {
        const hunks = fetchDiff(target, filePath, context);
        return res.json({
          path: filePath,
          from: fromRef,
          to: toRef,
          hunks,
          sideBySide: sideBySide(hunks),
        });
      }
      const fromContent = resolveContent(target, filePath, fromRef);
      const toContent = resolveContent(target, filePath, toRef);
      const hunks = fetchDiffBetween(
        target,
        filePath,
        fromContent || '',
        toContent || '',
        context,
      );
      res.json({
        path: filePath,
        from: fromRef,
        to: toRef,
        hunks,
        sideBySide: sideBySide(hunks),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/snapshots', (req, res) => {
    try {
      const ids = listSnapshots(target);
      const doc = loadSidecar(target);
      const entries = ids
        .map((id) => {
          const review = doc.reviews.find((r) => r.id === id);
          return { id, createdAt: review?.createdAt || null, summary: review?.summary || '' };
        })
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/file', requireDiff, (req, res) => {
    const filePath = String(req.query.path || '');
    const side = req.query.side === 'left' ? 'left' : 'right';
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const content = fetchFileContent(target, filePath, side);
    if (content == null) return res.status(404).json({ error: 'File not present on that side' });
    res.type('text/plain').send(content);
  });

  // Compat: /api/plan still works for plan targets so the existing UI boots.
  app.get('/api/plan', (req, res) => {
    if (target.kind !== 'plan') return res.status(404).json({ error: 'Not a plan target' });
    try {
      res.json(readPlan(target));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reviews', (req, res) => {
    try {
      res.json(loadSidecar(target));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reviews', (req, res) => {
    try {
      const review = appendReview(target, req.body || {});
      res.status(201).json(review);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/reviews/:id', (req, res) => {
    try {
      const updated = patchReview(target, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: 'Review not found' });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/comments/:reviewId/:commentId/replies', (req, res) => {
    try {
      const reply = addReply(
        target,
        req.params.reviewId,
        req.params.commentId,
        req.body || {},
      );
      if (!reply) return res.status(404).json({ error: 'Comment not found' });
      res.status(201).json(reply);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/comments/:reviewId/:commentId', (req, res) => {
    try {
      const updated = patchComment(
        target,
        req.params.reviewId,
        req.params.commentId,
        req.body || {},
      );
      if (!updated) return res.status(404).json({ error: 'Comment not found' });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createApp };
