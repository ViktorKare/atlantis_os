const CODE_TOOL_DEFS = {
  read_file:    { type:'function', function:{ name:'read_file',    description:'Read the contents of a file', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:['path'] } } },
  list_dir:     { type:'function', function:{ name:'list_dir',     description:'List directory contents', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:[] } } },
  search_files: { type:'function', function:{ name:'search_files', description:'Search file contents recursively (regex or literal)', parameters:{ type:'object', properties:{ pattern:{ type:'string' }, path:{ type:'string' } }, required:['pattern'] } } },
  run_command:  { type:'function', function:{ name:'run_command',  description:'Run a bash command in the code root; returns exit code, stdout, stderr (timeout max 120s)', parameters:{ type:'object', properties:{ command:{ type:'string' }, cwd:{ type:'string' }, timeout:{ type:'integer' } }, required:['command'] } } },
  propose_edit:     { type:'function', function:{ name:'propose_edit',     description:'Propose replacing an exact string in the currently open file. old_string must occur exactly once (or set replace_all). Shown to the user as a reviewable diff, not applied immediately unless auto-accept is on.', parameters:{ type:'object', properties:{ path:{ type:'string' }, old_string:{ type:'string' }, new_string:{ type:'string' }, replace_all:{ type:'boolean' } }, required:['path','old_string','new_string'] } } },
  propose_new_file: { type:'function', function:{ name:'propose_new_file', description:'Propose creating a new file with the given content. Shown to the user as a reviewable diff against an empty file, not applied immediately unless auto-accept is on.', parameters:{ type:'object', properties:{ path:{ type:'string' }, content:{ type:'string' } }, required:['path','content'] } } },
  ask_user:     { type:'function', function:{ name:'ask_user',     description:'Ask the user a clarifying question with clickable options and/or free text. Blocks until they answer.', parameters:{ type:'object', properties:{ question:{ type:'string' }, options:{ type:'array', items:{ type:'string' } }, allow_multiple:{ type:'boolean' }, allow_free_text:{ type:'boolean' } }, required:['question'] } } },
};

function buildCodeTools(toolPerms) {
  if (!toolPerms) return [];
  const out = [CODE_TOOL_DEFS.ask_user];
  if (toolPerms.files) out.push(CODE_TOOL_DEFS.read_file, CODE_TOOL_DEFS.list_dir, CODE_TOOL_DEFS.search_files, CODE_TOOL_DEFS.propose_edit, CODE_TOOL_DEFS.propose_new_file);
  if (toolPerms.shell) out.push(CODE_TOOL_DEFS.run_command);
  return out;
}

function buildCodeToolManifest(toolPerms) {
  if (!toolPerms) return '';
  const lines = ['## Tools available', 'ask_user is always available to pause and ask the user a question.'];
  if (toolPerms.files) {
    lines.push('- **read_file**, **list_dir**, **search_files** — read-only, run immediately');
    lines.push('- **propose_edit** / **propose_new_file** — edits are shown to the user for review, not applied immediately unless auto-accept is on');
  }
  if (toolPerms.shell) lines.push('- **run_command** — runs immediately in the code root');
  return lines.join('\n');
}

async function executeCodeTool(name, params, ctx) {
  try {
    switch (name) {
      case 'read_file': {
        const r = await api('POST', '/api/tools/exec', { name: 'read_file', args: params });
        return typeof r === 'string' ? r : (r.content ?? JSON.stringify(r));
      }
      case 'list_dir': {
        const r = await api('POST', '/api/tools/exec', { name: 'list_files', args: params });
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
      case 'search_files':
      case 'run_command': {
        const r = await api('POST', '/api/tools/exec', { name, args: params });
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
      case 'propose_edit':
      case 'propose_new_file':
        return 'Error: propose tools not yet wired (Task 12)';
      case 'ask_user':
        return 'Error: ask_user not yet wired (Task 13)';
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error: ${e.message}`;
  }
}

export function createChatPane(bodyEl, { aiProvider, fileProvider, getFocusedEditor } = {}) {
  bodyEl.innerHTML = `
    <div class="code-chat-toolbar">
      <select class="code-agent-select"><option value="">No agent</option></select>
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

  const agentSelect = bodyEl.querySelector('.code-agent-select');
  let agentsList = [];
  api('GET', '/api/agents').then(list => {
    agentsList = list || [];
    agentSelect.innerHTML = '<option value="">No agent</option>' +
      agentsList.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  }).catch(() => {});

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

    const agent = agentSelect.value ? agentsList.find(a => a.id === agentSelect.value) : null;
    const model = agent?.model || modelSelect.value;
    const toolPerms = agent?.tools && Object.values(agent.tools).some(Boolean) ? agent.tools : null;
    const tools    = buildCodeTools(toolPerms);
    const manifest = buildCodeToolManifest(toolPerms);
    const skillForThisMessage = pinnedSkill;
    if (skillForThisMessage) appendSkillBanner(skillForThisMessage);

    const apiMessages = [];
    if (manifest) apiMessages.push({ role: 'system', content: manifest });
    apiMessages.push(...history);

    try {
      let looping = true;
      while (looping) {
        looping = false;
        let fullText = '';
        let turnToolCalls = null;
        const assistantDiv = appendBubble('assistant', '▋');
        for await (const chunk of aiProvider.chat({ messages: apiMessages, model, tools })) {
          if (typeof chunk === 'string') {
            fullText += chunk;
            assistantDiv.innerHTML = marked.parse(fullText + ' ▋');
            chatWindow.scrollTop = chatWindow.scrollHeight;
          } else if (chunk?.toolCalls) {
            turnToolCalls = chunk.toolCalls;
          }
        }
        if (fullText) {
          assistantDiv.innerHTML = marked.parse(fullText);
          assistantDiv.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
        } else {
          assistantDiv.remove();
        }
        if (turnToolCalls?.length) {
          apiMessages.push({ role: 'assistant', content: '', tool_calls: turnToolCalls });
          if (fullText) history.push({ role: 'assistant', content: fullText });
          for (const tc of turnToolCalls) {
            const result = await executeCodeTool(tc.function.name, tc.function.arguments ?? {}, { autoMode: autoBtn.dataset.mode });
            apiMessages.push({ role: 'tool', content: String(result) });
          }
          looping = true;
        } else {
          history.push({ role: 'assistant', content: fullText });
          pinnedSkill = null;
          skillPicker.value = '';
        }
      }
    } catch (err) {
      appendBubble('assistant', `*Error: ${err?.message || 'request failed'}*`);
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

