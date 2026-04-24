---
description: Read inline review comments on a plan file or a git diff and revise the code accordingly.
argument-hint: [path-to-plan.md | path-to-sidecar.comments.json]
---

You are processing a review round that was annotated with the `plan-review` tool. The review targets either a Claude Code plan markdown file, or a git diff (changes across one or more files in a repository). Detect which kind from the sidecar's top-level shape and branch.

## Inputs

- `$ARGUMENTS` — optional path. It can be:
  1. A plan `.md` file; the sidecar is sibling `<plan-basename>.comments.json`.
  2. A sidecar file directly (ends in `.comments.json`).
  3. Empty — use the most recently modified `.md` file under `~/.claude/plans/`.

Sidecar shapes:
- **Plan sidecar**: top-level has `planFile`. Each comment has flat `startLine` / `endLine` fields. The plan file sits alongside the sidecar.
- **Diff sidecar**: top-level has `target: { kind: "diff", repoRoot, base, head, slug }`. Each comment has a nested `location: { kind: "diff", file, side: "left"|"right", startLine, endLine }`.

## Comment states

Each comment has a `state` field, one of:

- `open` — awaiting your action.
- `done` — you already applied it.
- `ack` — acknowledged, no code change needed.
- `resolved` — reviewer closed the thread.

Missing `state` → treat as `open`. Legacy plan sidecars may have `review.status = "addressed"` to indicate the whole review was already handled — in that case treat every comment in the review as closed.

## Replies (disputes, counter-proposals)

Each comment may have a `replies` array; each reply has `{ id, author, body, createdAt }` where `author` is `"human"` or `"claude"`. You can **reply** to a comment when you think you have a better approach than what the reviewer suggested, or when you want to ask a clarifying question before acting.

Decision tree for each open comment:

1. **The suggestion is good and straightforward** → apply it. Edit the file. Set `state: "done"` and add a short `resolutionNote`.
2. **You have a better idea, or want to push back** → append a reply with `author: "claude"` and a body that explains your counter-proposal or question. Leave `state: "open"`. This flips the attention pill back to the human.
3. **Acknowledgement, no code change warranted** → set `state: "ack"` with a `resolutionNote` explaining why.
4. **Genuinely infeasible** → same as #3: `ack` with a clear `resolutionNote`.

The last reply's author determines whose turn it is. Don't reply just to narrate — reply only when the human needs to decide something (dispute, question, counter-proposal).

## Steps

1. **Resolve the input.** Derive the sidecar path:
   - Argument ends with `.comments.json` → that is the sidecar.
   - Argument ends with `.md` → sibling `<basename>.comments.json`.
   - Empty → `ls -t ~/.claude/plans/*.md | head -1`, then derive the sidecar. Confirm the path with the user before proceeding.
2. **Load the sidecar JSON.** Inspect the top-level shape to decide plan vs diff. If it doesn't exist, stop and tell the user there are no comments.
3. **Filter to comments in state `open`.** If none, stop and tell the user all comments are already closed.
4. **For a plan sidecar** — follow the existing plan workflow:
   1. Compute `sha256` of the plan file contents. For each review containing open comments, verify `review.planSha` matches; if not, locate each comment via `quotedText` and warn on any that can't be found.
   2. Present a summary of each open comment (review id, line range, quoted excerpt, body).
   3. Revise the plan with the Edit tool, addressing each comment. Preserve section structure.
   4. For each open comment you acted on, set its `state` to `"done"` and add a `resolutionNote`. If a comment is genuinely infeasible, use `"ack"` with a note explaining why.
5. **For a diff sidecar** — operate against the repo at `target.repoRoot`:
   1. `cd` into `target.repoRoot` (or resolve all file paths relative to it).
   2. For each open comment, the relevant file is `<repoRoot>/<comment.location.file>`.
   3. Use Edit with `comment.quotedText` as `old_string` to locate the exact place to modify.
      - For `side: "right"`: the quoted text is from the NEW file (current working-tree state for `head: "WORKING"`, otherwise from `head`). Revise accordingly.
      - For `side: "left"`: the quoted text is from the OLD file (`base`). A left-side comment usually means "don't delete this" or "explain this deletion" — interpret the comment body to decide whether to restore the old content, add a comment, or reply in `resolutionNote` with `state: "ack"` if no code change is warranted.
   4. If the comment's file has been further changed and `quotedText` no longer appears verbatim, warn the user and ask how to proceed for that comment.
   5. Present a summary of each open comment (file, side, line, quote, body) before making edits.
   6. After each successful edit, set the comment's `state` to `"done"` and write a one-sentence `resolutionNote`.
6. **Update the sidecar JSON** using the Edit tool:
   - For applied comments: set `state: "done"` and add `resolutionNote`.
   - For acknowledged comments: set `state: "ack"` and add `resolutionNote`.
   - For disputes/counter-proposals: append to the comment's `replies` array an object `{ id: "rep_<timestamp>_<rand>", author: "claude", body: "...", createdAt: "<ISO-8601>" }`, keep `state: "open"`, and do **not** edit the file yet. Generate `id` in the same shape as existing ids — e.g. `rep_2026-04-24T02-30-00-000Z_abcd`. Never mutate existing replies.
7. **Report back** a bullet list of what changed, what you disputed (with one-line rationale), and what remains open.

## Rules

- Never delete a comment or review from the sidecar.
- Never modify `id`, `createdAt`, `planSha`, `baseSha`, `headSha`, `body`, `quotedText`, `startLine`, `endLine`, `location`.
- Do not touch comments already in state `done`, `ack`, or `resolved` — they're closed.
- For diff sidecars with `head: "WORKING"`, the "new" side is the live working tree; edits you make show up in the next review round.
- If drift has rendered multiple quotes un-locatable, stop and ask the user how to proceed instead of guessing.
