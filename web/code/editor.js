export function createEditorPane(bodyEl) {
  bodyEl.innerHTML = '<div class="code-pane-placeholder">Editor pane — wired up in a later task.</div>';
  return { destroy() { bodyEl.innerHTML = ''; }, getView() { return null; }, getActivePath() { return null; } };
}

export function createTreePane(bodyEl) {
  bodyEl.innerHTML = '<div class="code-pane-placeholder">File tree — wired up in a later task.</div>';
  return { destroy() { bodyEl.innerHTML = ''; } };
}
