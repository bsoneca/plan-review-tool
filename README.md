# plan-review

A local, Critique-style review tool for Claude Code plans **and** git diffs. Leave inline comments in a browser, hand them to Claude to apply.

Plans, working-tree diffs, and ref-range diffs (`main..HEAD`) all use the same UI. Comments live in a sidecar JSON file next to whatever you're reviewing.

## Install (internal)

One command:

```bash
npm install -g github:bsoneca/plan-review-tool
```

This clones, builds the bundle, installs `plan-review` on your PATH, and drops the slash commands into `~/.claude/commands/`:

- `/open-review` — launches the browser UI.
- `/apply-review` — Claude reads the saved comments, edits the code/plan, and updates each comment's state.

## Use

### Reviewing a plan

```
/open-review ~/.claude/plans/foo.md
```

Hover any line, click the gutter `+`, write the comment. Drag a range first to anchor multiple lines. Click **Submit review** (top right) to persist everything to `<plan>.comments.json`.

```
/apply-review ~/.claude/plans/foo.md
```

Claude revises the plan, flips each comment's `state` to `done` (or `ack` if no change was warranted), and writes a one-sentence `resolutionNote`.

### Reviewing a code change

From inside any git repo:

| Command | What you review |
|---|---|
| `/open-review diff` | Working tree vs `HEAD` |
| `/open-review diff main` | `main..HEAD` |
| `/open-review diff main HEAD~2` | `main..HEAD~2` |

You get a file-tree sidebar, side-by-side diff with syntax highlighting, and per-side line-clicking to anchor comments. Sidecar lives at `<repo>/.plan-review/<slug>.comments.json`. `/apply-review` handles diff sidecars by Editing each file in place using each comment's `quotedText` as the anchor.

### Browser features

- **Comment states**: `open` → `done` (Claude applied it), `ack` (acknowledged, no change), `lgtm` (stamp of approval, collapsed by default to a one-line pill). Each is one button click.
- **Threaded replies**: Claude can push back instead of applying — appends a reply with `author: "claude"`, leaves state `open`. The browser shows the back-and-forth color-coded.
- **Attention pill** in the topbar: `Your turn` / `Claude's turn`, derived from who replied last.
- **Snapshot picker**: every successful submit snapshots the reviewed files. The file header shows a strip — `[Base] [Snap 1: date] [Snap 2: date] [Current]` — click any pill to set the diff's "to" endpoint, shift-click to set "from".
- **Collapse unchanged**: per-file `Collapse` toggle folds long unchanged stretches into clickable `Show N unchanged lines` placeholders, GitHub-style.
- **Viewed**: per-file checkmark glyph + sort tree by progress. Press `v` or `r` to toggle the current file.

### Keyboard shortcuts (diff mode)

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous changed chunk |
| `N` / `P` | Next / previous comment |
| `v` / `r` | Toggle reviewed on the current file |
| `?` | Show shortcuts dialog |

## Storage layout

- Plan sidecar: `<plan>.comments.json`
- Diff sidecar: `<repoRoot>/.plan-review/<slug>.comments.json`
- Snapshots (one per submit): `<root>/.plan-review/snapshots/<reviewId>/...`

For team repos where you don't want any of this checked in, add `.wiki/` and `.plan-review/` to your global git ignore (`~/.config/git/ignore`) — no need to touch the repo's `.gitignore`.

## Develop

```bash
git clone <repo>
cd plan-review-tool
npm install        # builds bundle and installs slash commands via prepare/postinstall
npm run dev        # rebuild bundle on change
```

After editing the slash commands in `commands/*.md`, push them to your live install with `node scripts/install-command.js`.

## Uninstall

```bash
npm uninstall -g plan-review-tool
rm ~/.claude/commands/open-review.md ~/.claude/commands/apply-review.md
```
