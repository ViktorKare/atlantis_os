import { EditorView, Decoration, WidgetType, keymap } from 'https://esm.sh/@codemirror/view@6';
import { StateField, StateEffect, Prec } from 'https://esm.sh/@codemirror/state@6';

export function createChatPane(bodyEl, { aiProvider, fileProvider, getFocusedEditor } = {}) {
  bodyEl.innerHTML = `
    <div class="code-chat-toolbar">
      <select class="code-model-select"></select>
      <select class="code-skill-picker"><option value="">No skill</option></select>
      <div class="code-auto-select">
        <button class="code-auto-btn" data-mode="off" title="Auto-accept mode">Off</button>
      </div>
    </div>
    <div class="code-suggest-chip hidden"></div>
    <div class="code-chat-window"></div>
    <div class="code-chat-bar">
      <div class="spin-wrap"><textarea class="code-chat-input" placeholder="Ask about the code…" rows="1"></textarea></div>
      <button class="code-send-btn">Send</button>
    </div>`;

  const modelSelect = bodyEl.querySelector('.code-model-select');
  const skillPicker = bodyEl.querySelector('.code-skill-picker');
  const suggestChip = bodyEl.querySelector('.code-suggest-chip');
  const chatWindow  = bodyEl.querySelector('.code-chat-window');
  const input       = bodyEl.querySelector('.code-chat-input');
  const spinWrap    = bodyEl.querySelector('.spin-wrap');
  const sendBtn     = bodyEl.querySelector('.code-send-btn');
  const autoBtn     = bodyEl.querySelector('.code-auto-btn');

  const AUTO_MODES = ['off', 'all', 'risky'];
  const AUTO_LABELS = { off: 'Off', all: 'Auto-accept all', risky: 'Auto-accept, ask on risky' };
  let autoIdx = 0;
  autoBtn.addEventListener('click', () => {
    autoIdx = (autoIdx + 1) % AUTO_MODES.length;
    autoBtn.dataset.mode = AUTO_MODES[autoIdx];
    autoBtn.textContent = AUTO_LABELS[AUTO_MODES[autoIdx]];
  });

  aiProvider.listModels().then(models => {
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
  });

  let skills = [];
  let pinnedSkill = null;
  let suggestedSkill = null;
  aiProvider.listSkills().then(list => {
    skills = list;
    skillPicker.innerHTML = '<option value="">No skill</option>' +
      skills.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  });
  skillPicker.addEventListener('change', () => { pinnedSkill = skillPicker.value || null; });

  function renderSuggestChip() {
    if (!suggestedSkill) { suggestChip.classList.add('hidden'); suggestChip.innerHTML = ''; return; }
    const skill = skills.find(s => s.id === suggestedSkill);
    suggestChip.classList.remove('hidden');
    suggestChip.innerHTML = `Use <b>${skill.name}</b> skill? <button class="code-suggest-accept">Accept</button><button class="code-suggest-dismiss">Dismiss</button>`;
    suggestChip.querySelector('.code-suggest-accept').addEventListener('click', () => {
      pinnedSkill = skill.id;
      skillPicker.value = skill.id;
      suggestedSkill = null;
      renderSuggestChip();
    });
    suggestChip.querySelector('.code-suggest-dismiss').addEventListener('click', () => {
      suggestedSkill = null;
      renderSuggestChip();
    });
  }

  input.addEventListener('focus', () => spinWrap.classList.add('focused'));
  input.addEventListener('blur',  () => spinWrap.classList.remove('focused'));
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    const text = input.value.toLowerCase();
    const match = skills.find(s => s.triggers.some(t => text.includes(t)));
    suggestedSkill = match ? match.id : null;
    renderSuggestChip();
  });

  let busy = false;
  const history = [];

  function appendBubble(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = role === 'user' ? `<p>${escHtml(content)}</p>` : marked.parse(content);
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    if (role === 'assistant') div.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
    return div;
  }

  function appendSkillBanner(skillId) {
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return;
    const banner = document.createElement('div');
    banner.className = 'code-skill-banner';
    banner.textContent = `Using skill: ${skill.name}`;
    chatWindow.appendChild(banner);
  }

  async function sendMessage() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    suggestedSkill = null;
    renderSuggestChip();
    busy = true;
    sendBtn.disabled = true;

    appendBubble('user', text);
    history.push({ role: 'user', content: text });

    const model = modelSelect.value;
    const skillForThisMessage = pinnedSkill;
    if (skillForThisMessage) appendSkillBanner(skillForThisMessage);

    let fullText = '';
    const assistantDiv = appendBubble('assistant', '▋');
    try {
      for await (const chunk of aiProvider.chat({ messages: history, model, skill: skillForThisMessage })) {
        fullText += chunk;
        assistantDiv.innerHTML = marked.parse(fullText + ' ▋');
        chatWindow.scrollTop = chatWindow.scrollHeight;
      }
      assistantDiv.innerHTML = marked.parse(fullText);
      assistantDiv.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
      history.push({ role: 'assistant', content: fullText });

      pinnedSkill = null;
      skillPicker.value = '';
    } catch (err) {
      assistantDiv.innerHTML = marked.parse(fullText + `\n\n*Error: ${err?.message || 'request failed'}*`);
      chatWindow.scrollTop = chatWindow.scrollHeight;
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  return {
    el: bodyEl,
    destroy() {},
  };
}

