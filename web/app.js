import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  lineNumbers,
  gutter,
  GutterMarker,
  keymap,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

// ==================== STATE ====================

const store = {
  target: null,
  mode: null,
  drafts: [],
  reviews: [],
  nextDraftId: 1,
  // plan-mode
  plan: null,
  view: null,
  showingPreview: false,
  // diff-mode
  files: [],
  viewedFiles: new Set(),
  snapshots: [],
  fileCompareRange: {},
  // thread UI
  expandedLgtm: new Set(),
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.core.ruler.push("add_source_line", (state) => {
  for (const token of state.tokens) {
    if (!token.map) continue;
    if (
      token.type.endsWith("_open") ||
      token.type === "fence" ||
      token.type === "code_block" ||
      token.type === "hr" ||
      token.type === "html_block"
    ) {
      token.attrSet("data-source-line", String(token.map[0] + 1));
      token.attrSet("data-source-end-line", String(token.map[1]));
    }
  }
});

// ==================== HELPERS ====================

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commentKind(c) {
  return c.state || "open";
}

function commentStateLabel(state) {
  switch (state) {
    case "done": return "Done";
    case "ack": return "Ack";
    case "resolved": return "Resolved";
    case "lgtm": return "LGTM";
    case "addressed": return "Addressed";
    default: return "Open";
  }
}

function normalizeComment(c) {
  if (!c.location && Number.isInteger(c.startLine)) {
    c.location = { kind: "plan", startLine: c.startLine, endLine: c.endLine };
  }
  return c;
}

function locRangeLabel(loc) {
  if (!loc) return "";
  const prefix = loc.kind === "diff" ? `${loc.file} ${loc.side === "left" ? "L" : "R"}` : "Line";
  if (loc.kind === "diff") {
    if (loc.startLine === loc.endLine) return `${loc.file} ${loc.side === "left" ? "L" : "R"}${loc.startLine}`;
    return `${loc.file} ${loc.side === "left" ? "L" : "R"}${loc.startLine}–${loc.endLine}`;
  }
  if (loc.startLine === loc.endLine) return `Line ${loc.startLine}`;
  return `Lines ${loc.startLine}–${loc.endLine}`;
}

// ==================== THREAD DOM ====================

function isLgtmCollapsed(t) {
  return t.kind === "lgtm" && !store.expandedLgtm.has(t.id);
}

function buildThreadDOM(t) {
  const wrap = document.createElement("div");
  wrap.className = `thread-widget ${t.kind}`;
  if (isLgtmCollapsed(t)) wrap.classList.add("collapsed");
  for (const ev of ["mousedown", "mouseup", "click", "keydown", "keyup", "input", "focusin"]) {
    wrap.addEventListener(ev, (e) => e.stopPropagation());
  }
  populateThreadDOM(wrap, t);
  return wrap;
}

function toggleLgtmExpanded(commentId) {
  if (store.expandedLgtm.has(commentId)) store.expandedLgtm.delete(commentId);
  else store.expandedLgtm.add(commentId);
  refresh();
}

function populateThreadDOM(wrap, t) {
  if (isLgtmCollapsed(t)) {
    const bar = document.createElement("div");
    bar.className = "thread-collapsed-bar";
    bar.title = "Click to expand";
    const snippet = t.quotedText
      ? ` · "${t.quotedText.replace(/\s+/g, " ").slice(0, 50)}${t.quotedText.length > 50 ? "…" : ""}"`
      : "";
    bar.innerHTML =
      `<span class="lgtm-chip">LGTM</span>` +
      `<span class="muted">${escapeHtml(locRangeLabel(t.location))}${escapeHtml(snippet)}</span>` +
      `<span class="expand-hint">▾</span>`;
    bar.addEventListener("click", (e) => {
      e.preventDefault();
      toggleLgtmExpanded(t.id);
    });
    wrap.appendChild(bar);
    return;
  }

  const header = document.createElement("div");
  header.className = "thread-header";
  const range = locRangeLabel(t.location);
  const snippet = t.quotedText
    ? ` · "${t.quotedText.replace(/\s+/g, " ").slice(0, 50)}${t.quotedText.length > 50 ? "…" : ""}"`
    : "";
  if (t.kind === "draft") {
    const label = t.saved ? "Saved draft" : "Draft";
    header.innerHTML = `<span>${label} · ${range}${escapeHtml(snippet)}</span>`;
    if (t.saved) {
      const headerActions = document.createElement("span");
      headerActions.style.display = "inline-flex";
      headerActions.style.gap = "6px";

      const edit = document.createElement("button");
      edit.className = "btn btn-ghost";
      edit.style.padding = "2px 8px";
      edit.textContent = "Edit";
      edit.addEventListener("click", (e) => {
        e.preventDefault();
        editDraft(t.id);
      });
      headerActions.appendChild(edit);

      const del = document.createElement("button");
      del.className = "btn btn-ghost btn-danger";
      del.style.padding = "2px 8px";
      del.textContent = "Discard";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        removeDraft(t.id);
      });
      headerActions.appendChild(del);
      header.appendChild(headerActions);
    }
  } else {
    const status = commentStateLabel(t.kind);
    const summary = t.review?.summary ? ` · ${t.review.summary.slice(0, 60)}` : "";
    header.innerHTML = `<span>${status} · ${range}${escapeHtml(snippet)}${escapeHtml(summary)}</span>`;
  }
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "thread-body";

  if (t.kind === "draft") {
    if (t.saved) {
      const p = document.createElement("p");
      p.textContent = t.body || "";
      body.appendChild(p);
    } else {
      const composer = document.createElement("div");
      composer.className = "thread-composer";
      const ta = document.createElement("textarea");
      ta.placeholder = "Leave a comment...";
      ta.value = t.body || "";
      ta.dataset.draft = t.id;
      composer.appendChild(ta);

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.style.padding = "6px 0 0";
      actions.style.justifyContent = "flex-end";

      const cancel = document.createElement("button");
      cancel.className = "btn btn-ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", (e) => {
        e.preventDefault();
        cancelDraft(t.id);
      });
      actions.appendChild(cancel);

      const save = document.createElement("button");
      save.className = "btn btn-primary";
      save.textContent = "Save";
      save.disabled = !ta.value.trim();
      save.addEventListener("click", (e) => {
        e.preventDefault();
        saveDraft(t.id);
      });
      actions.appendChild(save);

      ta.addEventListener("input", () => {
        updateDraftBody(t.id, ta.value);
        save.disabled = !ta.value.trim();
      });
      ta.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !save.disabled) {
          e.preventDefault();
          saveDraft(t.id);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelDraft(t.id);
        }
      });

      composer.appendChild(actions);
      body.appendChild(composer);
    }
  } else {
    const p = document.createElement("p");
    p.textContent = t.body || "";
    body.appendChild(p);
    const note = t.resolutionNote || t.resolution;
    if (note) {
      const r = document.createElement("p");
      r.style.marginTop = "6px";
      r.innerHTML = `<span class="muted">Resolution:</span> ${escapeHtml(note)}`;
      body.appendChild(r);
    }
    body.appendChild(buildRepliesList(t));
    body.appendChild(buildReplyComposer(t));
    body.appendChild(buildStateActions(t));
  }

  wrap.appendChild(body);
}

