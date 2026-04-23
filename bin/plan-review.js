#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') {
    console.error('Usage: plan-review <path-to-plan.md>');
    process.exit(arg ? 0 : 1);
  }

  const planPath = path.resolve(arg);
  if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) {
    console.error(`File not found: ${planPath}`);
    process.exit(1);
  }

  const bundlePath = path.join(__dirname, '..', 'web', 'app.bundle.js');
  if (!fs.existsSync(bundlePath)) {
    console.error('Missing web/app.bundle.js — run `npm run build` first.');
    process.exit(1);
  }

  const app = createApp(planPath);
  const server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`plan-review serving ${path.basename(planPath)} at ${url}`);
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch (err) {
      console.warn(`Could not auto-open browser: ${err.message}`);
    }
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
