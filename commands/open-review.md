---
description: Open a plan file or a git diff in the plan-review browser tool.
argument-hint: [plan <path>] | [diff [base] [head]] | <path-to-plan.md>
---

Launch the plan-review local server. Two target kinds are supported:

- **Plan target** — review a Claude Code plan markdown file (today's default).
- **Diff target** — review a git diff (working tree, or between two refs). The UI for diff targets is scaffolded in Stage 2 and completed in Stage 3; today the server boots, exposes metadata, but the browser UI still only renders plan targets.

## Steps

1. Parse `$ARGUMENTS`:
   - Empty → pick the most recently modified plan under `~/.claude/plans/` (`ls -t ~/.claude/plans/*.md | head -1`) and confirm with the user.
   - Starts with `plan ` → treat the rest as a plan file path.
   - Starts with `diff` → pass the remaining tokens through unchanged.
   - Otherwise → treat the argument as a plan file path (shorthand).
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
