import { MockFileProvider, MockAIProvider } from './providers.js';
import { createEditorPane, createTreePane } from './editor.js';
import { createChatPane, initCommandPalette } from './ai-panel.js';

const fileProvider = new MockFileProvider();
const aiProvider   = new MockAIProvider();

const PANE_TITLES = { chat: 'Chat', editor: 'Editor', tree: 'File Tree' };
const DEFAULT_WIDTHS = { chat: 340, editor: 640, tree: 240 };
const MIN_WIDTH = 180;
const MAX_WIDTH = 1440;

const BUILTIN_LAYOUTS = [
  { name: 'Focus',   builtin: true, panes: [{ type: 'chat', width: 480 }] },
  { name: 'Classic', builtin: true, panes: [{ type: 'chat', width: 320 }, { type: 'editor', width: 720 }, { type: 'tree', width: 240 }] },
  { name: 'Compare', builtin: true, panes: [{ type: 'chat', width: 340 }, { type: 'chat', width: 340 }, { type: 'chat', width: 340 }, { type: 'chat', width: 340 }] },
];

let panes = [];               // [{ id, type, width, el, controller }]
let currentLayoutName = null;
let customLayouts = [];
let preferredWidths = { ...DEFAULT_WIDTHS };
let focusedEditorPaneId = null;
let uidCounter = 0;

function uid() { return `p${Date.now().toString(36)}${(uidCounter++).toString(36)}`; }
function clampWidth(w) { return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)); }

function getFocusedEditor() {
  const byId = panes.find(p => p.id === focusedEditorPaneId && p.type === 'editor');
  if (byId) return byId.controller;
  const first = panes.find(p => p.type === 'editor');
  return first ? first.controller : null;
}

function openInNearestEditor(path) {
  let target = panes.find(p => p.id === focusedEditorPaneId && p.type === 'editor');
  if (!target) target = panes.find(p => p.type === 'editor');
  if (!target) {
    target = addPane('editor');
  }
  target.controller?.openFile?.(path);
}

function mountPane(pane) {
  const body = pane.el.querySelector('.code-pane-body');
  if (pane.type === 'chat') {
    pane.controller = createChatPane(body, { aiProvider, fileProvider, getFocusedEditor });
  } else if (pane.type === 'editor') {
    pane.controller = createEditorPane(body, { fileProvider, onFocus: () => { focusedEditorPaneId = pane.id; } });
  } else if (pane.type === 'tree') {
    pane.controller = createTreePane(body, { fileProvider, openInEditor: openInNearestEditor });
  }
}

function buildPaneEl(pane) {
  const el = document.createElement('div');
  el.className = 'code-pane';
  el.dataset.paneId = pane.id;
  el.dataset.paneType = pane.type;
  el.style.width = pane.width + 'px';
  el.innerHTML = `
    <div class="code-pane-header">
      <span class="code-pane-title">${PANE_TITLES[pane.type]}</span>
      <button class="code-pane-close" title="Close pane">✕</button>
    </div>
    <div class="code-pane-body"></div>`;
  el.querySelector('.code-pane-close').addEventListener('click', () => closePane(pane.id));
  el.addEventListener('focusin', () => { if (pane.type === 'editor') focusedEditorPaneId = pane.id; });
  return el;
}

function buildHandle(leftPane, rightPane) {
  const handle = document.createElement('div');
  handle.className = 'code-pane-handle';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startLeftW = leftPane.width;
    const startRightW = rightPane ? rightPane.width : null;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      leftPane.width = clampWidth(startLeftW + dx);
      leftPane.el.style.width = leftPane.width + 'px';
      if (rightPane) {
        rightPane.width = clampWidth(startRightW - dx);
        rightPane.el.style.width = rightPane.width + 'px';
      }
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      preferredWidths[leftPane.type] = leftPane.width;
      if (rightPane) preferredWidths[rightPane.type] = rightPane.width;
      persistCurrentLayout();
      persistPreferredWidths();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
  return handle;
}

let addControlEl = null;