function buildRepliesList(t) {
  const wrap = document.createElement("div");
  wrap.className = "replies-list";
  const replies = Array.isArray(t.replies) ? t.replies : [];
  if (replies.length === 0) return wrap;
  for (const rep of replies) {
    const el = document.createElement("div");
    el.className = `reply reply-${rep.author || "unknown"}`;
    const header = document.createElement("div");
    header.className = "reply-header";
    const when = rep.createdAt
      ? new Date(rep.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    header.innerHTML = `<span class="reply-author">${escapeHtml(rep.author || "")}</span><span class="muted">${escapeHtml(when)}</span>`;
    el.appendChild(header);
    const body = document.createElement("div");
    body.className = "reply-body";
    body.textContent = rep.body || "";
    el.appendChild(body);
    wrap.appendChild(el);
  }
  return wrap;
}

function buildReplyComposer(t) {
  const wrap = document.createElement("div");
  wrap.className = "reply-composer-wrap";
  if (!t.review?.id) return wrap;

  const toggle = document.createElement("button");
  toggle.className = "btn btn-ghost reply-toggle";
  toggle.textContent = "Reply";
  toggle.style.padding = "2px 10px";
  wrap.appendChild(toggle);

  const composer = document.createElement("div");
  composer.className = "reply-composer hidden";

  const ta = document.createElement("textarea");
  ta.placeholder = "Reply...";
  composer.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.padding = "6px 0 0";
  actions.style.justifyContent = "flex-end";

  const cancel = document.createElement("button");
  cancel.className = "btn btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", (e) => {
    e.preventDefault();
    ta.value = "";
    composer.classList.add("hidden");
    toggle.classList.remove("hidden");
  });

  const send = document.createElement("button");
  send.className = "btn btn-primary";
  send.textContent = "Send";
  send.disabled = true;
  send.addEventListener("click", async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      await fetchJSON(`/api/comments/${t.review.id}/${t.id}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "human", body }),
      });
    } catch (err) {
      alert(`Reply failed: ${err.message}`);
      send.disabled = false;
      return;
    }
    ta.value = "";
    composer.classList.add("hidden");
    toggle.classList.remove("hidden");
    await loadReviews();
    refresh();
  });

  ta.addEventListener("input", () => {
    send.disabled = !ta.value.trim();
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !send.disabled) {
      e.preventDefault();
      send.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel.click();
    }
  });

  actions.appendChild(cancel);
  actions.appendChild(send);
  composer.appendChild(actions);
  wrap.appendChild(composer);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    composer.classList.remove("hidden");
    toggle.classList.add("hidden");
    setTimeout(() => ta.focus(), 0);
  });

  return wrap;
}

function buildStateActions(t) {
  const row = document.createElement("div");
  row.className = "thread-actions";
  const reviewId = t.review?.id;
  if (!reviewId) return row;

  const mkBtn = (label, nextState, title) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost";
    b.style.padding = "2px 8px";
    b.textContent = label;
    b.title = title;
    b.disabled = t.kind === nextState;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      setCommentState(reviewId, t.id, nextState);
    });
    row.appendChild(b);
  };

  if (t.kind === "open") {
    mkBtn("LGTM", "lgtm", "Looks good to me — stamp this thread");
    mkBtn("Done", "done", "Mark as addressed");
    mkBtn("Ack", "ack", "Acknowledge, no change needed");
  } else {
    mkBtn("Reopen", "open", "Reopen this thread");
  }

  if (t.kind === "lgtm") {
    const collapse = document.createElement("button");
    collapse.className = "btn btn-ghost";
    collapse.style.padding = "2px 8px";
    collapse.textContent = "Collapse";
    collapse.title = "Collapse this LGTM thread";
    collapse.addEventListener("click", (e) => {
      e.preventDefault();
      toggleLgtmExpanded(t.id);
    });
    row.appendChild(collapse);
  }

  const lgtm = row.querySelector('button[title^="Looks good"]');
  if (lgtm) lgtm.classList.add("btn-lgtm");
  return row;
}

async function setCommentState(reviewId, commentId, nextState) {
  try {
    await fetchJSON(`/api/comments/${reviewId}/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: nextState }),
    });
  } catch (err) {
    alert(`Could not update comment: ${err.message}`);
    return;
  }
  await loadReviews();
  refresh();
}

