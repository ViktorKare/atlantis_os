import { mergeLazyEdit, stripFence, applyOutputProblem, suspiciousRewrite } from './edit-merge.js';

const CODE_TOOL_DEFS = {
  read_file:    { type:'function', function:{ name:'read_file',    description:'Read the contents of a file', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:['path'] } } },
  list_dir:     { type:'function', function:{ name:'list_dir',     description:'List directory contents', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:[] } } },
  search_files: { type:'function', function:{ name:'search_files', description:'Search file contents recursively (regex or literal)', parameters:{ type:'object', properties:{ pattern:{ type:'string' }, path:{ type:'string' } }, required:['pattern'] } } },
  run_command:  { type:'function', function:{ name:'run_command',  description:'Run a bash command in the code root; returns exit code, stdout, stderr (timeout max 120s)', parameters:{ type:'object', properties:{ command:{ type:'string' }, cwd:{ type:'string' }, timeout:{ type:'integer' } }, required:['command'] } } },
  propose_edit:     { type:'function', function:{ name:'propose_edit',     description:'Edit a file by writing the NEW version of just the region you are changing. Use a comment line containing "..." (e.g. "// ... existing code ...") for unchanged spans — everything you skip is kept as-is. START and END each region with 1-3 unchanged lines copied from the file; these anchor lines locate the region (close-enough copies are fine). For a pure insertion, include the existing line above AND below the insertion point. Separate multiple changed regions with a "..." marker line. Write only what the region should look like after the edit. Shown to the user as a reviewable diff, not applied immediately unless auto-accept is on.', parameters:{ type:'object', properties:{ path:{ type:'string' }, edit:{ type:'string' }, instructions:{ type:'string', description:'One short sentence describing the intent of the change' } }, required:['path','edit'] } } },
  propose_new_file: { type:'function', function:{ name:'propose_new_file', description:'Propose creating a new file with the given content. Shown to the user as a reviewable diff against an empty file, not applied immediately unless auto-accept is on.', parameters:{ type:'object', properties:{ path:{ type:'string' }, content:{ type:'string' } }, required:['path','content'] } } },
  propose_rewrite:  { type:'function', function:{ name:'propose_rewrite',  description:'Propose replacing the ENTIRE contents of an existing file with new content. content REPLACES the file byte-for-byte — it must be the complete file, unchanged parts included in full. Never write a placeholder/comment like "rest of the file stays the same" instead of the actual unchanged content: there is no such thing as "the rest" here, anything not literally in content is deleted. If you are only changing a small part of a large file, use propose_edit instead — rarely is a full rewrite the right tool. Always shown to the user for manual review, regardless of auto-accept. Set confirm_large_deletion:true only if you are intentionally removing most of the file\'s content.', parameters:{ type:'object', properties:{ path:{ type:'string' }, content:{ type:'string' }, confirm_large_deletion:{ type:'boolean' } }, required:['path','content'] } } },
  ask_user:     { type:'function', function:{ name:'ask_user',     description:'Ask the user a clarifying question with clickable options and/or free text. Blocks until they answer.', parameters:{ type:'object', properties:{ question:{ type:'string' }, options:{ type:'array', items:{ type:'string' } }, allow_multiple:{ type:'boolean' }, allow_free_text:{ type:'boolean' } }, required:['question'] } } },
};

function buildCodeTools(toolPerms) {
  if (!toolPerms) return [];
  const out = [CODE_TOOL_DEFS.ask_user];
  if (toolPerms.files) out.push(CODE_TOOL_DEFS.read_file, CODE_TOOL_DEFS.list_dir, CODE_TOOL_DEFS.search_files, CODE_TOOL_DEFS.propose_edit, CODE_TOOL_DEFS.propose_new_file, CODE_TOOL_DEFS.propose_rewrite);
  if (toolPerms.shell) out.push(CODE_TOOL_DEFS.run_command);
  return out;
}

function buildCodeToolManifest(toolPerms) {
  if (!toolPerms) return '';
  const lines = ['## Tools available', 'ask_user is always available to pause and ask the user a question.'];
  if (toolPerms.files) {
    lines.push('- **read_file**, **list_dir**, **search_files** — read-only, run immediately');
    lines.push('- **propose_edit** / **propose_new_file** — edits are shown to the user for review, not applied immediately unless auto-accept is on. propose_edit takes the NEW content of the changed region: skip unchanged spans with a "// ... existing code ..." line, and start/end each region with 1-3 unchanged anchor lines copied from the file.');
    lines.push('- **propose_rewrite** — replaces a whole existing file; content must be the COMPLETE file, never a placeholder for unchanged parts. Rarely needed — prefer propose_edit for anything short of a full rewrite.');
  }
  if (toolPerms.shell) lines.push('- **run_command** — runs immediately in the code root');
  return lines.join('\n');
}