function buildAddControl() {
  const wrap = document.createElement('div');
  wrap.id = 'code-pane-add-wrap';
  wrap.innerHTML = `
    <button id="code-pane-add-btn" title="Add pane">+</button>
    <div id="code-pane-add-menu" class="hidden">
      <button data-add-type="chat">+ Chat</button>
      <button data-add-type="editor">+ Editor</button>
      <button data-add-type="tree">+ File Tree</button>
    </div>`;
  const btn = wrap.querySelector('#code-pane-add-btn');
  const menu = wrap.querySelector('#code-pane-add-menu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  wrap.querySelectorAll('[data-add-type]').forEach(b => {
    b.addEventListener('click', () => { addPane(b.dataset.addType); menu.classList.add('hidden'); });
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  return wrap;
}

function render() {
  const row = document.getElementById('code-pane-row');
  row.innerHTML = '';
  panes.forEach((pane, i) => {
    if (!pane.el) pane.el = buildPaneEl(pane);
    row.appendChild(pane.el);
    if (!pane.controller) mountPane(pane);
    row.appendChild(buildHandle(pane, panes[i + 1] || null));
  });
  if (!addControlEl) addControlEl = buildAddControl();
  row.appendChild(addControlEl);
  updateTreeEdgeControl();
}

function addPane(type) {
  const pane = { id: uid(), type, width: clampWidth(preferredWidths[type] || DEFAULT_WIDTHS[type]) };
  panes.push(pane);
  currentLayoutName = null;
  render();
  renderLayoutBar();
  persistCurrentLayout();
  return pane;
}

function closePane(id) {
  const idx = panes.findIndex(p => p.id === id);
  if (idx === -1) return;
  const [pane] = panes.splice(idx, 1);
  preferredWidths[pane.type] = pane.width;
  pane.controller?.destroy?.();
  if (focusedEditorPaneId === pane.id) focusedEditorPaneId = null;
  currentLayoutName = null;
  render();
  renderLayoutBar();
  persistCurrentLayout();
  persistPreferredWidths();
}

function applyLayoutObj(layout) {
  panes.forEach(p => p.controller?.destroy?.());
  panes = layout.panes.map(p => ({ id: uid(), type: p.type, width: clampWidth(p.width || DEFAULT_WIDTHS[p.type]) }));
  currentLayoutName = layout.name;
  render();
  renderLayoutBar();
  persistCurrentLayout();
}

function applyLayoutByName(name) {
  const layout = [...BUILTIN_LAYOUTS, ...customLayouts].find(l => l.name === name);
  if (layout) applyLayoutObj(layout);
}

function updateTreeEdgeControl() {
  const ctrl = document.getElementById('code-tree-edge-control');
  const hasTree = panes.some(p => p.type === 'tree');
  ctrl.classList.toggle('hidden', hasTree);
  document.getElementById('code-tree-edge-width').textContent = `${preferredWidths.tree}px`;
}

function renderLayoutBar() {
  const chips = document.getElementById('code-layout-chips');
  const all = [...BUILTIN_LAYOUTS, ...customLayouts];
  chips.innerHTML = all.map(l => `
    <button class="code-layout-chip${l.name === currentLayoutName ? ' active' : ''}" data-layout="${l.name}">
      <span>${l.name}</span>${l.builtin ? '' : `<span class="code-layout-chip-del" data-del="${l.name}" title="Delete layout">✕</span>`}
    </button>`).join('');
  chips.querySelectorAll('.code-layout-chip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.code-layout-chip-del')) return;
      applyLayoutByName(btn.dataset.layout);
    });
  });
  chips.querySelectorAll('.code-layout-chip-del').forEach(x => {
    x.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomLayout(x.dataset.del); });
  });
}

function saveCurrentAsLayout() {
  const name = prompt('Name this layout:');
  if (!name?.trim()) return;
  const layout = { name: name.trim(), builtin: false, panes: panes.map(p => ({ type: p.type, width: p.width })) };
  customLayouts = customLayouts.filter(l => l.name !== layout.name);
  customLayouts.push(layout);
  currentLayoutName = layout.name;
  persistCustomLayouts();
  renderLayoutBar();
  persistCurrentLayout();
}

function deleteCustomLayout(name) {
  customLayouts = customLayouts.filter(l => l.name !== name);
  if (currentLayoutName === name) currentLayoutName = null;
  persistCustomLayouts();
  renderLayoutBar();
  persistCurrentLayout();
}

function persistCurrentLayout() {
  localStorage.setItem('codeCurrentLayout', JSON.stringify({
    name: currentLayoutName,
    panes: panes.map(p => ({ type: p.type, width: p.width })),
  }));
}
function persistCustomLayouts() {
  localStorage.setItem('codeCustomLayouts', JSON.stringify(customLayouts));
}
function persistPreferredWidths() {
  localStorage.setItem('codePreferredWidths', JSON.stringify(preferredWidths));
}

function loadPersisted() {
  try {
    const w = JSON.parse(localStorage.getItem('codePreferredWidths') || 'null');
    if (w) {
      const merged = { ...DEFAULT_WIDTHS, ...w };
      preferredWidths = Object.fromEntries(Object.entries(merged).map(([type, width]) => [type, clampWidth(width)]));
    }
  } catch (_) {}
  try {
    const c = JSON.parse(localStorage.getItem('codeCustomLayouts') || 'null');
    if (Array.isArray(c)) customLayouts = c;
  } catch (_) {}
  try {
    return JSON.parse(localStorage.getItem('codeCurrentLayout') || 'null');
  } catch (_) {
    return null;
  }
}

function wireStaticControls() {
  document.getElementById('code-layout-save-btn').addEventListener('click', saveCurrentAsLayout);
  document.getElementById('code-tree-edge-minus').addEventListener('click', () => {
    preferredWidths.tree = clampWidth(preferredWidths.tree - 20);
    persistPreferredWidths();
    updateTreeEdgeControl();
  });
  document.getElementById('code-tree-edge-plus').addEventListener('click', () => {
    preferredWidths.tree = clampWidth(preferredWidths.tree + 20);
    persistPreferredWidths();
    updateTreeEdgeControl();
  });
  document.getElementById('code-tree-edge-show').addEventListener('click', () => addPane('tree'));
}

let inited = false;
function initCode() {
  if (inited) return;
  inited = true;
  wireStaticControls();
  initCommandPalette({ addPane, applyLayoutByName, getFocusedEditor });
  const saved = loadPersisted();
  if (saved && Array.isArray(saved.panes) && saved.panes.length) {
    panes = saved.panes.map(p => ({ id: uid(), type: p.type, width: clampWidth(p.width || DEFAULT_WIDTHS[p.type]) }));
    currentLayoutName = saved.name || null;
    render();
    renderLayoutBar();
  } else {
    applyLayoutObj(BUILTIN_LAYOUTS[0]);
  }
}

window.CodeEditorApp = { initCode };
