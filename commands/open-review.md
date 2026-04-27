---
description: Open a plan file or a git diff in the plan-review browser tool.
argument-hint: [plan <path>] | [diff [base] [head]] | <path-to-plan.md>
---

Launch the plan-review local server. Two target kinds are supported, both with full browser UI:

- **Plan target** — review a Claude Code plan markdown file (CodeMirror source view + rendered markdown preview).
- **Diff target** — review a git diff (working tree, or between two refs). Renders a file-tree sidebar and side-by-side diff with syntax highlighting, multi-file inline comments, snapshot picker, and Vi-style keyboard navigation.

## Steps

1. Parse `$ARGUMENTS`:
   - Starts with `plan ` → treat the rest as a plan file path.
   - Starts with `diff` → pass the remaining tokens through unchanged.
   - A path-like argument → treat as a plan file path (shorthand).
   - Empty → check, **in this order**, and use the first match:
     1. If the current directory is inside a git repo and `<repoRoot>/.plan-review/` contains any `*.comments.json` files, list them with timestamps and ask the user which one to open. Translate the slug back to `diff` arguments (e.g., `working` → `diff`, `main..HEAD` → `diff main HEAD`).
     2. Otherwise pick the most recently modified plan under `~/.claude/plans/` (`ls -t ~/.claude/plans/*.md | head -1`) and confirm with the user.
2. Using the Bash tool with `run_in_background: true`, launch:
   ```
   ~/code/plan-review-tool/bin/plan-review.js <parsed args>
   ```
   The script picks a free port, writes `plan-review serving <label> at <URL>` to stdout, and auto-opens the browser.
3. Read the background task output to capture the URL, then report it to the user:

   > Plan-review running at <URL>. Leave comments in the browser, click **Submit review**, then run `/apply-review` here to apply them.

4. Do **not** wait for the server to exit — leave it running in the background.

## Invocations

| Shorthand | Full form | Target |
|---|---|---|
| `/open-review` | `/open-review plan <latest>` | most recent plan file |
| `/open-review ~/.claude/plans/foo.md` | `/open-review plan ~/.claude/plans/foo.md` | specific plan |
| `/open-review diff` | — | working tree vs HEAD |
| `/open-review diff main` | — | `main..HEAD` |
| `/open-review diff main HEAD~2` | — | `main..HEAD~2` |

For diff targets, the tool must be run from inside a git working tree; `cd` into the repo before invoking.

## Errors

- If `~/code/plan-review-tool/bin/plan-review.js` is missing or the bundle isn't built, tell the user to run `cd ~/code/plan-review-tool && npm install && npm run build` first.
- If a plan file doesn't exist or a git ref can't be resolved, the tool prints an error and exits — surface it.
