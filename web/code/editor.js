import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, WidgetType } from 'https://esm.sh/@codemirror/view@6';
import { EditorState, StateField, StateEffect, Prec } from 'https://esm.sh/@codemirror/state@6';
import { defaultKeymap, history, historyKeymap, indentWithTab } from 'https://esm.sh/@codemirror/commands@6';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from 'https://esm.sh/@codemirror/language@6';
import { javascript } from 'https://esm.sh/@codemirror/lang-javascript@6';
import { python } from 'https://esm.sh/@codemirror/lang-python@6';
import { css as cssLang } from 'https://esm.sh/@codemirror/lang-css@6';
import { html as htmlLang } from 'https://esm.sh/@codemirror/lang-html@6';
import { json as jsonLang } from 'https://esm.sh/@codemirror/lang-json@6';
import { markdown as markdownLang } from 'https://esm.sh/@codemirror/lang-markdown@6';
import { diffLines } from 'https://esm.sh/diff@5';

// If esm.sh import specifiers ever fail to resolve (check the browser console
// for 404/CORS errors), the spec allows jsdelivr's `+esm` as a fallback CDN,
// e.g. https://cdn.jsdelivr.net/npm/@codemirror/state@6/+esm — swap the
// import URLs above, keeping the same `@6` pin on every package so esm.sh/
// jsdelivr resolve a single shared copy of @codemirror/state internally.

const LANG_BY_EXT = {
  js: javascript(), jsx: javascript({ jsx: true }),
  ts: javascript({ typescript: true }), tsx: javascript({ typescript: true, jsx: true }),
  py: python(), css: cssLang(), html: htmlLang(), json: jsonLang(), md: markdownLang(),
};

function langExtensionFor(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return LANG_BY_EXT[ext] ? [LANG_BY_EXT[ext]] : [];
}

function detectLangLabel(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', css: 'css', html: 'html', json: 'json', md: 'markdown' }[ext] || 'plaintext';
}

