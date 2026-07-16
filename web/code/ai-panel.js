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

export function createChatPane(bodyEl, { aiProvider, fileProvider, getFocusedEditor, isFileOpenAnywhere } = {}) {
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
  }).catch(() => {});
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
  let skillMatchTimer = null;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    clearTimeout(skillMatchTimer);
    const text = input.value;
    if (!text.trim()) { suggestedSkill = null; renderSuggestChip(); return; }
    skillMatchTimer = setTimeout(async () => {
      let result;
      try { result = await api('POST', '/api/skills/match', { text }); } catch (_) { result = null; }
      if (result?.skillId) {
        suggestedSkill = result.skillId;
      } else if (result === null || result?.error) {
        // Embedding match unavailable — fall back to the substring check.
        const lower = text.toLowerCase();
        const fallback = skills.find(s => (s.triggers || []).some(t => lower.includes(t)));
        suggestedSkill = fallback ? fallback.id : null;
      } else {
        suggestedSkill = null;
      }
      renderSuggestChip();
    }, 400);
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

  function renderAskUserCard(params) {
    return new Promise(resolve => {
      const { question, options = [], allow_multiple: multi = false, allow_free_text: freeText = true } = params || {};
      const wrap = document.createElement('div');
      wrap.className = 'message ask-user-card';
      const optsHtml = options.map((o, i) => `<button class="ask-user-opt" data-idx="${i}" type="button">${escHtml(o)}</button>`).join('');
      wrap.innerHTML = `
        <p class="ask-user-question">${escHtml(question || '')}</p>
        <div class="ask-user-opts">${optsHtml}</div>
        ${freeText ? `<div class="ask-user-free"><input type="text" class="ask-user-input" placeholder="Or type your own answer…"><button class="ask-user-submit" type="button">Send</button></div>` : ''}`;
      chatWindow.appendChild(wrap);
      chatWindow.scrollTop = chatWindow.scrollHeight;

      const selected = new Set();
      function finish(answer) {
        wrap.querySelectorAll('button, input').forEach(el => el.disabled = true);
        wrap.classList.add('answered');
        resolve(answer);
      }
      wrap.querySelectorAll('.ask-user-opt').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!multi) return finish(options[Number(btn.dataset.idx)]);
          btn.classList.toggle('selected');
          const idx = Number(btn.dataset.idx);
          selected.has(idx) ? selected.delete(idx) : selected.add(idx);
        });
      });
      if (multi && options.length) {
        const doneBtn = document.createElement('button');
        doneBtn.className = 'ask-user-submit';
        doneBtn.textContent = 'Confirm selection';
        doneBtn.addEventListener('click', () => finish([...selected].sort().map(i => options[i]).join(', ')));
        wrap.querySelector('.ask-user-opts').insertAdjacentElement('afterend', doneBtn);
      }
      const input = wrap.querySelector('.ask-user-input');
      const submit = wrap.querySelector('.ask-user-free .ask-user-submit');
      if (input && submit) {
        submit.addEventListener('click', () => { if (input.value.trim()) finish(input.value.trim()); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) finish(input.value.trim()); });
      }
    });
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

    let workspaceLine = '';
    try {
      const session = await api('GET', '/api/code-session');
      const root = session?.root_path || '';
      if (root) {
        workspaceLine = `WORKSPACE ROOT: ${root} — every file path MUST start with this prefix.`;
        const activeFile = getFocusedEditor?.()?.getActiveFile();
        if (activeFile) workspaceLine += `\nOpen file: ${activeFile}`;
      }
    } catch (_) {}

    const apiMessages = [];
    const sysMsg = [manifest, workspaceLine].filter(Boolean).join('\n\n');
    if (sysMsg) apiMessages.push({ role: 'system', content: sysMsg });
    apiMessages.push(...history);

    let assistantDiv = null;
    try {
      let looping = true;
      while (looping) {
        looping = false;
        let fullText = '';
        let turnToolCalls = null;
        assistantDiv = appendBubble('assistant', '▋');
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
            const result = await executeCodeTool(tc.function.name, tc.function.arguments ?? {});
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
      if (assistantDiv) {
        assistantDiv.innerHTML = marked.parse(`*Error: ${err?.message || 'request failed'}*`);
      } else {
        appendBubble('assistant', `*Error: ${err?.message || 'request failed'}*`);
      }
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  async function executeCodeTool(name, params) {
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
        case 'propose_edit': {
          const editorCtrl = getFocusedEditor();
          if (!editorCtrl) return 'Error: no Editor pane open';
          // Switch to the target file in the focused Editor pane if it isn't already
          // the active tab there — opens it fresh (real content via fileProvider.read)
          // if it wasn't open in this pane at all yet.
          const autoAccept = shouldAutoAccept(params.path, isFileOpenAnywhere);
          if (editorCtrl.getActiveFile() !== params.path) await editorCtrl.openFile(params.path);
          const oldContent = (await fileProvider.read(params.path).catch(() => null));
          if (oldContent == null) return `Error: could not read ${params.path}`;
          const idx = params.replace_all
            ? null
            : (() => { const i = oldContent.indexOf(params.old_string); return i === oldContent.lastIndexOf(params.old_string) ? i : -1; })();
          if (!params.replace_all && idx === -1) return 'Error: old_string must occur exactly once (or set replace_all)';
          const newContent = params.replace_all
            ? oldContent.split(params.old_string).join(params.new_string)
            : oldContent.slice(0, idx) + params.new_string + oldContent.slice(idx + params.old_string.length);
          const { applied, hunkCount } = await editorCtrl.proposeDiff(newContent, { autoAccept });
          return applied ? `Applied ${hunkCount} hunk(s) to ${params.path}` : `Proposed ${hunkCount} hunk(s) to ${params.path}, shown to the user for review`;
        }
        case 'propose_new_file': {
          let editorCtrl = getFocusedEditor();
          if (!editorCtrl) return 'Error: no Editor pane open';
          const autoAccept = shouldAutoAccept(params.path, isFileOpenAnywhere);
          await editorCtrl.openFile(params.path, { initialContent: '' });
          const { applied, hunkCount } = await editorCtrl.proposeDiff(params.content, { autoAccept });
          return applied ? `Created ${params.path}` : `Proposed new file ${params.path} (${hunkCount} hunk(s)), shown to the user for review`;
        }
        case 'ask_user':
          return await renderAskUserCard(params);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e) {
      return `Tool error: ${e.message}`;
    }
  }

  function shouldAutoAccept(path, isFileOpenAnywhereFn) {
    const mode = autoBtn.dataset.mode;
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    const risky = !isFileOpenAnywhereFn?.(path); // 'risky' mode: auto-accept unless risky
    return !risky;
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

