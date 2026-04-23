#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { planTarget, diffTarget } = require('../server/target');

function usage() {
  console.error(
    'Usage:\n' +
      '  plan-review plan <file.md>\n' +
      '  plan-review diff [base] [head]\n' +
      '      diff            → working tree vs HEAD\n' +
      '      diff main       → main..HEAD\n' +
      '      diff main HEAD~2 → main..HEAD~2\n' +
      '  plan-review <file.md>   (shorthand for "plan")',
  );
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    return { kind: 'help' };
  }
  if (argv[0] === 'plan') {
    if (!argv[1]) throw new Error('plan requires a file path');
    return { kind: 'plan', path: argv[1] };
  }
  if (argv[0] === 'diff') {
    if (argv.length === 1) return { kind: 'diff', base: 'HEAD', head: 'WORKING' };
    if (argv.length === 2) return { kind: 'diff', base: argv[1], head: 'HEAD' };
    return { kind: 'diff', base: argv[1], head: argv[2] };
  }
  return { kind: 'plan', path: argv[0] };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }
  if (parsed.kind === 'help') {
    usage();
    process.exit(0);
  }

  let target;
  try {
    target = parsed.kind === 'plan'
      ? planTarget(parsed.path)
      : diffTarget(parsed.base, parsed.head);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const bundlePath = path.join(__dirname, '..', 'web', 'app.bundle.js');
  if (!fs.existsSync(bundlePath)) {
    console.error('Missing web/app.bundle.js — run `npm run build` first.');
    process.exit(1);
  }

  const app = createApp(target);
  const server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    const label = target.kind === 'plan'
      ? path.basename(target.path)
      : `diff ${target.base}..${target.head} (${target.files.length} files)`;
    console.log(`plan-review serving ${label} at ${url}`);
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