// ==================== DRAFTS ====================

function draftsMatchLocation(d, loc) {
  if (d.location.kind !== loc.kind) return false;
  if (d.location.kind === "plan") {
    return d.location.startLine === loc.startLine && d.location.endLine === loc.endLine;
  }
  return (
    d.location.file === loc.file &&
    d.location.side === loc.side &&
    d.location.startLine === loc.startLine &&
    d.location.endLine === loc.endLine
  );
}

function addDraft(location, quotedText = null) {
  const existing = store.drafts.find(
    (d) => draftsMatchLocation(d, location) && (d.quotedText || null) === (quotedText || null),
  );
  if (existing) {
    focusDraft(existing.id);
    return;
  }
  const draft = {
    id: `draft-${store.nextDraftId++}`,
    location,
    quotedText: quotedText || null,
    body: "",
    saved: false,
    savedBody: null,
  };
  store.drafts.push(draft);
  refresh();
  setTimeout(() => focusDraft(draft.id), 0);
}

function focusDraft(id) {
  const ta = document.querySelector(`.thread-widget.draft textarea[data-draft="${id}"]`);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function removeDraft(id) {
  store.drafts = store.drafts.filter((d) => d.id !== id);
  refresh();
}

function saveDraft(id) {
  const d = store.drafts.find((x) => x.id === id);
  if (!d || !d.body.trim()) return;
  d.body = d.body.trim();
  d.saved = true;
  d.savedBody = d.body;
  refresh();
}

function editDraft(id) {
  const d = store.drafts.find((x) => x.id === id);
  if (!d) return;
  d.saved = false;
  refresh();
  setTimeout(() => focusDraft(id), 0);
}

function cancelDraft(id) {
  const d = store.drafts.find((x) => x.id === id);
  if (!d) return;
  if (d.savedBody == null) {
    removeDraft(id);
    return;
  }
  d.body = d.savedBody;
  d.saved = true;
  refresh();
}

function updateDraftBody(id, body) {
  const d = store.drafts.find((x) => x.id === id);
  if (d) d.body = body;
  persistDrafts();
  updateSubmitButton();
}

function savedDrafts() {
  return store.drafts.filter((d) => d.saved && d.savedBody && d.savedBody.trim());
}

function updateSubmitButton() {
  const btn = document.getElementById("submit-review");
  const count = document.getElementById("draft-count");
  const n = savedDrafts().length;
  btn.disabled = n === 0;
  count.textContent = String(n);
}

function refresh() {
  if (store.mode === "plan") refreshPlan();
  else refreshDiff();
  persistDrafts();
  updateSubmitButton();
}

// Identifier for persistence keys + viewed-files keys.
function targetKey() {
  if (!store.target) return "";
  if (store.target.kind === "plan") return `plan:${store.target.path}`;
  return `diff:${store.target.repoRoot}:${store.target.slug}`;
}

function draftsStorageKey() {
  return `plan-review:v2:drafts:${targetKey()}`;
}

function persistDrafts() {
  if (!store.target) return;
  try {
    localStorage.setItem(
      draftsStorageKey(),
      JSON.stringify({ drafts: store.drafts, nextDraftId: store.nextDraftId }),
    );
  } catch (err) {
    console.warn("Could not persist drafts:", err);
  }
}

function loadDraftsFromStorage() {
  if (!store.target) return;
  try {
    const raw = localStorage.getItem(draftsStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.drafts)) {
      store.drafts = data.drafts.filter(
        (d) =>
          d &&
          typeof d.id === "string" &&
          d.location &&
          Number.isInteger(d.location.startLine) &&
          Number.isInteger(d.location.endLine),
      );
    }
    if (Number.isInteger(data.nextDraftId) && data.nextDraftId > 0) {
      store.nextDraftId = data.nextDraftId;
    }
  } catch (err) {
    console.warn("Could not restore drafts:", err);
  }
}

async function loadReviews() {
  const doc = await fetchJSON("/api/reviews");
  store.reviews = (doc.reviews || []).map((r) => ({
    ...r,
    comments: r.comments.map(normalizeComment),
  }));
  renderAttentionPill();
}

function lastActorOnComment(c) {
  const replies = Array.isArray(c.replies) ? c.replies : [];
  if (replies.length > 0) return replies[replies.length - 1].author || "human";
  return "human";
}

function renderAttentionPill() {
  const el = document.getElementById("attention-pill");
  if (!el) return;
  const openComments = store.reviews.flatMap((r) =>
    r.comments.filter((c) => (c.state || "open") === "open"),
  );
  el.classList.remove("hidden", "turn-claude", "turn-you");
  if (openComments.length === 0) {
    el.classList.add("turn-you");
    el.textContent = "Your turn";
    el.title = "All comments closed. Leave more, or submit another review round.";
    return;
  }
  const awaitingClaude = openComments.some((c) => lastActorOnComment(c) === "human");
  if (awaitingClaude) {
    el.classList.add("turn-claude");
    el.textContent = "Claude's turn";
    el.title = "Open comments are waiting on Claude (apply or reply).";
  } else {
    el.classList.add("turn-you");
    el.textContent = "Your turn";
    el.title = "Claude has replied on open comments — review and respond.";
  }
}

async function loadSnapshots() {
  try {
    store.snapshots = await fetchJSON("/api/snapshots");
  } catch {
    store.snapshots = [];
  }
}

