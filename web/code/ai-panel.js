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

// Mirrors agent/worker.py's _edit_file_content: exact match first, falling back to a
// trailing-whitespace-insensitive line match when the exact string isn't found (the most
// common accidental mismatch). Returns { content } or { error }.
function resolveEditReplacement(oldContent, oldString, newString, replaceAll) {
  const count = oldContent.split(oldString).length - 1;
  if (count === 1 || (count > 1 && replaceAll)) {
    return { content: replaceAll ? oldContent.split(oldString).join(newString) : oldContent.replace(oldString, newString) };
  }

  const fileLines = oldContent.split('\n');
  if (count === 0) {
    const oldLines = oldString.split('\n');
    const matches = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (fileLines[i + j].replace(/\s+$/, '') !== oldLines[j].replace(/\s+$/, '')) { ok = false; break; }
      }
      if (ok) matches.push(i);
    }
    if (matches.length === 1) {
      const i = matches[0];
      const newLines = fileLines.slice(0, i).concat(newString.split('\n'), fileLines.slice(i + oldLines.length));
      return { content: newLines.join('\n') };
    }
    if (matches.length > 1) {
      return { error: `old_string matches ${matches.length} places when ignoring trailing whitespace — add more surrounding context to make it unique, or set replace_all=true` };
    }
    return { error: 'old_string not found in file, even after ignoring trailing whitespace differences.' };
  }

  let lineNums = null;
  if (!oldString.includes('\n')) {
    lineNums = [];
    fileLines.forEach((l, i) => { if (l.includes(oldString)) lineNums.push(i + 1); });
  }
  if (lineNums && lineNums.length) {
    const shown = lineNums.slice(0, 8).join(', ');
    const more = lineNums.length > 8 ? ` (+${lineNums.length - 8} more)` : '';
    return { error: `old_string occurs ${count} times, at lines ${shown}${more} — add surrounding context to make it unique, or set replace_all=true` };
  }
  return { error: `old_string occurs ${count} times — add surrounding context to make it unique, or set replace_all=true` };
}

// ── Thinking indicator ──────────────────────────────────────────────────────
// Shown from send until the first streamed chunk arrives, replacing the old static "▋".

const THINKING_PHRASES = ['Thinking', 'Working on it', 'Reasoning'];

function thinkingIndicatorHTML() {
  return `<span class="code-thinking"><span class="code-thinking-label">${THINKING_PHRASES[0]}</span><span class="code-thinking-dots"></span></span>`;
}

function startThinking(el) {
  let idx = 0;
  el.innerHTML = thinkingIndicatorHTML();
  return setInterval(() => {
    idx = (idx + 1) % THINKING_PHRASES.length;
    const label = el.querySelector('.code-thinking-label');
    if (label) label.textContent = THINKING_PHRASES[idx];
  }, 1400);
}

// ── Spinning favicon while busy ──────────────────────────────────────────────
// Shared across all chat panes (module-level) so multiple panes don't fight over the tab icon.

const FAVICON_HREF = '/favicon.ico';
let faviconBusyCount = 0;
let faviconSpinTimer = null;
let faviconAngle = 0;
let faviconImg = null;

function faviconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

function spinFaviconFrame() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size / 2, size / 2);
  ctx.rotate(faviconAngle);
  ctx.drawImage(faviconImg, -size / 2, -size / 2, size, size);
  faviconLink().href = canvas.toDataURL('image/png');
  faviconAngle += Math.PI / 8;
}

function startFaviconSpin() {
  faviconBusyCount++;
  if (faviconBusyCount > 1) return;
  if (faviconImg) { faviconSpinTimer = setInterval(spinFaviconFrame, 100); return; }
  const img = new Image();
  img.onload = () => {
    faviconImg = img;
    if (faviconBusyCount > 0) faviconSpinTimer = setInterval(spinFaviconFrame, 100);
  };
  img.src = FAVICON_HREF;
}

function stopFaviconSpin() {
  faviconBusyCount = Math.max(0, faviconBusyCount - 1);
  if (faviconBusyCount > 0) return;
  clearInterval(faviconSpinTimer);
  faviconSpinTimer = null;
  faviconAngle = 0;
  faviconLink().href = FAVICON_HREF;
}