export function initCommandPalette({ addPane, applyLayoutByName, getFocusedEditor, fileProvider }) {
  const overlay = document.getElementById('code-palette-overlay');
  const input   = document.getElementById('code-palette-input');
  const list    = document.getElementById('code-palette-list');

  const actions = [
    { label: 'Add Chat Pane',        run: () => addPane('chat') },
    { label: 'Add Editor Pane',      run: () => addPane('editor') },
    { label: 'Add File Tree Pane',   run: () => addPane('tree') },
    { label: 'Apply Focus Layout',   run: () => applyLayoutByName('Focus') },
    { label: 'Apply Classic Layout', run: () => applyLayoutByName('Classic') },
    { label: 'Apply Compare Layout', run: () => applyLayoutByName('Compare') },
    { label: 'Suggest here (demo)',  run: () => showGhostText(getFocusedEditor()) },
    { label: 'Propose mock edit (demo)', run: () => showDiffReview(getFocusedEditor(), fileProvider) },
  ];

  let filtered = actions;
  let activeIdx = 0;

  function renderList() {
    list.innerHTML = filtered.map((a, i) =>
      `<div class="code-palette-item${i === activeIdx ? ' active' : ''}" data-idx="${i}">${a.label}</div>`
    ).join('');
    list.querySelectorAll('.code-palette-item').forEach(el =>
      el.addEventListener('click', () => runAction(Number(el.dataset.idx)))
    );
  }

  function runAction(idx) {
    filtered[idx]?.run();
    close();
  }

  function open() {
    overlay.classList.remove('hidden');
    input.value = '';
    filtered = actions;
    activeIdx = 0;
    renderList();
    input.focus();
  }

  function close() {
    overlay.classList.add('hidden');
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    filtered = actions.filter(a => a.label.toLowerCase().includes(q));
    activeIdx = 0;
    renderList();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); renderList(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); return; }
    if (e.key === 'Enter')     { e.preventDefault(); runAction(activeIdx); }
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (document.getElementById('section-code')?.classList.contains('active')) {
        e.preventDefault();
        open();
      }
    }
  });
}

const GHOST_TEXT = ' // TODO: handle the empty-array case here';

const setGhost = StateEffect.define();
const clearGhost = StateEffect.define();

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

const ghostField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) {
        return Decoration.set([Decoration.widget({ widget: new GhostWidget(GHOST_TEXT), side: 1 }).range(effect.value.pos ?? tr.state.selection.main.head)]);
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
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: GHOST_TEXT }, effects: clearGhost.of(null) });
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

const installedGhost = new WeakSet();

export function showGhostText(editorController) {
  const view = editorController?.getView?.();
  if (!view) return;
  if (!installedGhost.has(view)) {
    installedGhost.add(view);
    view.dispatch({ effects: StateEffect.appendConfig.of([ghostField, Prec.highest(ghostKeymap)]) });
  }
  view.dispatch({ effects: setGhost.of({ pos: view.state.selection.main.head }) });
}

const MOCK_DIFF = {
  removeLine: 'insufficient input validation',
  addLines: ['if (!input) return null;', 'const cleaned = input.trim();'],
};

const setDiff = StateEffect.define();
const clearDiff = StateEffect.define();

class DiffHunkWidget extends WidgetType {
  constructor(onAccept, onReject) { super(); this.onAccept = onAccept; this.onReject = onReject; }
  eq() { return false; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'code-diff-hunk';
    wrap.innerHTML = `
      <div class="code-diff-line code-diff-remove">− ${MOCK_DIFF.removeLine}</div>
      ${MOCK_DIFF.addLines.map(l => `<div class="code-diff-line code-diff-add">+ ${l}</div>`).join('')}
      <div class="code-diff-actions">
        <button class="code-diff-accept">Accept</button>
        <button class="code-diff-reject">Reject</button>
      </div>`;
    wrap.querySelector('.code-diff-accept').addEventListener('click', () => this.onAccept());
    wrap.querySelector('.code-diff-reject').addEventListener('click', () => this.onReject());
    return wrap;
  }
}

const diffField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiff)) {
        return Decoration.set([Decoration.widget({ widget: effect.value, side: 1, block: true }).range(tr.state.selection.main.head)]);
      }
      if (effect.is(clearDiff)) return Decoration.none;
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

const installedDiff = new WeakSet();

export function showDiffReview(editorController, fileProvider) {
  const view = editorController?.getView?.();
  const path = editorController?.getActiveFile?.();
  if (!view || !path) return;
  if (!installedDiff.has(view)) {
    installedDiff.add(view);
    view.dispatch({ effects: StateEffect.appendConfig.of([diffField]) });
  }
  const onAccept = () => {
    const deco = view.state.field(diffField);
    let pos = view.state.selection.main.head; // fallback if the decoration is somehow empty
    deco.between(0, view.state.doc.length, (from) => { pos = from; return false; });
    const insertion = MOCK_DIFF.addLines.join('\n') + '\n';
    view.dispatch({ changes: { from: pos, insert: insertion }, effects: clearDiff.of(null) });
    fileProvider.write(path, view.state.doc.toString());
  };
  const onReject = () => view.dispatch({ effects: clearDiff.of(null) });
  view.dispatch({ effects: setDiff.of(new DiffHunkWidget(onAccept, onReject)) });
}