async function submitReview(summary) {
  const drafts = savedDrafts();
  if (drafts.length === 0) return;
  const comments = drafts.map((d) => {
    if (d.location.kind === "plan") {
      return {
        startLine: d.location.startLine,
        endLine: d.location.endLine,
        body: d.savedBody,
        quotedText: d.quotedText || undefined,
      };
    }
    return {
      location: {
        kind: "diff",
        file: d.location.file,
        side: d.location.side,
        startLine: d.location.startLine,
        endLine: d.location.endLine,
      },
      body: d.savedBody,
      quotedText: d.quotedText || undefined,
    };
  });

  try {
    await fetchJSON("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary, comments }),
    });
  } catch (err) {
    alert(`Submit failed: ${err.message}`);
    return;
  }
  store.drafts = [];
  await loadReviews();
  refresh();
}

function wireSubmitDialog() {
  const submitBtn = document.getElementById("submit-review");
  const dialog = document.getElementById("submit-dialog");
  const summaryLine = document.getElementById("submit-summary-line");
  const summaryTA = document.getElementById("summary");

  submitBtn.addEventListener("click", () => {
    const n = savedDrafts().length;
    summaryLine.textContent = `${n} saved comment${n === 1 ? "" : "s"} will be submitted.`;
    summaryTA.value = "";
    dialog.showModal();
  });

  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") {
      submitReview(summaryTA.value.trim());
    }
  });
}

// ==================== PLAN MODE ====================

const setThreadsEffect = StateEffect.define();

const threadsField = StateField.define({
  create: () => 0,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setThreadsEffect)) return value + 1;
    return value;
  },
});

const threadDecorations = EditorView.decorations.compute([threadsField], (state) => {
  const doc = state.doc;
  const all = [
    ...store.drafts.map((d) => ({ ...d, kind: "draft" })),
    ...store.reviews.flatMap((r) =>
      r.comments
        .filter((c) => !c.location || c.location.kind === "plan")
        .map((c) => ({ ...c, kind: commentKind(c), review: r })),
    ),
  ];
  const decos = [];
  for (const t of all) {
    const loc = t.location || { startLine: t.startLine, endLine: t.endLine };
    const end = Math.min(doc.lines, Math.max(1, loc.endLine));
    const line = doc.line(end);
    decos.push(
      Decoration.widget({
        widget: new ThreadWidget(t),
        block: true,
        side: 1,
      }).range(line.to),
    );
  }
  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(decos);
});

class ThreadWidget extends WidgetType {
  constructor(thread) {
    super();
    this.thread = thread;
  }
  eq(other) {
    return JSON.stringify(other.thread) === JSON.stringify(this.thread);
  }
  ignoreEvent() {
    return false;
  }
  toDOM() {
    return buildThreadDOM(this.thread);
  }
}

class AddCommentMarker extends GutterMarker {
  constructor(line) {
    super();
    this.line = line;
  }
  eq(other) {
    return other.line === this.line;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-add-comment-marker";
    el.textContent = "+";
    el.title = "Add comment on this line (or current selection)";
    el.dataset.line = String(this.line);
    return el;
  }
}

const addCommentGutter = gutter({
  class: "cm-add-comment-gutter",
  lineMarker(view, line) {
    const lineNum = view.state.doc.lineAt(line.from).number;
    return new AddCommentMarker(lineNum);
  },
  initialSpacer: () => new AddCommentMarker(0),
  domEventHandlers: {
    mousedown(view, line, event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("cm-add-comment-marker")) {
        return false;
      }
      event.preventDefault();
      const clickedLine = view.state.doc.lineAt(line.from).number;
      const sel = view.state.selection.main;
      let startLine, endLine;
      if (!sel.empty) {
        startLine = view.state.doc.lineAt(sel.from).number;
        endLine = view.state.doc.lineAt(sel.to).number;
      } else {
        startLine = endLine = clickedLine;
      }
      addDraft({ kind: "plan", startLine, endLine });
      return true;
    },
  },
});

function refreshPlan() {
  if (!store.view) return;
  store.view.dispatch({ effects: setThreadsEffect.of(null) });
  if (store.showingPreview) renderPreview();
}

async function loadPlan() {
  store.plan = await fetchJSON("/api/plan");
  document.getElementById("target-path").textContent = store.plan.path;
}

function renderPreview() {
  const wrap = document.getElementById("preview");
  const active = document.activeElement;
  const focusInfo =
    active && active.tagName === "TEXTAREA" && active.dataset.draft
      ? { draftId: active.dataset.draft, selStart: active.selectionStart, selEnd: active.selectionEnd }
      : null;
  const scrollTop = wrap.scrollTop;

  wrap.innerHTML = `<div class="preview-wrap">${md.render(store.plan.content)}</div>`;
  const container = wrap.querySelector(".preview-wrap");

  for (const code of container.querySelectorAll("pre > code[data-source-line]")) {
    const pre = code.parentElement;
    pre.dataset.sourceLine = code.dataset.sourceLine;
    pre.dataset.sourceEndLine = code.dataset.sourceEndLine;
    code.removeAttribute("data-source-line");
    code.removeAttribute("data-source-end-line");
  }

  const anchors = [];
  for (const block of container.children) {
    if (block.tagName === "UL" || block.tagName === "OL") {
      for (const li of block.querySelectorAll("li[data-source-line]")) anchors.push(li);
    } else if (block.hasAttribute("data-source-line")) {
      anchors.push(block);
    }
  }
  for (const a of anchors) attachAddBtn(a);

  const blockList = [...container.querySelectorAll("[data-source-line]")];
  const threads = [
    ...store.drafts.map((d) => ({ ...d, kind: "draft" })),
    ...store.reviews.flatMap((r) =>
      r.comments
        .filter((c) => !c.location || c.location.kind === "plan")
        .map((c) => ({ ...c, kind: commentKind(c), review: r })),
    ),
  ];
  for (const t of threads) {
    const loc = t.location || { startLine: t.startLine, endLine: t.endLine };
    const anchor = findPreviewAnchor(blockList, loc.startLine);
    if (!anchor) continue;
    const dom = buildThreadDOM(t);
    dom.classList.add("in-preview");
    if (anchor.tagName === "LI") anchor.appendChild(dom);
    else anchor.insertAdjacentElement("afterend", dom);
  }

  wrap.scrollTop = scrollTop;
  if (focusInfo) {
    const ta = wrap.querySelector(`textarea[data-draft="${focusInfo.draftId}"]`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(focusInfo.selStart, focusInfo.selEnd);
    }
  }
}

