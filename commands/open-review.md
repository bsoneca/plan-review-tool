---
description: Open a plan file in the plan-review browser tool.
argument-hint: <path-to-plan.md>
---

Launch the plan-review local server for a plan file.

## Steps

1. Resolve the plan path from `$ARGUMENTS`. If empty, run `ls -t ~/.claude/plans/*.md | head -1` to pick the most recently modified plan and confirm with the user before proceeding.
2. Using the Bash tool with `run_in_background: true`, launch:
   ```
   ~/code/plan-review-tool/bin/plan-review.js "<resolved-path>"
   ```
   The script picks a free port, writes `plan-review serving <file> at <URL>` to stdout, and auto-opens the browser.
3. Briefly read the background task output to capture the URL, then report it to the user in this form:

   > Plan-review running at <URL>. Leave comments in the browser, click **Submit review**, then run `/apply-review "<path>"` here to apply them.

4. Do **not** wait for the server to exit — leave it running in the background. Tell the user they can stop it by killing that background task or closing the terminal.

## Errors

- If `~/code/plan-review-tool/bin/plan-review.js` is missing or the bundle isn't built, tell the user to run `cd ~/code/plan-review-tool && npm install && npm run build` first.
- If the plan file doesn't exist, stop and tell the user.
