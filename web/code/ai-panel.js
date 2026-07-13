export function createChatPane(bodyEl, { aiProvider, fileProvider, getFocusedEditor } = {}) {
  bodyEl.innerHTML = `
    <div class="code-chat-toolbar">
      <select class="code-model-select"></select>
      <div class="code-auto-select">
        <button class="code-auto-btn" data-mode="off" title="Auto-accept mode">Off</button>
      </div>
    </div>
    <div class="code-chat-window"></div>
    <div class="code-chat-bar">
      <div class="spin-wrap"><textarea class="code-chat-input" placeholder="Ask about the code…" rows="1"></textarea></div>
      <button class="code-send-btn">Send</button>
    </div>`;

  const modelSelect = bodyEl.querySelector('.code-model-select');
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

  input.addEventListener('focus', () => spinWrap.classList.add('focused'));
  input.addEventListener('blur',  () => spinWrap.classList.remove('focused'));
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
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

  async function sendMessage() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    busy = true;
    sendBtn.disabled = true;

    appendBubble('user', text);
    history.push({ role: 'user', content: text });

    const model = modelSelect.value;
    let fullText = '';
    const assistantDiv = appendBubble('assistant', '▋');
    try {
      for await (const chunk of aiProvider.chat({ messages: history, model, skill: null })) {
        fullText += chunk;
        assistantDiv.innerHTML = marked.parse(fullText + ' ▋');
        chatWindow.scrollTop = chatWindow.scrollHeight;
      }
      assistantDiv.innerHTML = marked.parse(fullText);
      assistantDiv.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
      history.push({ role: 'assistant', content: fullText });
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

export function initCommandPalette() {
  // Wired up in Task 11.
}