export function openFolderPicker(fileProvider, startPath, onSelect) {
  return new Promise(resolve => {
    let browsePath = startPath || '';
    const overlay = document.createElement('div');
    overlay.className = 'code-folder-picker-overlay';
    overlay.innerHTML = `
      <div class="code-folder-picker">
        <div class="code-folder-picker-path"></div>
        <div class="code-folder-picker-error hidden"></div>
        <ul class="code-folder-picker-list"></ul>
        <div class="code-folder-picker-actions">
          <button type="button" class="code-folder-picker-up">.. Up</button>
          <button type="button" class="code-folder-picker-select">Select this folder</button>
          <button type="button" class="code-folder-picker-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const pathEl    = overlay.querySelector('.code-folder-picker-path');
    const errEl     = overlay.querySelector('.code-folder-picker-error');
    const listEl    = overlay.querySelector('.code-folder-picker-list');
    const upBtn     = overlay.querySelector('.code-folder-picker-up');
    const selectBtn = overlay.querySelector('.code-folder-picker-select');
    const cancelBtn = overlay.querySelector('.code-folder-picker-cancel');

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    async function load(path) {
      errEl.classList.add('hidden');
      try {
        const entries = await fileProvider.list(path, { unrestricted: true });
        browsePath = path;
        pathEl.textContent = browsePath || '/';
        const dirs = entries.filter(e => e.type === 'dir');
        listEl.innerHTML = dirs.length
          ? dirs.map(e => `<li class="code-folder-picker-item" data-path="${escHtml(e.path)}">${escHtml(e.name)}</li>`).join('')
          : '<li class="code-folder-picker-empty">No subfolders</li>';
        listEl.querySelectorAll('.code-folder-picker-item').forEach(li =>
          li.addEventListener('click', () => load(li.dataset.path))
        );
      } catch (e) {
        errEl.textContent = e.message || String(e);
        errEl.classList.remove('hidden');
      }
    }

    upBtn.addEventListener('click', () => {
      const trimmed = browsePath.replace(/\/$/, '');
      if (!trimmed) { load(''); return; }
      const isAbsolute = trimmed.startsWith('/');
      const segments = trimmed.split('/').filter(Boolean);
      segments.pop();
      const parent = isAbsolute ? '/' + segments.join('/') : segments.join('/');
      load(parent);
    });

    selectBtn.addEventListener('click', async () => {
      errEl.classList.add('hidden');
      selectBtn.disabled = true;
      try {
        await onSelect(browsePath);
        close(true);
      } catch (e) {
        errEl.textContent = e.message || String(e);
        errEl.classList.remove('hidden');
      } finally {
        selectBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });

    load(browsePath);
  });
}

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'code-ghost-text';
    span.textContent = this.text;
    return span;
  }
}

const setGhost   = StateEffect.define();
const clearGhost = StateEffect.define();

const ghostField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) {
        return Decoration.set([Decoration.widget({ widget: new GhostWidget(effect.value.text), side: 1 }).range(effect.value.pos)]);
      }
      if (effect.is(clearGhost)) return Decoration.none;
    }
    if (tr.docChanged) return Decoration.none;
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

const ghostKeymap = keymap.of([
  {
    key: 'Tab',
    run(view) {
      if (view.state.readOnly) return false;
      const deco = view.state.field(ghostField, false);
      if (!deco || deco.size === 0) return false;
      let text = null;
      deco.between(0, view.state.doc.length, (from, to, value) => { text = value.spec.widget.text; });
      if (text == null) return false;
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: text }, effects: clearGhost.of(null) });
      return true;
    },
  },
  {
    key: 'Escape',
    run(view) {
      const deco = view.state.field(ghostField, false);
      if (!deco || deco.size === 0) return false;
      view.dispatch({ effects: clearGhost.of(null) });
      return true;
    },
  },
]);

const GHOST_DEBOUNCE_MS = 400;
const GHOST_PREFIX_MAX  = 2000;
const GHOST_SUFFIX_MAX  = 500;

function ghostTrigger(path, onDismiss) {
  let timer = null;
  let abort = null;
  return EditorView.updateListener.of(update => {
    if (!update.docChanged && !update.selectionSet) return;
    if (timer) clearTimeout(timer);
    if (abort) abort.abort();
    update.view.dispatch({ effects: clearGhost.of(null) });
    if (!update.docChanged) return;
    const head = update.state.selection.main.head;
    if (update.state.selection.main.from !== update.state.selection.main.to) return; // no ghost text over a selection
    timer = setTimeout(async () => {
      const doc = update.state.doc;
      const prefix = doc.sliceString(Math.max(0, head - GHOST_PREFIX_MAX), head);
      const suffix = doc.sliceString(head, Math.min(doc.length, head + GHOST_SUFFIX_MAX));
      abort = new AbortController();
      try {
        const res = await fetch('/api/code/ghost-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, suffix, path }),
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`POST /api/code/ghost-text → ${res.status}`);
        const r = await res.json();
        if (abort.signal.aborted || !r.completion) return;
        if (update.view.state.selection.main.head !== head) return; // cursor moved since the request went out
        update.view.dispatch({ effects: setGhost.of({ pos: head, text: r.completion }) });
      } catch (_) {}
    }, GHOST_DEBOUNCE_MS);
  });
}

class DiffHunkWidget extends WidgetType {
  constructor(hunk, onAccept, onReject) { super(); this.hunk = hunk; this.onAccept = onAccept; this.onReject = onReject; }
  eq() { return false; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'code-diff-hunk';
    const removedLines = this.hunk.removedText ? this.hunk.removedText.replace(/\n$/, '').split('\n') : [];
    const addedLines   = this.hunk.addedText   ? this.hunk.addedText.replace(/\n$/, '').split('\n')   : [];
    wrap.innerHTML = `
      ${removedLines.map(l => `<div class="code-diff-line code-diff-remove">− ${escHtml(l)}</div>`).join('')}
      ${addedLines.map(l => `<div class="code-diff-line code-diff-add">+ ${escHtml(l)}</div>`).join('')}
      <div class="code-diff-actions">
        <button class="code-diff-accept">Accept</button>
        <button class="code-diff-reject">Reject</button>
      </div>`;
    wrap.querySelector('.code-diff-accept').addEventListener('click', () => this.onAccept());
    wrap.querySelector('.code-diff-reject').addEventListener('click', () => this.onReject());
    return wrap;
  }
}

const setDiff   = StateEffect.define();
const clearDiff = StateEffect.define();

const diffField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiff))   return Decoration.set([Decoration.widget({ widget: effect.value.widget, side: 1, block: true }).range(effect.value.pos)]);
      if (effect.is(clearDiff)) return Decoration.none;
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: f => [
    EditorView.decorations.from(f),
    EditorView.editable.from(f, deco => deco.size === 0),
    EditorState.readOnly.from(f, deco => deco.size > 0),
  ],
});

function computeHunks(oldContent, newContent) {
  const parts = diffLines(oldContent, newContent);
  const hunks = [];
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { pos += part.value.length; continue; }
    if (part.removed) {
      const next = parts[i + 1];
      const addedText = next?.added ? next.value : '';
      if (next?.added) i++;
      hunks.push({ from: pos, to: pos + part.value.length, removedText: part.value, addedText });
      pos += part.value.length;
    } else {
      hunks.push({ from: pos, to: pos, removedText: '', addedText: part.value });
    }
  }
  return hunks;
}

function shiftHunksAfter(hunks, fromIdx, delta) {
  return hunks.map((h, i) => (i > fromIdx ? { ...h, from: h.from + delta, to: h.to + delta } : h));
}

function reviewHunks(view, hunks, idx, fileProvider, path, resolveDone, anyAccepted = false) {
  if (idx >= hunks.length) {
    view.dispatch({ effects: clearDiff.of(null) });
    resolveDone(anyAccepted);
    return;
  }
  const hunk = hunks[idx];
  const onAccept = () => {
    const delta = hunk.addedText.length - (hunk.to - hunk.from);
    view.dispatch({ changes: { from: hunk.from, to: hunk.to, insert: hunk.addedText }, effects: clearDiff.of(null) });
    fileProvider.write(path, view.state.doc.toString());
    reviewHunks(view, shiftHunksAfter(hunks, idx, delta), idx + 1, fileProvider, path, resolveDone, true);
  };
  const onReject = () => reviewHunks(view, hunks, idx + 1, fileProvider, path, resolveDone, anyAccepted);
  view.dispatch({ effects: setDiff.of({ pos: hunk.from, widget: new DiffHunkWidget(hunk, onAccept, onReject) }) });
}

const appTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', height: '100%', fontSize: '13px' },
  '.cm-content': { fontFamily: "'Fira Code','Cascadia Code',Consolas,monospace", caretColor: 'var(--accent)' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'var(--bg2)', color: 'var(--text-dim)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bg3)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg3)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(232,150,30,0.25) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
}, { dark: true });

function baseExtensions(path, onSave) {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    Prec.highest(ghostKeymap),
    ghostField,
    diffField,
    ghostTrigger(path),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
      ...defaultKeymap, ...historyKeymap, indentWithTab,
    ]),
    appTheme,
    ...langExtensionFor(path),
  ];
}

export function createEditorPane(bodyEl, { fileProvider, onFocus } = {}) {
  bodyEl.innerHTML = `
    <div class="code-tabs"></div>
    <div class="code-cm-host"></div>
    <div class="code-editor-statusbar">
      <span class="code-lang-label">plaintext</span>
      <span class="code-save-label"></span>
    </div>`;
  const cmHost = bodyEl.querySelector('.code-cm-host');
  const langLabel = bodyEl.querySelector('.code-lang-label');
  const saveLabel = bodyEl.querySelector('.code-save-label');

  const states = new Map(); // path -> EditorState
  let view = null;
  let currentPath = null;

  async function save() {
    if (!currentPath || !view) return;
    await fileProvider.write(currentPath, view.state.doc.toString());
    saveLabel.textContent = 'Saved';
    setTimeout(() => { saveLabel.textContent = ''; }, 1200);
  }

  function renderTabs() {
    const bar = bodyEl.querySelector('.code-tabs');
    bar.innerHTML = [...states.keys()].map(path => {
      const name = path.split('/').pop();
      const active = path === currentPath;
      return `<div class="code-tab${active ? ' active' : ''}" data-path="${path}" title="${path}">
        <span class="code-tab-name">${name}</span>
        <button class="code-tab-close" data-path="${path}">×</button>
      </div>`;
    }).join('');
    bar.querySelectorAll('.code-tab').forEach(el =>
      el.addEventListener('click', e => { if (!e.target.closest('.code-tab-close')) openFile(el.dataset.path); })
    );
    bar.querySelectorAll('.code-tab-close').forEach(el =>
      el.addEventListener('click', e => { e.stopPropagation(); closeTab(el.dataset.path); })
    );
  }

  async function openFile(path, { initialContent } = {}) {
    if (currentPath && view) states.set(currentPath, view.state);
    let state = states.get(path);
    if (!state) {
      const content = initialContent !== undefined ? (initialContent ?? '') : await fileProvider.read(path);
      state = EditorState.create({ doc: content, extensions: baseExtensions(path, save) });
      states.set(path, state);
    }
    if (!view) {
      view = new EditorView({ state, parent: cmHost });
      cmHost.addEventListener('focusin', () => onFocus?.());
    } else {
      view.setState(state);
    }
    currentPath = path;
    langLabel.textContent = detectLangLabel(path);
    renderTabs();
    view.focus();
  }

  async function proposeDiff(newContent, { autoAccept = false, onSettled } = {}) {
    if (!view || !currentPath) return { applied: false, hunkCount: 0 };
    const oldContent = view.state.doc.toString();
    const hunks = computeHunks(oldContent, newContent);
    if (!hunks.length) return { applied: false, hunkCount: 0 };
    if (autoAccept) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newContent } });
      await fileProvider.write(currentPath, newContent);
      onSettled?.(true);
      return { applied: true, hunkCount: hunks.length };
    }
    // Review is interactive (the user accepts/rejects each hunk in the editor UI), so this
    // resolves later, independently of the { applied: false } returned to the caller below.
    reviewHunks(view, hunks, 0, fileProvider, currentPath, wasAccepted => onSettled?.(wasAccepted));
    return { applied: false, hunkCount: hunks.length };
  }

  function closeTab(path) {
    states.delete(path);
    if (currentPath === path) {
      const remaining = [...states.keys()];
      currentPath = null;
      if (remaining.length) {
        openFile(remaining[remaining.length - 1]);
        return;
      }
      view?.destroy();
      view = null;
      langLabel.textContent = 'plaintext';
    }
    renderTabs();
  }

  function closeAllTabs() {
    states.clear();
    currentPath = null;
    view?.destroy();
    view = null;
    langLabel.textContent = 'plaintext';
    renderTabs();
  }

  return {
    el: bodyEl,
    openFile,
    proposeDiff,
    closeAllTabs,
    getActiveFile: () => currentPath,
    getOpenFiles: () => [...states.keys()],
    getView: () => view,
    destroy() { view?.destroy(); },
  };
}

export function createTreePane(bodyEl, { fileProvider, openInEditor, onChangeRoot, rootPath = '', rootLabel = 'project' } = {}) {
  bodyEl.innerHTML = `
    <div class="code-tree-header">
      <span class="code-root-label">${rootLabel}</span>
      <button type="button" class="code-tree-refresh-btn" title="Refresh file tree">⟳</button>
      <button type="button" class="code-tree-change-root-btn" title="Change workspace folder">Change…</button>
    </div>
    <div class="code-tree"></div>`;
  const treeEl     = bodyEl.querySelector('.code-tree');
  const labelEl    = bodyEl.querySelector('.code-root-label');
  const refreshBtn = bodyEl.querySelector('.code-tree-refresh-btn');
  const changeBtn  = bodyEl.querySelector('.code-tree-change-root-btn');

  let currentRootPath = rootPath;

  async function renderLevel(container, dirPath) {
    const entries = await fileProvider.list(dirPath);
    const ul = document.createElement('ul');
    ul.className = 'tree-list';
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = `tree-item tree-${entry.type}`;
      const row = document.createElement('div');
      row.className = 'tree-row';
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = entry.type === 'dir' ? '▶' : '';
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = entry.name;
      label.title = entry.path;
      row.appendChild(icon);
      row.appendChild(label);
      li.appendChild(row);
      if (entry.type === 'dir') {
        let expanded = false;
        row.addEventListener('click', async () => {
          expanded = !expanded;
          icon.textContent = expanded ? '▼' : '▶';
          const existing = li.querySelector('.tree-list');
          if (existing) { existing.remove(); return; }
          await renderLevel(li, entry.path);
        });
      } else {
        row.addEventListener('click', () => openInEditor(entry.path));
      }
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  function renderRoot() {
    treeEl.innerHTML = '';
    renderLevel(treeEl, currentRootPath);
  }

  changeBtn.addEventListener('click', () => {
    openFolderPicker(fileProvider, currentRootPath, path => onChangeRoot?.(path));
  });
  refreshBtn.addEventListener('click', () => renderRoot());

  renderRoot();

  return {
    destroy() { bodyEl.innerHTML = ''; },
    // Called both on an explicit root change (both args given) and as a plain
    // re-list of the current root when files were created/removed elsewhere
    // (no args — e.g. after the AI panel creates a file, or a background
    // pipeline job writes into the workspace).
    refresh(newRootPath, newRootLabel) {
      if (newRootPath !== undefined) currentRootPath = newRootPath;
      if (newRootLabel !== undefined) labelEl.textContent = newRootLabel;
      renderRoot();
    },
  };
}
