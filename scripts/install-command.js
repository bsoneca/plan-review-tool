#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'commands');
const destDir = path.join(os.homedir(), '.claude', 'commands');

fs.mkdirSync(destDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'));
for (const f of files) {
  const src = path.join(srcDir, f);
  const dest = path.join(destDir, f);
  fs.copyFileSync(src, dest);
  console.log(`Installed: ${dest}`);
}