function attachAddBtn(el) {
  el.classList.add("md-block");
  const btn = document.createElement("button");
  btn.className = "md-add-btn";
  btn.type = "button";
  btn.textContent = "+";
  btn.title = "Add comment on this block";
  btn.dataset.startLine = el.dataset.sourceLine;
  btn.dataset.endLine = el.dataset.sourceEndLine;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    addDraft({
      kind: "plan",
      startLine: Number(btn.dataset.startLine),
      endLine: Number(btn.dataset.endLine),
    });
  });
  el.appendChild(btn);
}

function findPreviewAnchor(blockList, line) {
  let best = null;
  let bestSpan = Infinity;
  for (const b of blockList) {
    const s = Number(b.dataset.sourceLine);
    const e = Number(b.dataset.sourceEndLine);
    if (s <= line && line <= e) {
      const span = e - s;
      if (span < bestSpan) {
        best = b;
        bestSpan = span;
      }
    }
  }
  if (best) return best;
  let last = null;
  for (const b of blockList) {
    if (Number(b.dataset.sourceLine) <= line) last = b;
  }
  return last || blockList[0] || null;
}

function initEditor() {
  const state = EditorState.create({
    doc: store.plan.content,
    extensions: [
      lineNumbers(),
      addCommentGutter,
      markdown(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      threadsField,
      threadDecorations,
      keymap.of(defaultKeymap),
    ],
  });
  store.view = new EditorView({
    state,
    parent: document.getElementById("editor"),
  });
}

function applyPlanView(view) {
  const editor = document.getElementById("editor");
  const preview = document.getElementById("preview");
  const toggle = document.getElementById("toggle-view");
  store.showingPreview = view === "richer";
  if (store.showingPreview) {
    renderPreview();
    editor.classList.add("hidden");
    preview.classList.remove("hidden");
    toggle.textContent = "Source";
  } else {
    editor.classList.remove("hidden");
    preview.classList.add("hidden");
    toggle.textContent = "Richer";
  }
}

function viewFromUrl() {
  const v = new URL(location.href).searchParams.get("view");
  return v === "richer" ? "richer" : "source";
}

function writeViewToUrl(view) {
  const url = new URL(location.href);
  if (view === "richer") url.searchParams.set("view", "richer");
  else url.searchParams.delete("view");
  history.replaceState(null, "", url);
}

function wirePlanTopbar() {
  const toggle = document.getElementById("toggle-view");
  toggle.addEventListener("click", () => {
    const next = store.showingPreview ? "source" : "richer";
    applyPlanView(next);
    writeViewToUrl(next);
  });
}

function findBlockWithSource(node) {
  let el = node && node.nodeType === 1 ? node : node?.parentElement;
  while (el && el !== document.body) {
    if (el.hasAttribute && el.hasAttribute("data-source-line")) return el;
    el = el.parentElement;
  }
  return null;
}

function getFloatingCommentBtn() {
  let btn = document.getElementById("floating-comment-btn");
  if (btn) return btn;
  btn = document.createElement("button");
  btn.id = "floating-comment-btn";
  btn.type = "button";
  btn.textContent = "💬 Comment";
  btn.style.display = "none";
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const loc = JSON.parse(btn.dataset.location || "null");
    const quoted = btn.dataset.quotedText || "";
    window.getSelection()?.removeAllRanges();
    btn.style.display = "none";
    if (loc) addDraft(loc, quoted);
  });
  document.body.appendChild(btn);
  return btn;
}

function hideFloatingBtn() {
  const btn = document.getElementById("floating-comment-btn");
  if (btn) btn.style.display = "none";
}

function wirePlanSelectionButton() {
  const btn = getFloatingCommentBtn();
  const updater = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideFloatingBtn();
      return;
    }
    const range = sel.getRangeAt(0);
    const quoted = sel.toString();
    if (!quoted.trim()) {
      hideFloatingBtn();
      return;
    }
    const ancestor =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!ancestor) {
      hideFloatingBtn();
      return;
    }
    const inSource = ancestor.closest("#editor");
    const inPreview = ancestor.closest("#preview");
    if (!inSource && !inPreview) {
      hideFloatingBtn();
      return;
    }
    if (ancestor.closest(".thread-widget")) {
      hideFloatingBtn();
      return;
    }
    let startLine, endLine;
    if (inSource && store.view) {
      const s = store.view.state.selection.main;
      if (s.empty) {
        hideFloatingBtn();
        return;
      }
      startLine = store.view.state.doc.lineAt(s.from).number;
      endLine = store.view.state.doc.lineAt(s.to).number;
    } else {
      const startBlock = findBlockWithSource(range.startContainer);
      const endBlock = findBlockWithSource(range.endContainer);
      if (!startBlock || !endBlock) {
        hideFloatingBtn();
        return;
      }
      startLine = Number(startBlock.dataset.sourceLine);
      endLine = Number(endBlock.dataset.sourceEndLine);
    }
    const rect = range.getBoundingClientRect();
    btn.style.display = "inline-flex";
    btn.style.left = `${rect.right + window.scrollX + 6}px`;
    btn.style.top = `${rect.top + window.scrollY - 4}px`;
    btn.dataset.location = JSON.stringify({ kind: "plan", startLine, endLine });
    btn.dataset.quotedText = quoted;
  };
  document.addEventListener("selectionchange", updater);
  window.addEventListener("scroll", hideFloatingBtn, true);
}

