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

export function initCommandPalette() {
  // Wired up in Task 11.
}
