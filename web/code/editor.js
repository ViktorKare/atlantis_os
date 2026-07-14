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

  async function openFile(path) {
    if (currentPath && view) states.set(currentPath, view.state);
    let state = states.get(path);
    if (!state) {
      const content = await fileProvider.read(path);
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

  return {
    el: bodyEl,
    openFile,
    getActiveFile: () => currentPath,
    getOpenFiles: () => [...states.keys()],
    getView: () => view,
    destroy() { view?.destroy(); },
  };
}

export function createTreePane(bodyEl, { fileProvider, openInEditor, rootPath = '', rootLabel = 'project' } = {}) {
  bodyEl.innerHTML = `
    <div class="code-tree-header">
      <span class="code-root-label">${rootLabel}</span>
    </div>
    <div class="code-tree"></div>`;
  const treeEl = bodyEl.querySelector('.code-tree');

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

  renderLevel(treeEl, rootPath);

  return { destroy() { bodyEl.innerHTML = ''; } };
}
