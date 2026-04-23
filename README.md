# plan-review

GitHub-style inline review for Claude Code plan files.

## Install (internal)

One command:

```bash
npm install -g github:<org>/plan-review-tool
```

This clones the repo, builds the CodeMirror bundle, installs `plan-review` on your PATH, and drops two slash commands into `~/.claude/commands/`:

- `/open-review <plan.md>` — launches the browser UI for a plan file.
- `/apply-review <plan.md>` — reads the saved comments and revises the plan.

## Use

In a Claude Code session:

```
/open-review ~/.claude/plans/foo.md
```

In the browser:

- Hover the left gutter on any line — a `+` appears. Click it to start a comment on that line.
- To comment on a range, drag-select lines first, then click the `+`.
- Draft as many comments as you want, click **Submit review** (top right), optionally add a summary, confirm. Everything lands in `<plan>.comments.json` next to the plan file.

Back in Claude Code:

```
/apply-review ~/.claude/plans/foo.md
```

Claude reads the comments, revises the plan, and flips each review to `addressed` with a per-comment resolution note.

## Develop

```bash
git clone <repo>
cd plan-review-tool
npm install        # builds bundle and installs slash commands via prepare/postinstall
npm run dev        # rebuild bundle on change
```

Uninstall:

```bash
npm uninstall -g plan-review-tool
rm ~/.claude/commands/open-review.md ~/.claude/commands/apply-review.md
```
