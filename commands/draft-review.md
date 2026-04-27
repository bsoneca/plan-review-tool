---
description: Do an automated code-review pass and annotate findings as inline comments in the plan-review sidecar.
argument-hint: [--codex] [base-ref] | working
---

You are doing an automated code-review pass. **The output is structured inline comments in a plan-review sidecar JSON file** — not a free-text report. The human will open the result in the plan-review browser tool, accept what's useful, push back on what's not (Claude can reply on those threads later via `/apply-review`).

This skill is intentionally separate from `/review`, `/code-review`, and `/security-review` so it doesn't collide with their text-output flows. You may delegate analysis to those skills if useful, but the **deliverable is always sidecar comments**.

## Scope (parsing `$ARGUMENTS`)

Strip any token starting with `--` from `$ARGUMENTS` before parsing the target — those are flags. Recognized flags:

- `--codex` — delegate the analysis to the `codex` CLI (OpenAI) instead of doing it yourself. See "Codex mode" below.

The remaining tokens determine the diff target:

| Args (after flags) | Target |
|---|---|
| empty | working tree vs `HEAD` |
| `working` | working tree vs `HEAD` (explicit) |
| `<ref>` | `<ref>..HEAD` |
| `<base> <head>` | `<base>..<head>` |

Confirm with the user before proceeding if the diff touches more than 20 files.

## Steps

1. **Resolve the target.** Get the repo root with `git rev-parse --show-toplevel`. Resolve `baseSha` via `git rev-parse --verify <base>`. For `head`: `WORKING` if working-tree mode, else the SHA from `git rev-parse --verify <head>`.

2. **List changed files.**
   - Working: `git diff --name-status HEAD`
   - Range: `git diff --name-status <base>..<head>`
   Skip files marked deleted unless they warrant a "why was this removed" left-side comment.

3. **For each changed file, read the relevant content:**
   - For added/modified files: read the current contents (working tree or `git show <head>:<file>`).
   - For deletions or to compare against base: `git show <base>:<file>`.
   - Read the diff itself (`git diff -U10 <range> -- <file>`) to know which lines changed.

4. **Look for actual review-worthy findings.** The bar is "I would leave this comment on a colleague's PR":
   - Correctness bugs, off-by-one, null/undefined handling, race conditions
   - Security issues — injection, XSS, auth/authz gaps, secret handling, validation at boundaries
   - Performance pitfalls — N+1, unbounded loops, large allocations, sync I/O on hot paths
   - Maintainability — duplication, leaky abstractions, surprising naming, missing types
   - Test / doc gaps that matter for this change
   - Dropped error handling or silent failures

   Skip nits unless asked. Don't restate what the diff already shows. Don't comment "this looks fine" — silence is the signal.

5. **Build comment objects.** Each finding becomes:
   ```json
   {
     "id": "c_<ISO-timestamp-with-:.replaced-by-->_<4-char-rand>",
     "location": {
       "kind": "diff",
       "file": "<repo-relative-path>",
       "side": "right" | "left",
       "startLine": <number>,
       "endLine": <number>
     },
     "body": "<1-3 sentences: the issue + a concrete suggestion>",
     "quotedText": "<exact text of the anchored line(s)>",
     "state": "open"
   }
   ```
   - `side: "right"` for issues on added/changed code (line numbers in the new file).
   - `side: "left"` for "explain this removal" or "this should be restored" findings (line numbers in the old file).
   - `quotedText` must exactly match the line text on the chosen side, or `/apply-review` will fail to anchor.

6. **Compute the sidecar slug** from the target. **Always use the user's original ref strings** from `$ARGUMENTS` — never the resolved SHAs. The server uses the same rule, so the filenames must match exactly:
   - working tree, base `HEAD` → `working`
   - working tree, base other → `working-vs-<base>` (replace any character not in `[A-Za-z0-9._-]` with `-`)
   - range `<base>..<head>` → `<base>..<head>` then the same character sanitization (so `HEAD~1..HEAD` becomes `HEAD-1..HEAD`)

   The resolved `baseSha` and `headSha` go inside the review object as data fields, but **must not** appear in the sidecar filename.

7. **Write the sidecar** at `<repoRoot>/.plan-review/<slug>.comments.json`:
   - If the file does not exist, create the parent directory and write the diff-target shape:
     ```json
     {
       "target": { "kind": "diff", "repoRoot": "<absolute>", "base": "<base>", "head": "<head>", "slug": "<slug>" },
       "reviews": [<the new review>]
     }
     ```
   - If it exists, read it, append your new review to `reviews[]`, write it back. **Never overwrite or remove existing reviews.**

   The new review:
   ```json
   {
     "id": "rev_<ISO-timestamp>_<4-char-rand>",
     "createdAt": "<ISO-8601>",
     "baseSha": "<resolved-base-sha>",
     "headSha": "<WORKING or resolved-head-sha>",
     "summary": "Automated review draft — <one-line gist>",
     "status": "open",
     "comments": [<your comment objects>]
   }
   ```

8. **Report back** to the user:
   - The sidecar path.
   - File-by-file count of comments left.
   - One-line summary of the most important findings (≤3).
   - The exact command to open it: `/open-review diff` or `/open-review diff <base>` or `/open-review diff <base> <head>`.

## Codex mode

When `--codex` is in `$ARGUMENTS`, you are not the reviewer — Codex is. Steps 4–7 above (find issues, build comments, write sidecar) are delegated to the `codex` CLI; you orchestrate and verify.

1. **Check Codex is installed.** `which codex`. If missing, tell the user to install it (`npm install -g @openai/codex` or current path) and stop.
2. **Build the prompt.** Take the contents of *this* file (without the YAML frontmatter and without this Codex section), and append:
   > Operate on the target derived from these arguments: `<the user's $ARGUMENTS minus --codex>`. Treat the current working directory as the repo root. Write the sidecar JSON yourself; do not print findings as text.
3. **Invoke Codex** non-interactively from the repo root:
   ```
   cd "$(git rev-parse --show-toplevel)" && codex exec "<prompt>"
   ```
   Run via Bash. Capture stdout/stderr.
4. **Verify** the sidecar afterwards: it parses as JSON, `target.kind === "diff"`, the new review object exists in `reviews[]`, and each new comment has `id`, `location`, `body`, `quotedText`, `state: "open"`. If anything is malformed, surface Codex's output and ask the user how to proceed — **do not silently retry** and do not "fix" Codex's findings yourself.
5. **Report back** as usual (sidecar path, per-file count, top-3 findings, open command).

The voice in the sidecar is Codex's. Don't translate or paraphrase its findings before writing — they're being written by it directly via this delegation.

## Empty result

If after analysis you genuinely found no review-worthy issues, **don't write an empty review**. Tell the user that directly: `Reviewed N files, no significant issues to surface.` Save the noise.

## Rules

- Never edit code. Comments-only.
- Never modify or remove existing reviews/comments in the sidecar.
- IDs must be unique; timestamp+random format keeps them collision-free.
- Match `quotedText` to the actual line on the chosen side, character-for-character. If you're unsure of the exact text, re-read the file before writing the comment.
- If you decide to delegate the analysis pass to `/review` or `/security-review`, run that first, then translate its findings into structured comments here. The deliverable shape never changes.
- Keep comment bodies concrete and short. Suggest a fix, don't just diagnose.