export function createChatPane(bodyEl, { aiProvider, fileProvider, getFocusedEditor, isFileOpenAnywhere, onFileTreeChanged } = {}) {
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
      <button class="code-send-btn send-btn" title="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
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

  // An agent already has a model attached — once one is picked, lock the model
  // select to it instead of letting the user choose a model the agent won't use.
  let allModels = [];
  function applyModelSelectState() {
    const agent = agentSelect.value ? agentsList.find(a => a.id === agentSelect.value) : null;
    if (agent?.model) {
      modelSelect.innerHTML = `<option value="${escHtml(agent.model)}">${escHtml(agent.model)}</option>`;
      modelSelect.value = agent.model;
      modelSelect.disabled = true;
    } else {
      modelSelect.innerHTML = allModels.map(m => `<option value="${m}">${m}</option>`).join('');
      modelSelect.disabled = false;
    }
  }
  agentSelect.addEventListener('change', applyModelSelectState);

  const AUTO_MODES = ['off', 'all', 'risky'];
  const AUTO_LABELS = { off: 'Off', all: 'Auto-accept all', risky: 'Auto-accept, ask on risky' };
  let autoIdx = 0;
  autoBtn.addEventListener('click', () => {
    autoIdx = (autoIdx + 1) % AUTO_MODES.length;
    autoBtn.dataset.mode = AUTO_MODES[autoIdx];
    autoBtn.textContent = AUTO_LABELS[AUTO_MODES[autoIdx]];
  });

  aiProvider.listModels().then(models => {
    allModels = models;
    applyModelSelectState();
  });

  let skills = [];
  let pinnedSkill = null;
  let suggestedSkill = null;
  aiProvider.listSkills().then(list => {
    skills = list;
    skillPicker.innerHTML = '<option value="">No skill</option>' +
      skills.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
  }).catch(() => {});
  skillPicker.addEventListener('change', () => { pinnedSkill = skillPicker.value || null; });

  function renderSuggestChip() {
    if (!suggestedSkill) { suggestChip.classList.add('hidden'); suggestChip.innerHTML = ''; return; }
    const skill = skills.find(s => s.id === suggestedSkill);
    if (!skill) { suggestChip.classList.add('hidden'); suggestChip.innerHTML = ''; return; }
    suggestChip.classList.remove('hidden');
    suggestChip.innerHTML = `Use <b>${escHtml(skill.name)}</b> skill? <button class="code-suggest-accept">Accept</button><button class="code-suggest-dismiss">Dismiss</button>`;
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
      } else {
        // No match (or an in-band error, or no eligible embeddings server-side) —
        // always fall back to the substring/triggers check before giving up.
        const lower = text.toLowerCase();
        const fallback = skills.find(s => (s.triggers || []).some(t => lower.includes(t)));
        suggestedSkill = fallback ? fallback.id : null;
      }
      renderSuggestChip();
    }, 400);
  });

  let busy = false;
  const history = [];

  function appendBubble(role, content) {
    const wrap = document.createElement('div');
    wrap.className = `message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'assistant') {
      const rd = document.createElement('div');
      rd.className = 'response-content';
      rd.innerHTML = marked.parse(content);
      bubble.appendChild(rd);
    } else {
      bubble.textContent = content;
    }
    wrap.appendChild(bubble);
    wrap.appendChild(buildMeta(role, content, null));
    if (role === 'assistant') wrap.appendChild(buildBrandMark());
    chatWindow.appendChild(wrap);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    if (role === 'assistant') bubble.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
    return bubble;
  }

  function createAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'message assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const rd = document.createElement('div');
    rd.className = 'response-content';
    bubble.appendChild(rd);
    wrap.appendChild(bubble);
    chatWindow.appendChild(wrap);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return { wrap, rd };
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
    const pinnedSkillObj = skillForThisMessage ? skills.find(s => s.id === skillForThisMessage) : null;

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
    const sysMsg = [manifest, workspaceLine, pinnedSkillObj?.instructions].filter(Boolean).join('\n\n');
    if (sysMsg) apiMessages.push({ role: 'system', content: sysMsg });
    apiMessages.push(...history);

    const { wrap: assistantWrap, rd: assistantEl } = createAssistantBubble();
    let fullText = '';
    let thinkingTimer = null;
    startFaviconSpin();
    try {
      let looping = true;
      while (looping) {
        looping = false;
        fullText = '';
        let turnToolCalls = null;
        thinkingTimer = startThinking(assistantEl);
        for await (const chunk of aiProvider.chat({ messages: apiMessages, model, tools })) {
          if (typeof chunk === 'string') {
            if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
            fullText += chunk;
            assistantEl.innerHTML = marked.parse(fullText) + '<span class="code-stream-cursor"></span>';
            chatWindow.scrollTop = chatWindow.scrollHeight;
          } else if (chunk?.toolCalls) {
            turnToolCalls = chunk.toolCalls;
          }
        }
        clearInterval(thinkingTimer);
        thinkingTimer = null;
        if (turnToolCalls?.length) {
          apiMessages.push({ role: 'assistant', content: '', tool_calls: turnToolCalls });
          if (fullText) history.push({ role: 'assistant', content: fullText });
          const toolWrap = renderToolCallBubble(chatWindow, turnToolCalls);
          for (let i = 0; i < turnToolCalls.length; i++) {
            const tc = turnToolCalls[i];
            const result = await executeCodeTool(tc.function.name, tc.function.arguments ?? {});
            renderToolResultBubble(toolWrap, i, result);
            apiMessages.push({ role: 'tool', content: String(result) });
          }
          looping = true;
        } else {
          history.push({ role: 'assistant', content: fullText });
          pinnedSkill = null;
          skillPicker.value = '';
        }
      }
      if (fullText) {
        assistantEl.innerHTML = marked.parse(fullText);
        assistantEl.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
      } else {
        assistantWrap.remove();
      }
    } catch (err) {
      assistantEl.innerHTML = marked.parse(`*Error: ${err?.message || 'request failed'}*`);
    } finally {
      clearInterval(thinkingTimer);
      busy = false;
      sendBtn.disabled = false;
      stopFaviconSpin();
    }
    if (assistantWrap.isConnected) {
      assistantWrap.appendChild(buildMeta('assistant', fullText, null));
      assistantWrap.appendChild(buildBrandMark());
    }
  }

  // Every failure path returns a string starting with "Error:" — finishToolBlock() (app.js)
  // keys off that prefix to show a red "Error" status instead of "Done", so a failed tool
  // call is visibly distinguishable in the transcript even if the model's own reply doesn't
  // correctly acknowledge the failure.
  async function executeCodeTool(name, params) {
    try {
      switch (name) {
        case 'read_file': {
          const r = await api('POST', '/api/tools/exec', { name: 'read_file', args: params });
          if (r?.error) return `Error: ${r.error}`;
          return typeof r === 'string' ? r : (r.content ?? JSON.stringify(r));
        }
        case 'list_dir': {
          const r = await api('POST', '/api/tools/exec', { name: 'list_files', args: params });
          if (r?.error) return `Error: ${r.error}`;
          return typeof r === 'string' ? r : JSON.stringify(r);
        }
        case 'search_files':
        case 'run_command': {
          const r = await api('POST', '/api/tools/exec', { name, args: params });
          if (r?.error) return `Error: ${r.error}`;
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
          if (!params.old_string) return 'Error: old_string is required';
          const resolved = resolveEditReplacement(oldContent, params.old_string, params.new_string, params.replace_all);
          if (resolved.error) return `Error: ${resolved.error}`;
          const { applied, hunkCount } = await editorCtrl.proposeDiff(resolved.content, { autoAccept });
          return applied ? `Applied ${hunkCount} hunk(s) to ${params.path}`
            : `NOT applied yet: ${hunkCount} hunk(s) proposed to ${params.path} and shown to the user for review in the editor. ` +
              `Do not tell the user the file has been changed — it hasn't, until they accept the hunk(s) themselves.`;
        }
        case 'propose_new_file': {
          let editorCtrl = getFocusedEditor();
          if (!editorCtrl) return 'Error: no Editor pane open';
          const autoAccept = shouldAutoAccept(params.path, isFileOpenAnywhere);
          await editorCtrl.openFile(params.path, { initialContent: '' });
          const { applied, hunkCount } = await editorCtrl.proposeDiff(params.content, { autoAccept, onSettled: onFileTreeChanged });
          return applied ? `Created ${params.path}`
            : `NOT created yet: new file ${params.path} (${hunkCount} hunk(s)) proposed and shown to the user for review in the editor. ` +
              `Do not tell the user the file has been created — it hasn't, until they accept the hunk(s) themselves.`;
        }
        case 'ask_user':
          return await renderAskUserCard(params);
        default:
          return `Error: unknown tool: ${name}`;
      }
    } catch (e) {
      return `Error: ${e.message}`;
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

