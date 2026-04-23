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

const store = {
  plan: null,
  drafts: [],
  reviews: [],
  nextDraftId: 1,
  view: null,
  showingPreview: false,
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

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

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
      r.comments.map((c) => ({ ...c, kind: r.status, review: r })),
    ),
  ];
  const decos = [];
  for (const t of all) {
    const end = Math.min(doc.lines, Math.max(1, t.endLine));
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

function buildThreadDOM(t) {
  const wrap = document.createElement("div");
  wrap.className = `thread-widget ${t.kind}`;
  // Stop CodeMirror from handling events inside the widget — otherwise its
  // content handler preventDefaults mousedown and focus never reaches our textarea.
  for (const ev of ["mousedown", "mouseup", "click", "keydown", "keyup", "input", "focusin"]) {
    wrap.addEventListener(ev, (e) => e.stopPropagation());
  }
  populateThreadDOM(wrap, t);
  return wrap;
}

function populateThreadDOM(wrap, t) {
  const header = document.createElement("div");
    header.className = "thread-header";
    const range = t.startLine === t.endLine ? `Line ${t.startLine}` : `Lines ${t.startLine}–${t.endLine}`;
    const snippet = t.quotedText ? ` · "${t.quotedText.replace(/\s+/g, " ").slice(0, 50)}${t.quotedText.length > 50 ? "…" : ""}"` : "";
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
      const status = t.kind === "addressed" ? "Addressed" : "Open";
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
      if (t.resolution) {
        const r = document.createElement("p");
        r.style.marginTop = "6px";
        r.innerHTML = `<span class="muted">Resolution:</span> ${escapeHtml(t.resolution)}`;
        body.appendChild(r);
      }
    }

  wrap.appendChild(body);
}

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      addDraft(startLine, endLine);
      return true;
    },
  },
});