async function bootPlanMode(target) {
  store.target = target;
  store.mode = "plan";
  document.body.classList.add("mode-plan");
  await loadPlan();
  loadDraftsFromStorage();
  await loadReviews();
  initEditor();
  wirePlanTopbar();
  wirePlanSelectionButton();
  wireSubmitDialog();
  applyPlanView(viewFromUrl());
  updateSubmitButton();
}

// ==================== DIFF MODE ====================

function viewedStorageKey() {
  return `plan-review:v2:viewed:${targetKey()}`;
}

function loadViewedFromStorage() {
  try {
    const raw = localStorage.getItem(viewedStorageKey());
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) store.viewedFiles = new Set(arr);
  } catch {}
}

function persistViewed() {
  try {
    localStorage.setItem(viewedStorageKey(), JSON.stringify([...store.viewedFiles]));
  } catch {}
}

function snapshotPills() {
  const pills = [{ ref: "BASE", label: "Base", kind: "base" }];
  for (const s of store.snapshots) {
    pills.push({
      ref: s.id,
      label: s.createdAt
        ? new Date(s.createdAt).toLocaleString([], {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })
        : s.id.slice(0, 10),
      kind: "snapshot",
    });
  }
  pills.push({ ref: "CURRENT", label: "Current", kind: "current" });
  return pills;
}

function getCompareRange(filePath) {
  const pills = snapshotPills();
  const existing = store.fileCompareRange[filePath];
  if (existing && existing.from >= 0 && existing.to < pills.length && existing.from < existing.to) {
    return existing;
  }
  return { from: 0, to: pills.length - 1 };
}

function setCompareRange(filePath, range) {
  store.fileCompareRange[filePath] = range;
}

async function fetchFileDiff(filePath, range) {
  const pills = snapshotPills();
  const fromRef = pills[range.from]?.ref || "BASE";
  const toRef = pills[range.to]?.ref || "CURRENT";
  const qs = `path=${encodeURIComponent(filePath)}&from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`;
  return fetchJSON(`/api/diff/file?${qs}`);
}

function commentsForFile(file) {
  const threads = [];
  for (const r of store.reviews) {
    for (const c of r.comments) {
      if (c.location?.kind === "diff" && c.location.file === file) {
        threads.push({ ...c, kind: commentKind(c), review: r });
      }
    }
  }
  for (const d of store.drafts) {
    if (d.location?.kind === "diff" && d.location.file === file) {
      threads.push({ ...d, kind: "draft" });
    }
  }
  return threads;
}

function renderFileTree() {
  const tree = document.getElementById("file-tree");
  tree.innerHTML = "";
  const header = document.createElement("div");
  header.className = "file-tree-header";
  const viewed = store.files.filter((f) => store.viewedFiles.has(f.path)).length;
  header.textContent = `${viewed} / ${store.files.length} reviewed`;
  tree.appendChild(header);

  const sorted = [...store.files.entries()].sort(([ai, a], [bi, b]) => {
    const av = store.viewedFiles.has(a.path) ? 1 : 0;
    const bv = store.viewedFiles.has(b.path) ? 1 : 0;
    if (av !== bv) return av - bv;
    return ai - bi;
  });

  const ul = document.createElement("ul");
  for (const [, f] of sorted) {
    const li = document.createElement("li");
    li.dataset.file = f.path;
    const isViewed = store.viewedFiles.has(f.path);
    if (isViewed) li.classList.add("viewed");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "viewed-toggle";
    toggle.setAttribute("aria-pressed", String(isViewed));
    toggle.title = isViewed ? "Mark unreviewed" : "Mark reviewed";
    toggle.innerHTML = isViewed ? "✓" : "";
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      toggleViewed(f.path);
    });

    const link = document.createElement("a");
    link.className = "file-link";
    link.href = `#file-${cssEscape(f.path)}`;
    link.innerHTML =
      `<span class="file-status file-status-${f.status}" title="${f.status}">${statusGlyph(f.status)}</span>` +
      `<span class="file-path">${escapeHtml(f.path)}</span>`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const section = document.getElementById(`file-${f.path}`);
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    li.appendChild(toggle);
    li.appendChild(link);

    const badge = commentsForFile(f.path).filter((t) => t.kind !== "draft" && t.kind !== "resolved").length;
    if (badge > 0) {
      const b = document.createElement("span");
      b.className = "file-comment-count";
      b.textContent = String(badge);
      li.appendChild(b);
    }

    ul.appendChild(li);
  }
  tree.appendChild(ul);
}

function toggleViewed(filePath) {
  if (store.viewedFiles.has(filePath)) store.viewedFiles.delete(filePath);
  else store.viewedFiles.add(filePath);
  persistViewed();
  renderFileTree();
}

function statusGlyph(status) {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    default: return "M";
  }
}

const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml",
  json: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less",
  sql: "sql",
  lua: "lua",
  r: "r",
  ini: "ini", toml: "ini",
};

function langForFile(filePath) {
  const base = filePath.split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  const lang = LANG_BY_EXT[ext];
  if (lang && hljs.getLanguage(lang)) return lang;
  return null;
}

