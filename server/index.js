const path = require('path');
const express = require('express');
const { readPlan } = require('./plan');
const { loadSidecar, appendReview, patchReview } = require('./reviews');

function createApp(planPath) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  app.get('/api/plan', (req, res) => {
    try {
      res.json(readPlan(planPath));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reviews', (req, res) => {
    try {
      res.json(loadSidecar(planPath));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reviews', (req, res) => {
    try {
      const review = appendReview(planPath, req.body || {});
      res.status(201).json(review);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/reviews/:id', (req, res) => {
    try {
      const updated = patchReview(planPath, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: 'Review not found' });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createApp };
