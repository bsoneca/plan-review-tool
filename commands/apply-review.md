---
description: Read inline review comments on a plan file and revise the plan accordingly.
argument-hint: [path-to-plan.md]
---

You are processing a review round on a Claude Code plan file that was annotated with the `plan-review` tool.

## Inputs

- `$ARGUMENTS` — optional path to the plan `.md` file. If empty, use the most recently modified `.md` file under `~/.claude/plans/` (sort by mtime, descending).
- Sidecar file: sibling of the plan, named `<plan-basename>.comments.json`. For example, `foo.md` → `foo.comments.json`.

## Steps

1. **Resolve the plan path.** If `$ARGUMENTS` is empty, run `ls -t ~/.claude/plans/*.md | head -1` to find the most recent plan. Confirm the path with the user before proceeding.
2. **Load the sidecar JSON.** If it doesn't exist, stop and tell the user there are no comments to review.
3. **Filter to `status: "open"` reviews.** If none, stop and tell the user all reviews are already addressed.
4. **Check plan drift.** Compute `sha256` of the plan file contents. For each open review:
   - If `review.planSha` matches the current sha, the recorded `startLine`/`endLine` are still valid.
   - If it doesn't match, locate each comment by searching for its `quotedText` in the current plan. Warn the user for any comment whose `quotedText` no longer appears verbatim.
5. **Present a concise summary** of each open review and its comments to the user:
   - Review id, summary, createdAt.
   - For each comment: the anchored line range (or the drifted-but-located range), the quoted excerpt, and the comment body.
6. **Revise the plan file** with the Edit tool, addressing each comment. Preserve the plan's existing section structure (Context / Approach / etc.). Do not rewrite sections that aren't touched by a comment.
7. **Update the sidecar JSON** using the Edit tool:
   - For each review you addressed, change `status` from `"open"` to `"addressed"`.
   - For each comment in that review, add a new field `"resolution"` with a one-sentence note describing how the comment was handled in the revised plan.
   - Preserve existing fields exactly — only add/modify what's called out above.
8. **Report back** a bullet list of what changed in the plan and what remains open (if anything).

## Rules

- Never delete a review or a comment from the sidecar.
- Never modify `planFile`, `id`, `createdAt`, `planSha`, `startLine`, `endLine`, `body`, or `quotedText`.
- If a comment is genuinely infeasible, set its review's `status` to `"addressed"` anyway but write a `resolution` that explains why you couldn't apply it, and surface that clearly to the user.
- If the plan has drifted enough that multiple `quotedText` snippets can't be located, stop after step 5 and ask the user how to proceed instead of guessing.