function highlightText(text, lang) {
  if (!text) return "";
  if (!lang) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function cssEscape(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function renderDiffPane() {
  const pane = document.getElementById("diff-pane");
  pane.innerHTML = "";

  for (const f of store.files) {
    const section = document.createElement("section");
    section.className = "file-section";
    section.id = `file-${f.path}`;
    section.dataset.file = f.path;
    pane.appendChild(section);
    await renderFileSection(f, section);
  }

  insertDiffThreads();
}

async function renderFileSection(f, section) {
  section.innerHTML = "";

  const header = document.createElement("header");
  header.className = "file-section-header";

  const title = document.createElement("div");
  title.className = "file-section-title";
  title.innerHTML =
    `<span class="file-status file-status-${f.status}">${statusGlyph(f.status)}</span>` +
    `<span class="file-path">${escapeHtml(f.path)}</span>`;
  header.appendChild(title);

  if (store.snapshots.length > 0) {
    header.appendChild(buildSnapshotPicker(f));
  }

  section.appendChild(header);

  const diffWrap = document.createElement("div");
  diffWrap.className = "diff-table-wrap";
  section.appendChild(diffWrap);

  const range = getCompareRange(f.path);
  try {
    const data = await fetchFileDiff(f.path, range);
    diffWrap.appendChild(renderSideBySideTable(f.path, data.sideBySide));
  } catch (err) {
    diffWrap.textContent = `Could not load diff: ${err.message}`;
  }
}

function buildSnapshotPicker(f) {
  const pills = snapshotPills();
  const range = getCompareRange(f.path);
  const wrap = document.createElement("div");
  wrap.className = "snapshot-picker";
  wrap.title = "Click to set To; Shift-click to set From";

  pills.forEach((pill, i) => {
    const b = document.createElement("button");
    b.className = "snap-pill";
    b.dataset.ref = pill.ref;
    b.dataset.kind = pill.kind;
    b.textContent = pill.label;
    if (i === range.from) b.classList.add("selected-from");
    if (i === range.to) b.classList.add("selected-to");
    if (i > range.from && i < range.to) b.classList.add("in-range");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.shiftKey) shiftClickPill(f, i);
      else clickPill(f, i);
    });
    wrap.appendChild(b);
  });

  return wrap;
}

function clickPill(f, i) {
  const pills = snapshotPills();
  const range = { ...getCompareRange(f.path) };
  if (i === range.from || i === range.to) return;
  if (i < range.from) range.from = i;
  else if (i > range.to) range.to = i;
  else {
    const distFrom = i - range.from;
    const distTo = range.to - i;
    if (distFrom < distTo) range.from = i;
    else range.to = i;
  }
  if (range.from >= range.to) return;
  setCompareRange(f.path, range);
  rerenderFileSection(f);
}

function shiftClickPill(f, i) {
  const pills = snapshotPills();
  const range = { ...getCompareRange(f.path) };
  if (i >= range.to) range.to = Math.min(pills.length - 1, i + 1);
  range.from = i;
  if (range.from >= range.to) return;
  setCompareRange(f.path, range);
  rerenderFileSection(f);
}

async function rerenderFileSection(f) {
  const section = document.getElementById(`file-${f.path}`);
  if (!section) return;
  await renderFileSection(f, section);
  insertDiffThreads();
}

function renderSideBySideTable(filePath, hunks) {
  const table = document.createElement("table");
  table.className = "diff-table hljs";
  const lang = langForFile(filePath);
  for (let i = 0; i < hunks.length; i++) {
    if (i > 0) {
      const tr = document.createElement("tr");
      tr.className = "diff-gap";
      tr.innerHTML = `<td colspan="4">…</td>`;
      table.appendChild(tr);
    }
    for (const row of hunks[i].rows) {
      const tr = document.createElement("tr");
      tr.className = "diff-row";
      tr.dataset.file = filePath;
      if (row.left) tr.dataset.leftLine = String(row.left.line);
      if (row.right) tr.dataset.rightLine = String(row.right.line);

      const lnL = document.createElement("td");
      lnL.className = "ln ln-left";
      lnL.textContent = row.left ? String(row.left.line) : "";
      if (row.left && row.left.kind !== " ") {
        lnL.classList.add(`kind-${row.left.kind === "-" ? "del" : "add"}`);
      }
      lnL.addEventListener("click", (e) => {
        if (!row.left) return;
        e.preventDefault();
        addDraft(
          { kind: "diff", file: filePath, side: "left", startLine: row.left.line, endLine: row.left.line },
          row.left.text,
        );
      });
      tr.appendChild(lnL);

      const txL = document.createElement("td");
      txL.className = "tx tx-left";
      if (row.left) {
        if (row.left.kind !== " ") txL.classList.add(`kind-${row.left.kind === "-" ? "del" : "add"}`);
        txL.innerHTML = highlightText(row.left.text, lang);
      }
      tr.appendChild(txL);

      const lnR = document.createElement("td");
      lnR.className = "ln ln-right";
      lnR.textContent = row.right ? String(row.right.line) : "";
      if (row.right && row.right.kind !== " ") {
        lnR.classList.add(`kind-${row.right.kind === "-" ? "del" : "add"}`);
      }
      lnR.addEventListener("click", (e) => {
        if (!row.right) return;
        e.preventDefault();
        addDraft(
          { kind: "diff", file: filePath, side: "right", startLine: row.right.line, endLine: row.right.line },
          row.right.text,
        );
      });
      tr.appendChild(lnR);

      const txR = document.createElement("td");
      txR.className = "tx tx-right";
      if (row.right) {
        if (row.right.kind !== " ") txR.classList.add(`kind-${row.right.kind === "-" ? "del" : "add"}`);
        txR.innerHTML = highlightText(row.right.text, lang);
      }
      tr.appendChild(txR);

      table.appendChild(tr);
    }
  }
  return table;
}