function addDraft(startLine, endLine, quotedText = null) {
  // Dedupe only an *identical* anchor (same lines AND same quotedText).
  // Multiple selections on the same line produce distinct drafts.
  const existing = store.drafts.find(
    (d) =>
      d.startLine === startLine &&
      d.endLine === endLine &&
      (d.quotedText || null) === (quotedText || null),
  );
  if (existing) {
    focusDraft(existing.id);
    return;
  }
  const draft = {
    id: `draft-${store.nextDraftId++}`,
    startLine,
    endLine,
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

function refresh() {
  if (!store.view) return;
  store.view.dispatch({ effects: setThreadsEffect.of(null) });
  if (store.showingPreview) renderPreview();
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

async function submitReview(summary) {
  const comments = savedDrafts().map((d) => ({
    startLine: d.startLine,
    endLine: d.endLine,
    body: d.savedBody,
    quotedText: d.quotedText || undefined,
  }));
  if (comments.length === 0) return;

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

async function loadPlan() {
  store.plan = await fetchJSON("/api/plan");
  document.getElementById("plan-path").textContent = store.plan.path;
}

function draftsStorageKey() {
  return `plan-review:v1:drafts:${store.plan?.path || ""}`;
}

function persistDrafts() {
  if (!store.plan) return;
  try {
    localStorage.setItem(
      draftsStorageKey(),
      JSON.stringify({
        drafts: store.drafts,
        nextDraftId: store.nextDraftId,
      }),
    );
  } catch (err) {
    console.warn("Could not persist drafts:", err);
  }
}

function loadDraftsFromStorage() {
  if (!store.plan) return;
  try {
    const raw = localStorage.getItem(draftsStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.drafts)) {
      const maxLine = store.plan.lines || Infinity;
      store.drafts = data.drafts.filter(
        (d) =>
          d &&
          typeof d.id === "string" &&
          Number.isInteger(d.startLine) &&
          Number.isInteger(d.endLine) &&
          d.startLine >= 1 &&
          d.endLine <= maxLine,
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
  store.reviews = doc.reviews || [];
}

function renderPreview() {
  const wrap = document.getElementById("preview");

  // Preserve focus and scroll across re-renders
  const active = document.activeElement;
  const focusInfo =
    active && active.tagName === "TEXTAREA" && active.dataset.draft
      ? {
          draftId: active.dataset.draft,
          selStart: active.selectionStart,
          selEnd: active.selectionEnd,
        }
      : null;
  const scrollTop = wrap.scrollTop;

  wrap.innerHTML = `<div class="preview-wrap">${md.render(store.plan.content)}</div>`;
  const container = wrap.querySelector(".preview-wrap");

  // markdown-it's default fence renderer applies token attrs to <code>, not <pre>.
  // Hoist source-line attrs onto the top-level <pre> so the block is commentable.
  for (const code of container.querySelectorAll("pre > code[data-source-line]")) {
    const pre = code.parentElement;
    pre.dataset.sourceLine = code.dataset.sourceLine;
    pre.dataset.sourceEndLine = code.dataset.sourceEndLine;
    code.removeAttribute("data-source-line");
    code.removeAttribute("data-source-end-line");
  }

  // Decide which elements get a "+" affordance. For lists, skip the ul/ol
  // wrapper and anchor on each <li> so users can comment per-item.
  const anchors = [];
  for (const block of container.children) {
    if (block.tagName === "UL" || block.tagName === "OL") {
      for (const li of block.querySelectorAll("li[data-source-line]")) {
        anchors.push(li);
      }
    } else if (block.hasAttribute("data-source-line")) {
      anchors.push(block);
    }
  }
  for (const a of anchors) attachAddBtn(a);

  // Insert thread widgets anchored to the most-specific block containing the
  // comment's start line (prefers <li> over its enclosing <ul>).
  const blockList = [...container.querySelectorAll("[data-source-line]")];
  const threads = [
    ...store.drafts.map((d) => ({ ...d, kind: "draft" })),
    ...store.reviews.flatMap((r) =>
      r.comments.map((c) => ({ ...c, kind: r.status, review: r })),
    ),
  ];
  for (const t of threads) {
    const anchor = findPreviewAnchor(blockList, t.startLine);
    if (!anchor) continue;
    const dom = buildThreadDOM(t);
    dom.classList.add("in-preview");
    if (anchor.tagName === "LI") {
      anchor.appendChild(dom);
    } else {
      anchor.insertAdjacentElement("afterend", dom);
    }
  }

  wrap.scrollTop = scrollTop;
  if (focusInfo) {
    const ta = wrap.querySelector(
      `textarea[data-draft="${focusInfo.draftId}"]`,
    );
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
    addDraft(Number(btn.dataset.startLine), Number(btn.dataset.endLine));
  });
  el.appendChild(btn);
}

function findPreviewAnchor(blockList, line) {
  // Prefer the narrowest block whose range contains `line` (e.g. <li> over <ul>).
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

function applyView(view) {
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

function wireTopbar() {
  const toggle = document.getElementById("toggle-view");
  toggle.addEventListener("click", () => {
    const next = store.showingPreview ? "source" : "richer";
    applyView(next);
    writeViewToUrl(next);
  });

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
    const startLine = Number(btn.dataset.startLine);
    const endLine = Number(btn.dataset.endLine);
    const quoted = btn.dataset.quotedText || "";
    window.getSelection()?.removeAllRanges();
    btn.style.display = "none";
    if (Number.isInteger(startLine) && Number.isInteger(endLine)) {
      addDraft(startLine, endLine, quoted);
    }
  });
  document.body.appendChild(btn);
  return btn;
}

function hideFloatingBtn() {
  const btn = document.getElementById("floating-comment-btn");
  if (btn) btn.style.display = "none";
}

function findBlockWithSource(node) {
  let el = node && node.nodeType === 1 ? node : node?.parentElement;
  while (el && el !== document.body) {
    if (el.hasAttribute && el.hasAttribute("data-source-line")) return el;
    el = el.parentElement;
  }
  return null;
}

function wireSelectionButton() {
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
    // Ignore selections inside an existing thread widget
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
    btn.dataset.startLine = String(startLine);
    btn.dataset.endLine = String(endLine);
    btn.dataset.quotedText = quoted;
  };
  document.addEventListener("selectionchange", updater);
  window.addEventListener("scroll", hideFloatingBtn, true);
}

async function boot() {
  await loadPlan();
  loadDraftsFromStorage();
  await loadReviews();
  initEditor();
  wireTopbar();
  wireSelectionButton();
  applyView(viewFromUrl());
  updateSubmitButton();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:16px;color:#cf222e">${escapeHtml(err.message)}</pre>`;
});
