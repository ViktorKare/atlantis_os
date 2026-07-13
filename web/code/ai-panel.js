export function createChatPane(bodyEl) {
  bodyEl.innerHTML = '<div class="code-pane-placeholder">Chat pane — wired up in a later task.</div>';
  return { destroy() { bodyEl.innerHTML = ''; } };
}

export function initCommandPalette() {
  // Wired up in Task 11.
}