function insertDiffThreads() {
  // Clear any existing thread rows first.
  for (const tr of document.querySelectorAll(".diff-thread-row")) tr.remove();

  for (const f of store.files) {
    const threads = commentsForFile(f.path);
    for (const t of threads) {
      const loc = t.location;
      const selector = `tr.diff-row[data-file="${cssAttr(f.path)}"][data-${loc.side}-line="${loc.endLine}"]`;
      const anchor = document.querySelector(selector);
      if (!anchor) continue;
      const threadRow = document.createElement("tr");
      threadRow.className = `diff-thread-row side-${loc.side}`;
      const cell = document.createElement("td");
      cell.colSpan = 4;
      const dom = buildThreadDOM(t);
      dom.classList.add("in-diff");
      cell.appendChild(dom);
      threadRow.appendChild(cell);
      anchor.insertAdjacentElement("afterend", threadRow);
    }
  }
}

function cssAttr(s) {
  return s.replace(/"/g, '\\"');
}

function refreshDiff() {
  renderFileTree();
  insertDiffThreads();
}

async function bootDiffMode(target) {
  store.target = target;
  store.mode = "diff";
  store.files = target.files;
  document.body.classList.add("mode-diff");
  document.getElementById("editor").classList.add("hidden");
  document.getElementById("preview").classList.add("hidden");
  document.getElementById("diff-layout").classList.remove("hidden");
  document.getElementById("target-path").textContent =
    `${target.repoRoot} · ${target.base}..${target.head}`;

  loadViewedFromStorage();
  loadDraftsFromStorage();
  await loadReviews();
  await loadSnapshots();
  renderFileTree();
  await renderDiffPane();
  wireSubmitDialog();
  wireDiffKeyboard();
  updateSubmitButton();
}

// ==================== DIFF KEYBOARD NAVIGATION ====================

const DIFF_SCROLL_MARGIN = 16;

function wireDiffKeyboard() {
  document.addEventListener("keydown", handleDiffKey);
}

function handleDiffKey(e) {
  if (store.mode !== "diff") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
  const dialog = document.getElementById("shortcuts-dialog");
  if (dialog && dialog.open) return;

  switch (e.key) {
    case "j": e.preventDefault(); scrollAnchors(fileAnchors(), 1); break;
    case "k": e.preventDefault(); scrollAnchors(fileAnchors(), -1); break;
    case "n": e.preventDefault(); scrollAnchors(chunkAnchors(), 1); break;
    case "p": e.preventDefault(); scrollAnchors(chunkAnchors(), -1); break;
    case "N": e.preventDefault(); scrollAnchors(threadAnchors(), 1); break;
    case "P": e.preventDefault(); scrollAnchors(threadAnchors(), -1); break;
    case "v":
    case "r": e.preventDefault(); toggleCurrentFileViewed(); break;
    case "?": e.preventDefault(); showShortcutsHelp(); break;
  }
}

function fileAnchors() {
  return [...document.querySelectorAll(".file-section")];
}

function threadAnchors() {
  return [...document.querySelectorAll("#diff-pane .thread-widget.in-diff")];
}

function chunkAnchors() {
  const rows = document.querySelectorAll("tr.diff-row");
  const chunks = [];
  let prevChanged = false;
  for (const r of rows) {
    const changed = !!r.querySelector(".kind-add, .kind-del");
    if (changed && !prevChanged) chunks.push(r);
    prevChanged = changed;
  }
  return chunks;
}

function scrollAnchors(anchors, direction) {
  if (!anchors.length) return;
  const pane = document.getElementById("diff-pane");
  const paneTop = pane ? pane.getBoundingClientRect().top : 0;
  if (direction === 1) {
    for (const a of anchors) {
      if (a.getBoundingClientRect().top > paneTop + DIFF_SCROLL_MARGIN) {
        a.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
    }
  } else {
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i].getBoundingClientRect().top < paneTop - DIFF_SCROLL_MARGIN) {
        anchors[i].scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
    }
  }
}

function currentFileSection() {
  const sections = [...document.querySelectorAll(".file-section")];
  const pane = document.getElementById("diff-pane");
  const paneTop = pane ? pane.getBoundingClientRect().top : 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].getBoundingClientRect().top <= paneTop + 1) return sections[i];
  }
  return sections[0] || null;
}

function toggleCurrentFileViewed() {
  const section = currentFileSection();
  if (!section) return;
  toggleViewed(section.dataset.file);
}

function showShortcutsHelp() {
  let dialog = document.getElementById("shortcuts-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "shortcuts-dialog";
    dialog.innerHTML = `
      <form method="dialog">
        <h2>Keyboard shortcuts</h2>
        <table class="shortcut-table">
          <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>Next / previous file</td></tr>
          <tr><td><kbd>n</kbd> / <kbd>p</kbd></td><td>Next / previous change</td></tr>
          <tr><td><kbd>N</kbd> / <kbd>P</kbd></td><td>Next / previous comment</td></tr>
          <tr><td><kbd>v</kbd> / <kbd>r</kbd></td><td>Toggle reviewed on current file</td></tr>
          <tr><td><kbd>?</kbd></td><td>Show this dialog</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close this dialog</td></tr>
        </table>
        <menu>
          <button value="close" class="btn btn-primary">Close</button>
        </menu>
      </form>
    `;
    document.body.appendChild(dialog);
  }
  dialog.showModal();
}

// ==================== BOOT ====================

async function boot() {
  const target = await fetchJSON("/api/target");
  if (target.kind === "plan") return bootPlanMode(target);
  if (target.kind === "diff") return bootDiffMode(target);
  throw new Error(`Unknown target kind: ${target.kind}`);
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:16px;color:#cf222e">${escapeHtml(err.message)}</pre>`;
});