// Settings-tab-configurable size cap (chars) for echoing a file's current content back
// when a propose_edit fails to merge — see 'Edit-failure feedback limit' under Code editor.
async function editErrorContentLimit() {
  try {
    const s = await api('GET', '/api/settings');
    return Number.isFinite(s?.editErrorContentLimit) ? s.editErrorContentLimit : 8000;
  } catch (_) {
    return 8000;
  }
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

  const APPLY_SYSTEM_PROMPT = 'You are a code-merge engine. Apply the EDIT to the FILE CONTENT. The EDIT shows the new version of one or more regions of the file; lines containing "..." (e.g. "// ... existing code ...") mark unchanged spans that must be kept exactly as they are in the file. Output the COMPLETE merged file content and nothing else — no explanations, no markdown code fences.';

  // LLM fallback when the deterministic merge refuses (mirrors _apply_model_merge in
  // agent/worker.py). applyModel setting: router tier name or explicit Ollama model id;
  // empty → the panel's current chat model. Returns { content } or { reason }.
  async function applyModelMerge(fileContent, edit, instructions) {
    try {
      const s = await api('GET', '/api/settings').catch(() => ({}));
      const val = String(s?.applyModel || '').trim();
      let model = val;
      let router = {};
      try { router = JSON.parse(s?.model_router || '{}'); } catch (_) {}
      const tier = router.tiers?.[val];
      if (tier) {
        if ((tier.provider || 'ollama') !== 'ollama') {
          return { reason: 'skipped (apply model tier is not an Ollama model — the editor panel can only call Ollama directly)' };
        }
        model = tier.model || '';
      }
      if (!model) model = modelSelect.value;
      if (!model) return { reason: 'skipped (no apply model available)' };
      const messages = [
        { role: 'system', content: APPLY_SYSTEM_PROMPT },
        { role: 'user', content: `FILE CONTENT:\n\`\`\`\n${fileContent}\n\`\`\`\n\nEDIT:\n\`\`\`\n${edit}\n\`\`\`` + (instructions ? `\n\nINTENT: ${instructions}` : '') },
      ];
      let out = '';
      for await (const chunk of aiProvider.chat({ messages, model })) {
        if (typeof chunk === 'string') out += chunk;
      }
      const merged = stripFence(out);
      const problem = applyOutputProblem(fileContent, merged);
      if (problem) return { reason: `failed (${problem})` };
      return { content: merged };
    } catch (e) {
      return { reason: `failed (${e.message})` };
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
          if (!params.edit) return 'Error: edit is required — write the new content of the region you are changing, with "// ... existing code ..." marker lines around unchanged spans';
          let merged = mergeLazyEdit(oldContent, params.edit);
          if (merged.error) return `Error: ${merged.error}`;
          let viaApplyModel = false;
          if (merged.refusal) {
            const fb = await applyModelMerge(oldContent, params.edit, params.instructions || '');
            if (fb.content != null) {
              merged = { content: fb.content };
              viaApplyModel = true;
            } else {
              // Ground the model's next retry in the real content instead of leaving it to
              // guess again from stale/misremembered context.
              const limit = await editErrorContentLimit();
              const hint = oldContent.length <= limit
                ? `\n\nCurrent actual content of ${params.path}:\n\`\`\`\n${oldContent}\n\`\`\``
                : `\n\nFile is large (${oldContent.length} chars) — call read_file on ${params.path} to see the current content before retrying.`;
              return `Error: could not locate the edited region (${merged.refusal}); fallback merge ${fb.reason}.${hint}`;
            }
          }
          // Apply-model output skips auto-accept: it's model-generated whole-file content,
          // so it gets rewrite-grade manual review rather than the targeted-edit fast path.
          const { applied, hunkCount } = await editorCtrl.proposeDiff(merged.content, { autoAccept: viaApplyModel ? false : autoAccept });
          return applied ? `Applied ${hunkCount} hunk(s) to ${params.path}`
            : `NOT applied yet: ${hunkCount} hunk(s) proposed to ${params.path} and shown to the user for review in the editor. ` +
              `Do not tell the user the file has been changed — it hasn't, until they accept the hunk(s) themselves.`;
        }
        case 'propose_rewrite': {
          const editorCtrl = getFocusedEditor();
          if (!editorCtrl) return 'Error: no Editor pane open';
          if (editorCtrl.getActiveFile() !== params.path) await editorCtrl.openFile(params.path);
          const oldContent = (await fileProvider.read(params.path).catch(() => null));
          if (oldContent != null && !params.confirm_large_deletion) {
            const guard = suspiciousRewrite(oldContent, params.content || '');
            if (guard) return `Error: ${guard}`;
          }
          // Full rewrites always require manual review regardless of the auto-accept setting —
          // a bad rewrite silently destroys content, a much higher blast radius than a bad
          // targeted edit, so it doesn't get the same fast path.
          const { applied, hunkCount } = await editorCtrl.proposeDiff(params.content, { autoAccept: false });
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

