const path = require('path');
const express = require('express');
const { readPlan } = require('./target');
const { fetchDiff, sideBySide, fetchFileContent } = require('./diff');
const { loadSidecar, appendReview, patchReview, patchComment } = require('./reviews');
const { listSnapshots, fetchInterdiff } = require('./snapshots');

function createApp(target) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

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
    const fromReviewId = req.query.from ? String(req.query.from) : null;
    try {
      if (fromReviewId) {
        const inter = fetchInterdiff(target, filePath, fromReviewId, context);
        if (inter.isInterdiff) {
          return res.json({
            path: filePath,
            isInterdiff: true,
            hunks: inter.hunks,
            sideBySide: inter.sideBySide,
          });
        }
        // fall through to full diff
      }
      const hunks = fetchDiff(target, filePath, context);
      res.json({ path: filePath, isInterdiff: false, hunks, sideBySide: sideBySide(hunks) });
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
