// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.body    = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

const DEFAULT_OLLAMA_ENDPOINT = 'http://192.168.1.205:11434,http://192.168.1.251:11434,http://192.168.1.240:11434,http://localhost:11434';
let OLLAMA = DEFAULT_OLLAMA_ENDPOINT;
let _ollamaHostCache = { url: null, ts: 0 };

// Picks the first reachable host from a comma-separated endpoint setting
// (default: 205 → 251 → 240 → localhost fallback chain), caching the winner for 20s.
async function resolveOllama() {
  const candidates = (OLLAMA || DEFAULT_OLLAMA_ENDPOINT).split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (candidates.length <= 1) return candidates[0] || 'http://localhost:11434';
  const now = Date.now();
  if (_ollamaHostCache.url && now - _ollamaHostCache.ts < 20000) return _ollamaHostCache.url;
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      await fetch(`${url}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      _ollamaHostCache = { url, ts: now };
      return url;
    } catch (_) {}
  }
  return candidates[0];
}

let state    = { threads: [], activeId: null, model: '', selectedAgentId: null };
let models   = [];
let agents   = [];
let tasks    = [];
let settings = { endpoint: OLLAMA, showTokenStats: true, showThinking: true, timeoutHours: 5, pipelineManagerModel: '', pipelineMaxRetries: 3, brainPrePrompt: '', agentPrePrompt: '', chatPrePrompt: '', codeServerUrl: 'http://localhost:5001', defaultAgentId: '' };

let abortController = null;
let isGenerating    = false;
let activeAgentId   = null;  // in Agents section
let activeTaskId    = null;
let runningTaskId   = null;
let activeSection   = 'home';
const sectionScrolls = {};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const threadList   = document.getElementById('thread-list');
const newChatBtn   = document.getElementById('new-chat-btn');
const agentSelect  = document.getElementById('agent-select');
const modelSelect  = document.getElementById('model-select');
const clearBtn     = document.getElementById('clear-btn');
const systemPrompt = document.getElementById('system-prompt');
const chatWindow   = document.getElementById('chat-window');
const userInput    = document.getElementById('user-input');
const abandonBtn   = document.getElementById('abandon-btn');
const sendBtn      = document.getElementById('send-btn');
const homeGreeting     = document.getElementById('home-greeting');
const homeInput        = document.getElementById('home-input');
const homeAgentSelect  = document.getElementById('home-agent-select');
const homeModelSelect  = document.getElementById('home-model-select');
const homeSendBtn      = document.getElementById('home-send-btn');
const homeRecent       = document.getElementById('home-recent');

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Section routing ───────────────────────────────────────────────────────────
function switchSection(name) {
  const curEl = document.getElementById(`section-${activeSection}`);
  const scrollable = curEl?.querySelector('#chat-window, .editor-area, #settings-main, #home-chat-window, #dbg-log-body');
  if (scrollable) sectionScrolls[activeSection] = scrollable.scrollTop;
  if (activeSection === 'debug') stopDebug();
  if (activeSection === 'hosts') stopHostsPolling();

  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.add('active');
  document.querySelector(`.nav-btn[data-section="${name}"]`).classList.add('active');
  activeSection = name;

  const newEl = document.getElementById(`section-${name}`);
  const newScrollable = newEl?.querySelector('#chat-window, .editor-area, #settings-main, #home-chat-window, #dbg-log-body');
  if (newScrollable && sectionScrolls[name] != null) {
    newScrollable.scrollTop = sectionScrolls[name];
  }

  if (name === 'home')     initHome();
  if (name === 'agents')   renderAgentList();
  if (name === 'tasks')    loadTasks().then(() => renderTaskList());
  if (name === 'plans')    loadPlanList().then(() => renderPlanList());
  if (name === 'pipelines') { initPipeCanvas(); loadPipelines().then(renderPipeList); }
  if (name === 'debug')    { initDebug(); loadBrainPanel(); }
  if (name === 'models')   initModels();
  if (name === 'hosts')    initHosts();
  if (name === 'code')     initCode();
  if (name === 'settings') loadSettings().then(initSettingsForm);
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSection(btn.dataset.section));
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const data = await api('GET', '/api/settings');
    settings = { ...settings, ...data };
  } catch (_) {}
  OLLAMA = settings.endpoint || DEFAULT_OLLAMA_ENDPOINT;
}

function saveSettings() {
  OLLAMA = settings.endpoint || DEFAULT_OLLAMA_ENDPOINT;
  return api('POST', '/api/settings', settings);
}

function initSettingsForm() {
  document.getElementById('setting-endpoint').value      = settings.endpoint;
  document.getElementById('setting-timeout').value       = settings.timeoutHours;
  document.getElementById('setting-token-stats').checked = settings.showTokenStats;
  document.getElementById('setting-thinking').checked    = settings.showThinking;
  const antKey = document.getElementById('setting-anthropic-key');
  if (antKey) antKey.value = settings.anthropicApiKey || '';
  const oaiKey = document.getElementById('setting-openai-key');
  if (oaiKey) oaiKey.value = settings.openaiApiKey || '';
  const pmSel = document.getElementById('setting-pipeline-model');
  if (pmSel) {
    pmSel.innerHTML = models.map(m =>
      `<option value="${escHtml(m)}"${m === settings.pipelineManagerModel ? ' selected' : ''}>${escHtml(m)}</option>`
    ).join('');
    if (settings.pipelineManagerModel && models.includes(settings.pipelineManagerModel))
      pmSel.value = settings.pipelineManagerModel;
  }
  const retEl = document.getElementById('setting-pipeline-retries');
  if (retEl) retEl.value = settings.pipelineMaxRetries ?? 3;

  const brainPP = document.getElementById('setting-brain-preprompt');
  if (brainPP) brainPP.value = settings.brainPrePrompt ?? '';
  const agentPP = document.getElementById('setting-agent-preprompt');
  if (agentPP) agentPP.value = settings.agentPrePrompt ?? '';
  const chatPP  = document.getElementById('setting-chat-preprompt');
  if (chatPP)  chatPP.value  = settings.chatPrePrompt  ?? '';
  const csUrl = document.getElementById('setting-code-server-url');
  if (csUrl) csUrl.value = settings.codeServerUrl ?? 'http://localhost:5001';

  const defAgentSel = document.getElementById('setting-default-agent');
  if (defAgentSel) {
    defAgentSel.innerHTML = '<option value="">No agent</option>' +
      agents.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    defAgentSel.value = settings.defaultAgentId || '';
  }
}

document.getElementById('save-settings-btn').addEventListener('click', () => {
  settings.endpoint              = document.getElementById('setting-endpoint').value.trim() || DEFAULT_OLLAMA_ENDPOINT;
  settings.timeoutHours          = parseFloat(document.getElementById('setting-timeout').value) || 0;
  settings.showTokenStats        = document.getElementById('setting-token-stats').checked;
  settings.showThinking          = document.getElementById('setting-thinking').checked;
  settings.pipelineManagerModel  = document.getElementById('setting-pipeline-model')?.value || '';
  settings.pipelineMaxRetries    = parseInt(document.getElementById('setting-pipeline-retries')?.value, 10) || 3;
  settings.brainPrePrompt        = document.getElementById('setting-brain-preprompt')?.value ?? '';
  settings.agentPrePrompt        = document.getElementById('setting-agent-preprompt')?.value ?? '';
  settings.chatPrePrompt         = document.getElementById('setting-chat-preprompt')?.value  ?? '';
  settings.anthropicApiKey       = document.getElementById('setting-anthropic-key')?.value  ?? '';
  settings.openaiApiKey          = document.getElementById('setting-openai-key')?.value     ?? '';
  settings.codeServerUrl         = document.getElementById('setting-code-server-url')?.value.trim() || 'http://localhost:5001';
  settings.defaultAgentId        = document.getElementById('setting-default-agent')?.value || '';
  const btn = document.getElementById('save-settings-btn');
  btn.disabled = true;
  saveSettings()
    .then(() => { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500); })
    .catch(e  => { btn.textContent = 'Error!'; btn.disabled = false; console.error('Settings save failed:', e); });
});

document.getElementById('export-data-btn').addEventListener('click', async () => {
  try {
    const data = await api('GET', '/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ollama-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  } catch (e) { alert(`Export failed: ${e.message}`); }
});

document.getElementById('import-data-btn').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      await api('POST', '/api/import', data);
      location.reload();
    } catch { alert('Import failed — invalid backup file.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('clear-data-btn').addEventListener('click', async () => {
  if (!confirm('Delete all chats, agents, tasks, and settings? This cannot be undone.')) return;
  await api('DELETE', '/api/data');
  location.reload();
});

// ── Agents ────────────────────────────────────────────────────────────────────
async function loadAgents() {
  try { agents = await api('GET', '/api/agents'); } catch (_) {}
  if (!Array.isArray(agents)) agents = [];
}

async function createAgent() {
  const agent = { id: uid(), name: 'New agent', model: state.model || '', systemPrompt: '', temperature: 0.7, topP: 0.9, contextLen: 4096, fileAccess: false, webAccess: false, tools: { files: false, web: false, shell: false, browser: false } };
  agents.unshift(agent);
  activeAgentId = agent.id;
  await api('POST', '/api/agents', agent).catch(() => {});
  refreshAgentDropdown();
  renderAgentList();
  renderAgentEditor(agent);
}

async function deleteAgent(id) {
  if (!confirm('Delete this agent?')) return;
  agents = agents.filter(a => a.id !== id);
  if (activeAgentId === id) activeAgentId = agents[0]?.id || null;
  api('DELETE', `/api/agents/${id}`).catch(() => {});
  refreshAgentDropdown();
  renderAgentList();
  renderAgentEditor(agents.find(a => a.id === activeAgentId) || null);
}

function saveAgentFromForm(id) {
  const agent = agents.find(a => a.id === id);
  if (!agent) return;
  agent.name         = document.getElementById('agent-name').value.trim() || 'Unnamed';
  agent.model        = document.getElementById('agent-model').value;
  agent.systemPrompt = document.getElementById('agent-system-prompt').value;
  agent.temperature  = parseFloat(document.getElementById('agent-temperature').value);
  agent.topP         = parseFloat(document.getElementById('agent-top-p').value);
  agent.contextLen   = parseInt(document.getElementById('agent-context').value, 10);
  agent.fileAccess   = document.getElementById('agent-file-access').checked;
  agent.webAccess    = document.getElementById('agent-web-access').checked;
  agent.tools        = {
    files:   document.getElementById('agent-tool-files').checked,
    web:     document.getElementById('agent-tool-web').checked,
    shell:   document.getElementById('agent-tool-shell').checked,
    browser: document.getElementById('agent-tool-browser').checked,
  };
  api('PUT', `/api/agents/${id}`, agent).catch(() => {});
  refreshAgentDropdown();
  renderAgentList();
  const btn = document.getElementById('save-agent-btn');
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save agent'; }, 1500); }
}

function renderAgentList() {
  threadList; // ensure chat refs don't shadow
  const list = document.getElementById('agent-list');
  list.innerHTML = '';
  agents.forEach(agent => {
    const li = document.createElement('li');
    li.className = agent.id === activeAgentId ? 'active' : '';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = agent.name;

    const subSpan = document.createElement('span');
    subSpan.className = 'item-sub';
    subSpan.textContent = agent.model || '—';

    li.appendChild(nameSpan);
    li.appendChild(subSpan);
    li.addEventListener('click', () => {
      activeAgentId = agent.id;
      renderAgentList();
      renderAgentEditor(agent);
    });
    list.appendChild(li);
  });
}

function renderAgentEditor(agent) {
  const main = document.getElementById('agents-main');
  if (!agent) {
    main.innerHTML = '<p class="empty-state">Select an agent or create a new one</p>';
    return;
  }
  main.innerHTML = `
    <div class="editor-form">
      <div class="editor-field">
        <label>Name</label>
        <input type="text" id="agent-name" value="${escHtml(agent.name)}">
      </div>
      <div class="editor-field">
        <label>Model</label>
        <select id="agent-model">
          ${models.map(m => `<option value="${escHtml(m)}"${m === agent.model ? ' selected' : ''}>${escHtml(m)}</option>`).join('')}
        </select>
      </div>
      <div class="editor-field">
        <label>System prompt</label>
        <textarea id="agent-system-prompt" rows="6" placeholder="Enter system prompt...">${escHtml(agent.systemPrompt)}</textarea>
      </div>
      <div class="editor-field">
        <label>Temperature <span class="range-val" id="agent-temp-val">${agent.temperature}</span></label>
        <input type="range" id="agent-temperature" min="0" max="2" step="0.1" value="${agent.temperature}">
      </div>
      <div class="editor-field">
        <label>Top P <span class="range-val" id="agent-topp-val">${agent.topP}</span></label>
        <input type="range" id="agent-top-p" min="0" max="1" step="0.05" value="${agent.topP}">
      </div>
      <div class="editor-field">
        <label>Context length</label>
        <input type="number" id="agent-context" value="${agent.contextLen}" min="512" max="131072" step="512">
      </div>
      <div class="editor-field toggle-field">
        <label for="agent-file-access">File access</label>
        <input type="checkbox" id="agent-file-access"${agent.fileAccess ? ' checked' : ''}>
      </div>
      <div id="agent-file-zone"${agent.fileAccess ? '' : ' class="hidden"'}>
        <div class="editor-hint">Zone: <code>agent_zones/${agent.id}/</code> &middot; Shared: <code>projects/</code></div>
      </div>
      <div class="editor-field toggle-field">
        <label for="agent-web-access">Web access</label>
        <input type="checkbox" id="agent-web-access"${agent.webAccess ? ' checked' : ''}>
      </div>
      <div id="agent-web-hint"${agent.webAccess ? '' : ' class="hidden"'}>
        <div class="editor-hint">Can search the web and fetch URLs via action blocks.</div>
      </div>
      <div class="editor-field">
        <label>Native tools <span class="label-hint">(Ollama function calling)</span></label>
        <div class="toggle-row">
          <label class="toggle-label"><input type="checkbox" id="agent-tool-files"${agent.tools?.files ? ' checked' : ''}> File system</label>
          <label class="toggle-label"><input type="checkbox" id="agent-tool-web"${agent.tools?.web   ? ' checked' : ''}> Web search &amp; fetch</label>
          <label class="toggle-label"><input type="checkbox" id="agent-tool-shell"${agent.tools?.shell ? ' checked' : ''}> Shell commands</label>
          <label class="toggle-label"><input type="checkbox" id="agent-tool-browser"${agent.tools?.browser ? ' checked' : ''}> Browser (web testing)</label>
        </div>
        <div class="editor-hint">Sent as Ollama <code>tools</code> array — model can call these directly without action blocks. Works with llama3.1, qwen2.5, mistral-nemo, etc. Shell runs real bash commands; Browser drives headless Chromium — grant with care.</div>
      </div>
      <div class="editor-actions">
        <button id="delete-agent-btn" class="btn-danger">Delete</button>
        <button id="save-agent-btn" class="btn-primary">Save agent</button>
      </div>
    </div>`;

  document.getElementById('agent-temperature').addEventListener('input', e => {
    document.getElementById('agent-temp-val').textContent = e.target.value;
  });
  document.getElementById('agent-top-p').addEventListener('input', e => {
    document.getElementById('agent-topp-val').textContent = e.target.value;
  });
  document.getElementById('agent-file-access').addEventListener('change', e => {
    document.getElementById('agent-file-zone').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('agent-web-access').addEventListener('change', e => {
    document.getElementById('agent-web-hint').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('save-agent-btn').addEventListener('click', () => saveAgentFromForm(agent.id));
  document.getElementById('delete-agent-btn').addEventListener('click', () => deleteAgent(agent.id));
}

function refreshAgentDropdown() {
  const cur = agentSelect.value;
  agentSelect.innerHTML = '<option value="">No agent</option>' +
    agents.map(a => `<option value="${a.id}"${a.id === cur ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
}

// ── Home ──────────────────────────────────────────────────────────────────────
function homeGreetingText() {
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  return `Good ${part}, Viktor`;
}

function renderHomeRecent() {
  const recent = state.threads.filter(t => t.name !== '__brain__').slice(0, 3);
  homeRecent.innerHTML = recent.length
    ? recent.map(t => `<div class="recent-row" data-id="${t.id}"><span class="recent-name">${escHtml(t.name)}</span></div>`).join('')
    : '<p class="empty-state">No chats yet</p>';
  homeRecent.querySelectorAll('.recent-row').forEach(row => {
    row.addEventListener('click', () => {
      switchSection('chat');
      switchThread(row.dataset.id);
    });
  });
}

function initHome() {
  homeGreeting.textContent = homeGreetingText();

  homeAgentSelect.innerHTML = '<option value="">No agent</option>' +
    agents.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  const defAgent = settings.defaultAgentId ? agents.find(a => a.id === settings.defaultAgentId) : null;
  homeAgentSelect.value = defAgent ? defAgent.id : '';

  homeModelSelect.innerHTML = modelSelect.innerHTML;
  homeModelSelect.value = defAgent ? defAgent.model : state.model;

  renderHomeRecent();
}

document.querySelectorAll('.idea-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    homeInput.value = chip.dataset.prompt;
    homeInput.style.height = 'auto';
    homeInput.style.height = Math.min(homeInput.scrollHeight, 160) + 'px';
    homeInput.focus();
  });
});

async function sendFromHome() {
  const text = homeInput.value.trim();
  if (!text) return;

  const agentId = homeAgentSelect.value || null;
  const model   = homeModelSelect.value;

  await createThread();
  state.selectedAgentId = agentId;
  agentSelect.value     = agentId || '';
  modelSelect.value     = model;
  state.model           = model;
  save();

  switchSection('chat');
  userInput.value = text;
  send();

  homeInput.value = '';
  homeInput.style.height = 'auto';
}

homeSendBtn.addEventListener('click', sendFromHome);

homeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromHome(); }
});

homeInput.addEventListener('input', () => {
  homeInput.style.height = 'auto';
  homeInput.style.height = Math.min(homeInput.scrollHeight, 160) + 'px';
});

document.getElementById('new-agent-btn').addEventListener('click', createAgent);

agentSelect.addEventListener('change', () => {
  const id = agentSelect.value;
  state.selectedAgentId = id || null;
  const agent = agents.find(a => a.id === id);
  if (agent) {
    modelSelect.value  = agent.model;
    state.model        = agent.model;
    systemPrompt.value = agent.systemPrompt;
  }
  save();
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
async function loadTasks() {
  try { tasks = await api('GET', '/api/tasks'); } catch (_) {}
  if (!Array.isArray(tasks)) tasks = [];
}

const SCHEDULE_DEFAULT = { type: 'manual', time: '09:00', day: 1, cron: '' };

function scheduleDescription(s) {
  if (!s || s.type === 'manual') return null;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (s.type === 'daily')   return `Daily at ${s.time}`;
  if (s.type === 'weekly')  return `Every ${days[s.day] ?? 'Mon'} at ${s.time}`;
  if (s.type === 'monthly') return `Monthly on day ${s.monthDay} at ${s.time}`;
  if (s.type === 'custom')  return `Cron: ${s.cron}`;
  return null;
}

async function createTask() {
  const task = { id: uid(), name: 'New task', model: state.model || '', agentId: null, promptTemplate: '', schedule: { ...SCHEDULE_DEFAULT } };
  tasks.unshift(task);
  activeTaskId = task.id;
  await api('POST', '/api/tasks', task).catch(() => {});
  renderTaskList();
  renderTaskEditor(task);
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  tasks = tasks.filter(t => t.id !== id);
  if (activeTaskId === id) activeTaskId = tasks[0]?.id || null;
  api('DELETE', `/api/tasks/${id}`).catch(() => {});
  renderTaskList();
  renderTaskEditor(tasks.find(t => t.id === activeTaskId) || null);
}

function saveTaskFromForm(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.name           = document.getElementById('task-name').value.trim() || 'Unnamed';
  task.model          = document.getElementById('task-model').value;
  task.agentId        = document.getElementById('task-agent').value || null;
  task.promptTemplate = document.getElementById('task-prompt').value;
  const schedType = document.querySelector('input[name="schedule-type"]:checked')?.value || 'manual';
  const timeByType = {
    daily:   document.getElementById('sched-daily-time')?.value,
    weekly:  document.getElementById('sched-weekly-time')?.value,
    monthly: document.getElementById('sched-monthly-time')?.value,
  };
  task.schedule = {
    type:     schedType,
    time:     timeByType[schedType] || '09:00',
    day:      parseInt(document.getElementById('sched-weekly-day')?.value ?? '1'),
    monthDay: parseInt(document.getElementById('sched-monthly-day')?.value ?? '1'),
    cron:     document.getElementById('sched-cron')?.value || '',
  };
  api('PUT', `/api/tasks/${id}`, task).catch(() => {});
  renderTaskList();
  const btn = document.getElementById('save-task-btn');
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save task'; }, 1500); }
}

function resolveTemplate(tpl) {
  const now = new Date();
  return tpl
    .replace(/\{\{date\}\}/gi, now.toLocaleDateString())
    .replace(/\{\{time\}\}/gi, now.toLocaleTimeString())
    .replace(/\{\{datetime\}\}/gi, now.toLocaleString());
}

async function runTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task || runningTaskId) return;

  const model  = task.model || state.model;
  const prompt = resolveTemplate(task.promptTemplate);
  if (!prompt.trim()) return;

  runningTaskId = id;
  renderTaskList();

  const btn = document.getElementById('run-task-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  const run = { id: uid(), startedAt: new Date().toISOString(), finishedAt: null, output: '', tokenCount: 0, error: null };

  const msgs = [];
  const agent      = agents.find(a => a.id === task.agentId);
  const toolPerms  = agent?.tools && Object.values(agent.tools).some(Boolean) ? agent.tools : null;
  const tools      = buildTools(toolPerms);
  const manifest   = buildToolManifest(toolPerms);
  const taskSysParts = [settings.agentPrePrompt?.trim(), agent?.systemPrompt?.trim(), manifest].filter(Boolean);
  if (taskSysParts.length) msgs.push({ role: 'system', content: taskSysParts.join('\n\n') });
  msgs.push({ role: 'user', content: prompt });

  const opts = agent ? { temperature: agent.temperature, top_p: agent.topP, num_ctx: agent.contextLen } : {};

  const taskAbort = new AbortController();
  const timeoutMs = (settings.timeoutHours || 0) * 3_600_000;
  const timeoutId = timeoutMs > 0 ? setTimeout(() => taskAbort.abort(), timeoutMs) : null;

  try {
    let looping = true;
    while (looping) {
      looping = false;
      const body = { model, messages: msgs, stream: true, options: opts };
      if (tools.length) body.tools = tools;
      const res = await fetch(`${await resolveOllama()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: taskAbort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let turnToolCalls = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.tool_calls?.length) turnToolCalls.push(...chunk.message.tool_calls);
            if (chunk.message?.content) run.output += chunk.message.content;
            if (chunk.done && chunk.eval_count) run.tokenCount = chunk.eval_count;
          } catch {}
        }
      }
      if (turnToolCalls.length > 0) {
        msgs.push({ role: 'assistant', content: '', tool_calls: turnToolCalls });
        for (const tc of turnToolCalls) {
          const result = await executeTool(tc.function.name, tc.function.arguments ?? {});
          msgs.push({ role: 'tool', content: String(result) });
        }
        run.output = '';
        looping = true;
      }
    }
  } catch (err) {
    run.error = err.name === 'AbortError' ? `Timed out after ${settings.timeoutHours}h` : err.message;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  run.finishedAt = new Date().toISOString();
  api('POST', `/api/tasks/${id}/runs`, run).catch(() => {});

  runningTaskId = null;
  renderTaskList();
  if (activeTaskId === id) renderTaskEditor(task);
}

function renderTaskList() {
  const list = document.getElementById('task-list');
  list.innerHTML = '';
  tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = task.id === activeTaskId ? 'active' : '';
    if (task.id === runningTaskId) li.classList.add('running');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = task.name;

    const subSpan = document.createElement('span');
    subSpan.className = 'item-sub';
    const sched = scheduleDescription(task.schedule);
    subSpan.textContent = task.id === runningTaskId
      ? 'Running…'
      : sched
        ? sched + (task.runs?.length > 0 ? ` · ${new Date(task.runs[0].startedAt).toLocaleDateString()}` : '')
        : task.runs?.length > 0
          ? `Last: ${new Date(task.runs[0].startedAt).toLocaleDateString()}`
          : 'Never run';

    li.appendChild(nameSpan);
    li.appendChild(subSpan);
    li.addEventListener('click', () => {
      activeTaskId = task.id;
      renderTaskList();
      renderTaskEditor(task);
    });
    list.appendChild(li);
  });
}

async function renderTaskEditor(task) {
  const main = document.getElementById('tasks-main');
  if (!task) {
    main.innerHTML = '<p class="empty-state">Select a task or create a new one</p>';
    return;
  }

  let runs = [];
  try { runs = await api('GET', `/api/tasks/${task.id}/runs`); } catch (_) {}

  const runsHtml = runs.length === 0
    ? '<p class="empty-state small">No runs yet</p>'
    : runs.map(run => `
        <details class="run-entry ${run.error ? 'run-error' : 'run-success'}">
          <summary>
            <span>${run.error ? '✗' : '✓'} ${new Date(run.startedAt).toLocaleString()}</span>
            ${run.tokenCount ? `<span class="run-tokens">${run.tokenCount} tokens</span>` : ''}
          </summary>
          <div class="run-output">${escHtml(run.output || run.error || '')}</div>
        </details>`).join('');

  const s = task.schedule || SCHEDULE_DEFAULT;
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  main.innerHTML = `
    <div class="editor-form">
      <div class="editor-field">
        <label>Name</label>
        <input type="text" id="task-name" value="${escHtml(task.name)}">
      </div>
      <div class="editor-field">
        <label>Agent <span class="label-hint">(optional — overrides model &amp; system prompt)</span></label>
        <select id="task-agent">
          <option value="">No agent</option>
          ${agents.map(a => `<option value="${a.id}"${a.id === task.agentId ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('')}
        </select>
      </div>
      <div class="editor-field">
        <label>Model</label>
        <select id="task-model">
          ${models.map(m => `<option value="${escHtml(m)}"${m === task.model ? ' selected' : ''}>${escHtml(m)}</option>`).join('')}
        </select>
      </div>

      <div class="editor-field">
        <div class="field-header">
          <label for="task-prompt">Prompt template</label>
          <div class="var-chips">
            <button type="button" class="var-chip" data-var="{{date}}" title="Resolves to today's date">{{date}}</button>
            <button type="button" class="var-chip" data-var="{{time}}" title="Resolves to current time">{{time}}</button>
            <button type="button" class="var-chip" data-var="{{datetime}}" title="Resolves to date and time">{{datetime}}</button>
          </div>
        </div>
        <textarea id="task-prompt" rows="7" placeholder="Enter prompt...">${escHtml(task.promptTemplate)}</textarea>
      </div>

      <div class="editor-field">
        <label>Schedule</label>
        <div class="schedule-options">
          <label class="schedule-row">
            <input type="radio" name="schedule-type" value="manual" ${s.type === 'manual' ? 'checked' : ''}>
            <span>Manual only</span>
          </label>
          <label class="schedule-row">
            <input type="radio" name="schedule-type" value="daily" ${s.type === 'daily' ? 'checked' : ''}>
            <span>Every day at</span>
            <input type="time" id="sched-daily-time" value="${s.type === 'daily' ? s.time : '09:00'}" ${s.type !== 'daily' ? 'disabled' : ''}>
          </label>
          <label class="schedule-row">
            <input type="radio" name="schedule-type" value="weekly" ${s.type === 'weekly' ? 'checked' : ''}>
            <span>Every</span>
            <select id="sched-weekly-day" ${s.type !== 'weekly' ? 'disabled' : ''}>
              ${DAYS.map((d, i) => `<option value="${i}" ${s.day === i ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
            <span>at</span>
            <input type="time" id="sched-weekly-time" value="${s.type === 'weekly' ? s.time : '09:00'}" ${s.type !== 'weekly' ? 'disabled' : ''}>
          </label>
          <label class="schedule-row">
            <input type="radio" name="schedule-type" value="monthly" ${s.type === 'monthly' ? 'checked' : ''}>
            <span>Every month on day</span>
            <input type="number" id="sched-monthly-day" min="1" max="31" value="${s.monthDay || 1}" style="width:56px" ${s.type !== 'monthly' ? 'disabled' : ''}>
            <span>at</span>
            <input type="time" id="sched-monthly-time" value="${s.type === 'monthly' ? s.time : '09:00'}" ${s.type !== 'monthly' ? 'disabled' : ''}>
          </label>
          <label class="schedule-row">
            <input type="radio" name="schedule-type" value="custom" ${s.type === 'custom' ? 'checked' : ''}>
            <span>Custom cron</span>
            <input type="text" id="sched-cron" value="${escHtml(s.cron)}" placeholder="0 9 * * 1" ${s.type !== 'custom' ? 'disabled' : ''}>
          </label>
        </div>
        <p class="field-note">Auto-run requires a backend runner — manual "Run now" always works</p>
      </div>

      <div class="editor-actions">
        <button id="delete-task-btn" class="btn-danger">Delete</button>
        <button id="save-task-btn">Save task</button>
        <button id="run-task-btn" class="btn-primary"${runningTaskId ? ' disabled' : ''}>▶ Run now</button>
      </div>
    </div>
    <div class="run-log">
      <h3>Run log</h3>
      ${runsHtml}
    </div>`;

  document.getElementById('save-task-btn').addEventListener('click', () => saveTaskFromForm(task.id));
  document.getElementById('delete-task-btn').addEventListener('click', () => deleteTask(task.id));
  document.getElementById('run-task-btn').addEventListener('click', () => {
    saveTaskFromForm(task.id);
    runTask(task.id);
  });

  // Enable/disable sub-inputs when schedule type changes
  document.querySelectorAll('input[name="schedule-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const t = radio.value;
      const map = {
        'sched-daily-time':    t === 'daily',
        'sched-weekly-day':    t === 'weekly',
        'sched-weekly-time':   t === 'weekly',
        'sched-monthly-day':   t === 'monthly',
        'sched-monthly-time':  t === 'monthly',
        'sched-cron':          t === 'custom',
      };
      Object.entries(map).forEach(([id, enabled]) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
      });
    });
  });

  // Insert template variable at cursor
  document.querySelectorAll('.var-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const variable = chip.dataset.var;
      const ta = document.getElementById('task-prompt');
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + variable + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + variable.length;
      ta.focus();
    });
  });
}

document.getElementById('new-task-btn').addEventListener('click', createTask);

// ── Chat — persistence ────────────────────────────────────────────────────────
function save() {
  const thread = activeThread();
  if (!thread) return;
  api('PUT', `/api/threads/${thread.id}`, {
    name: thread.name, model: state.model,
    agentId: state.selectedAgentId,
    systemPrompt: systemPrompt.value,
  }).catch(() => {});
}

async function load() {
  try {
    const threads = await api('GET', '/api/threads');
    state.threads = threads;
  } catch (_) {}
  if (!Array.isArray(state.threads)) state.threads = [];
  if (state.threads.length && !state.activeId) state.activeId = state.threads[0].id;
}

// ── Chat — models ─────────────────────────────────────────────────────────────
async function fetchModels() {
  try {
    const res  = await fetch(`${await resolveOllama()}/api/tags`);
    const data = await res.json();
    models = (data.models || []).map(m => m.name);
    modelSelect.innerHTML = models.length
      ? models.map(n => `<option value="${n}">${n}</option>`).join('')
      : '<option value="">No models found</option>';
    if (state.model && models.includes(state.model)) {
      modelSelect.value = state.model;
    } else {
      state.model = models[0] || '';
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Could not reach Ollama</option>';
  }
}

// ── Chat — threads ────────────────────────────────────────────────────────────
function activeThread() {
  return state.threads.find(t => t.id === state.activeId) || null;
}

async function createThread() {
  const agentId = settings.defaultAgentId || null;
  const agent   = agentId ? agents.find(a => a.id === agentId) : null;
  const model   = agent ? agent.model : state.model;
  const t = { id: uid(), name: 'New chat', model, agentId, systemPrompt: '', messages: [] };
  state.threads.unshift(t);
  state.activeId        = t.id;
  state.selectedAgentId = agentId;
  state.model           = model;
  agentSelect.value     = agentId || '';
  modelSelect.value     = model;
  systemPrompt.value    = '';
  await api('POST', '/api/threads', t).catch(() => {});
  renderSidebar();
  renderChat();
}

function switchThread(id) {
  state.activeId = id;
  const t = activeThread();
  if (t?.systemPrompt !== undefined) systemPrompt.value = t.systemPrompt || '';
  renderSidebar();
  renderChat();
}

async function deleteThread(id) {
  state.threads = state.threads.filter(t => t.id !== id);
  if (state.activeId === id) state.activeId = state.threads[0]?.id || null;
  api('DELETE', `/api/threads/${id}`).catch(() => {});
  if (state.threads.length === 0) createThread();
  else { renderSidebar(); renderChat(); }
}

function renderSidebar() {
  threadList.innerHTML = '';
  state.threads.filter(t => t.name !== '__brain__').forEach(t => {
    const li  = document.createElement('li');
    li.className   = t.id === state.activeId ? 'active' : '';
    li.title       = t.name;
    li.textContent = t.name;

    const del = document.createElement('button');
    del.className   = 'thread-delete';
    del.textContent = '×';
    del.title       = 'Delete';
    del.addEventListener('click', e => { e.stopPropagation(); deleteThread(t.id); });

    li.appendChild(del);
    li.addEventListener('click', () => switchThread(t.id));
    threadList.appendChild(li);
  });
}

// ── Chat — rendering ──────────────────────────────────────────────────────────
function renderChat() {
  chatWindow.innerHTML = '';
  const t = activeThread();
  if (!t) return;
  t.messages.filter(m => m.role !== 'system').forEach(m => {
    addBubble(m.role, m.content, m.meta, m.thinking);
  });
}

function addBubble(role, content, meta = null, thinking = null) {
  const wrap   = document.createElement('div');
  wrap.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (role === 'assistant') {
    if (thinking && settings.showThinking) bubble.appendChild(buildThinkingBlock(thinking, true));
    const rd = document.createElement('div');
    rd.className = 'response-content';
    applyMarkdown(rd, content);
    bubble.appendChild(rd);
  } else {
    bubble.textContent = content;
  }

  wrap.appendChild(bubble);
  wrap.appendChild(buildMeta(role, content, meta));
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}

function buildMeta(role, content, meta) {
  const row = document.createElement('div');
  row.className = 'message-meta';

  if (role === 'assistant') {
    const btn = document.createElement('button');
    btn.className   = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    row.appendChild(btn);

    if (meta && settings.showTokenStats) {
      const span  = document.createElement('span');
      const parts = [];
      if (meta.eval_count)    parts.push(`${meta.eval_count} tokens`);
      if (meta.elapsed != null) parts.push(`${(meta.elapsed / 1000).toFixed(1)}s`);
      if (meta.eval_count && meta.eval_duration) {
        parts.push(`${Math.round(meta.eval_count / (meta.eval_duration / 1e9))} t/s`);
      }
      span.textContent = parts.join(' · ');
      row.appendChild(span);
    }
  }
  return row;
}

function applyMarkdown(el, text) {
  el.innerHTML = marked.parse(text);
  el.querySelectorAll('pre code').forEach(block => Prism.highlightElement(block));
}

function parseRaw(raw) {
  const m = raw.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
  if (m) return { thinking: m[1].trim(), response: m[2].trimStart() };
  if (raw.startsWith('<think>')) return { thinking: raw.slice(7), response: '' };
  return { thinking: null, response: raw };
}

function buildThinkingBlock(text, collapsed = false) {
  const details  = document.createElement('details');
  details.className = 'thinking-block';
  if (!collapsed) details.open = true;
  const summary  = document.createElement('summary');
  summary.textContent = collapsed ? 'Reasoning' : 'Thinking…';
  const body     = document.createElement('div');
  body.className = 'thinking-content';
  body.textContent = text;
  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

function updateStreamBubble(bubble, responseDiv, raw) {
  const parsed = parseRaw(raw);
  if (parsed.thinking !== null) {
    let tb = bubble.querySelector('.thinking-block');
    if (!tb && settings.showThinking) {
      tb = buildThinkingBlock('', false);
      bubble.insertBefore(tb, responseDiv);
    }
    if (tb) tb.querySelector('.thinking-content').textContent = parsed.thinking;
  }
  responseDiv.textContent = parsed.response || '';
}

// ── Tool system ───────────────────────────────────────────────────────────────

const TOOL_DEFS = {
  read_file:   { type:'function', function:{ name:'read_file',   description:'Read the contents of a file', parameters:{ type:'object', properties:{ path:{ type:'string', description:'File path relative to code root' }}, required:['path'] }}},
  write_file:  { type:'function', function:{ name:'write_file',  description:'Write/overwrite a file', parameters:{ type:'object', properties:{ path:{ type:'string' }, content:{ type:'string', description:'Content to write' }}, required:['path','content'] }}},
  list_dir:    { type:'function', function:{ name:'list_dir',    description:'List directory contents', parameters:{ type:'object', properties:{ path:{ type:'string', description:'Directory path (empty = root)' }}, required:[] }}},
  web_search:  { type:'function', function:{ name:'web_search',  description:'Search the web with DuckDuckGo', parameters:{ type:'object', properties:{ query:{ type:'string' }}, required:['query'] }}},
  web_fetch:   { type:'function', function:{ name:'web_fetch',   description:'Fetch and return the text content of a URL', parameters:{ type:'object', properties:{ url:{ type:'string' }}, required:['url'] }}},
  edit_file:   { type:'function', function:{ name:'edit_file',   description:'Replace an exact string in a file. old_string must occur exactly once (or set replace_all)', parameters:{ type:'object', properties:{ path:{ type:'string' }, old_string:{ type:'string' }, new_string:{ type:'string' }, replace_all:{ type:'boolean' }}, required:['path','old_string','new_string'] }}},
  search_files:{ type:'function', function:{ name:'search_files',description:'Search file contents recursively (regex or literal). Returns file, line, matching text', parameters:{ type:'object', properties:{ pattern:{ type:'string' }, path:{ type:'string' }}, required:['pattern'] }}},
  http_request:{ type:'function', function:{ name:'http_request',description:'Make an HTTP request (any method/headers/body), works against localhost — use to test APIs', parameters:{ type:'object', properties:{ url:{ type:'string' }, method:{ type:'string' }, headers:{ type:'object' }, body:{ type:'string' }}, required:['url'] }}},
  run_command: { type:'function', function:{ name:'run_command', description:'Run a bash command; returns exit code, stdout, stderr (timeout max 120s)', parameters:{ type:'object', properties:{ command:{ type:'string' }, cwd:{ type:'string' }, timeout:{ type:'integer' }}, required:['command'] }}},
  browser_navigate:  { type:'function', function:{ name:'browser_navigate',  description:'Open a URL in headless Chromium; returns title, text, numbered interactive elements', parameters:{ type:'object', properties:{ url:{ type:'string' }}, required:['url'] }}},
  browser_snapshot:  { type:'function', function:{ name:'browser_snapshot',  description:'Re-read the current browser page (title, text, numbered elements)', parameters:{ type:'object', properties:{}, required:[] }}},
  browser_click:     { type:'function', function:{ name:'browser_click',     description:'Click an element by ref number from the latest snapshot', parameters:{ type:'object', properties:{ ref:{ type:'integer' }}, required:['ref'] }}},
  browser_type:      { type:'function', function:{ name:'browser_type',      description:'Type into an input by ref number; submit=true presses Enter', parameters:{ type:'object', properties:{ ref:{ type:'integer' }, text:{ type:'string' }, submit:{ type:'boolean' }}, required:['ref','text'] }}},
  browser_console:   { type:'function', function:{ name:'browser_console',   description:'Recent browser console messages and page errors', parameters:{ type:'object', properties:{}, required:[] }}},
  browser_screenshot:{ type:'function', function:{ name:'browser_screenshot',description:'Save a PNG screenshot of the current page', parameters:{ type:'object', properties:{ path:{ type:'string' }, full_page:{ type:'boolean' }}, required:[] }}},
};

// Tools executed server-side via /api/tools/exec (shared with the pipeline worker)
const SERVER_TOOLS = new Set(['edit_file','search_files','http_request','run_command',
  'browser_navigate','browser_snapshot','browser_click','browser_type','browser_console','browser_screenshot']);

function buildTools(toolPerms) {
  if (!toolPerms) return [];
  const out = [];
  if (toolPerms.files) out.push(TOOL_DEFS.read_file, TOOL_DEFS.write_file, TOOL_DEFS.edit_file, TOOL_DEFS.list_dir, TOOL_DEFS.search_files);
  if (toolPerms.web)   out.push(TOOL_DEFS.web_search, TOOL_DEFS.web_fetch, TOOL_DEFS.http_request);
  if (toolPerms.shell) out.push(TOOL_DEFS.run_command);
  if (toolPerms.browser) out.push(TOOL_DEFS.browser_navigate, TOOL_DEFS.browser_snapshot, TOOL_DEFS.browser_click,
                                  TOOL_DEFS.browser_type, TOOL_DEFS.browser_console, TOOL_DEFS.browser_screenshot);
  return out;
}

function buildToolManifest(toolPerms) {
  if (!toolPerms || !Object.values(toolPerms).some(Boolean)) return '';
  const lines = [
    '## Tools available',
    'If you need to call a tool, use an action block:',
    '```action', '{"tool":"TOOL_NAME","params":{...}}', '```',
  ];
  if (toolPerms.files) {
    lines.push('- **read_file** `{"path":"<rel-path>"}` — read a file');
    lines.push('- **write_file** `{"path":"<rel-path>","content":"<text>"}` — write a file');
    lines.push('- **edit_file** `{"path":"<rel-path>","old_string":"<exact>","new_string":"<text>"}` — replace an exact string once');
    lines.push('- **list_dir** `{"path":"<rel-path>"}` — list directory');
    lines.push('- **search_files** `{"pattern":"<regex>","path":"<dir>"}` — search file contents recursively');
  }
  if (toolPerms.web) {
    lines.push('- **web_search** `{"query":"<terms>"}` — search the web');
    lines.push('- **web_fetch** `{"url":"<url>"}` — fetch a URL');
    lines.push('- **http_request** `{"url":"<url>","method":"POST","body":"<json>"}` — call an API (localhost allowed)');
  }
  if (toolPerms.shell) {
    lines.push('- **run_command** `{"command":"<bash>"}` — run a shell command, returns exit code + output');
  }
  if (toolPerms.browser) {
    lines.push('- **browser_navigate** `{"url":"<url>"}` — open a page in headless Chromium, returns text + numbered elements');
    lines.push('- **browser_click** `{"ref":<n>}` / **browser_type** `{"ref":<n>,"text":"<text>","submit":true}` — interact via element refs');
    lines.push('- **browser_snapshot** `{}` / **browser_console** `{}` / **browser_screenshot** `{"path":"<file.png>"}`');
  }
  return lines.join('\n');
}

async function executeTool(name, params) {
  try {
    switch (name) {
      case 'read_file': {
        const r = await api('GET', `/api/fs/read?path=${encodeURIComponent(params.path || '')}`);
        if (r.error) return `Error: ${r.error}`;
        // Refresh editor if this file is open
        if (codeSession?.activeFile === params.path) refreshMonacoContent(r.content);
        return r.content ?? '';
      }
      case 'write_file': {
        const r = await api('POST', '/api/fs/write', { path: params.path, content: params.content ?? '' });
        if (r.error) return `Error: ${r.error}`;
        if (codeSession?.openFiles?.includes(params.path)) refreshMonacoContent(params.content);
        if (codeSession?.activeFile === params.path) refreshMonacoContent(params.content ?? '');
        renderFileTree();
        return `Written: ${params.path}`;
      }
      case 'list_dir': {
        const r = await api('GET', `/api/fs?path=${encodeURIComponent(params.path || '')}`);
        if (r.error) return `Error: ${r.error}`;
        return (r.entries || []).map(e => `${e.type === 'dir' ? '[dir]' : '[file]'} ${e.name}`).join('\n') || '(empty)';
      }
      case 'web_search': {
        const r = await api('GET', `/api/web/search?q=${encodeURIComponent(params.query || '')}`);
        return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
      }
      case 'web_fetch': {
        const r = await api('GET', `/api/web/fetch?url=${encodeURIComponent(params.url || '')}`);
        return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
      }
      default: {
        if (SERVER_TOOLS.has(name)) {
          const r = await api('POST', '/api/tools/exec', { name, args: params || {} });
          if (name === 'edit_file') renderFileTree();
          return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
        }
        return `Unknown tool: ${name}`;
      }
    }
  } catch (e) {
    return `Tool error: ${e.message}`;
  }
}

function renderToolCallBubble(chatWin, toolCalls) {
  const wrap = document.createElement('div');
  wrap.className = 'message tool-calls';
  wrap.innerHTML = toolCalls.map(tc =>
    `<div class="tool-call-chip">🔧 <b>${escHtml(tc.function.name)}</b> ${escHtml(JSON.stringify(tc.function.arguments ?? tc.function.parameters ?? {}))}</div>`
  ).join('');
  chatWin.appendChild(wrap);
  chatWin.scrollTop = chatWin.scrollHeight;
  return wrap;
}

function renderToolResultBubble(chatWin, name, result) {
  const wrap = document.createElement('div');
  wrap.className = 'message tool-result';
  wrap.innerHTML = `<div class="tool-result-chip"><span class="tool-result-label">✓ ${escHtml(name)}</span><pre class="tool-result-body">${escHtml(String(result).slice(0, 1000))}${String(result).length > 1000 ? '\n…' : ''}</pre></div>`;
  chatWin.appendChild(wrap);
  chatWin.scrollTop = chatWin.scrollHeight;
}

// ── Chat — send / stream ──────────────────────────────────────────────────────
async function send() {
  const text = userInput.value.trim();
  if (!text || !state.model) return;

  const thread = activeThread();
  if (!thread) return;

  const isFirstMsg = !thread.messages.some(m => m.role === 'user');
  if (isFirstMsg) {
    thread.name = text.length > 42 ? text.slice(0, 42) + '…' : text;
    renderSidebar();
  }

  const sysText = systemPrompt.value.trim();
  const agent   = state.selectedAgentId ? agents.find(a => a.id === state.selectedAgentId) : null;
  const options = agent ? { temperature: agent.temperature, top_p: agent.topP, num_ctx: agent.contextLen } : {};

  const toolPerms = agent?.tools && Object.values(agent.tools).some(Boolean) ? agent.tools : null;
  const tools     = buildTools(toolPerms);
  const manifest  = buildToolManifest(toolPerms);

  const apiMessages = [];
  const sysParts = [
    settings.chatPrePrompt?.trim(),
    agent ? settings.agentPrePrompt?.trim() : '',
    sysText,
    manifest,
  ].filter(Boolean);
  if (sysParts.length) apiMessages.push({ role: 'system', content: sysParts.join('\n\n') });
  apiMessages.push(...thread.messages.filter(m => m.role !== 'system'));
  apiMessages.push({ role: 'user', content: text });

  const userMsgId = uid();
  thread.messages.push({ id: userMsgId, role: 'user', content: text });
  api('POST', `/api/threads/${thread.id}/messages`, { id: userMsgId, role: 'user', content: text }).catch(() => {});
  if (isFirstMsg) save(); // persist updated thread name

  userInput.value = '';
  userInput.style.height = 'auto';
  isGenerating      = true;
  sendBtn.disabled  = true;
  abandonBtn.hidden = false;

  addBubble('user', text);

  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const responseDiv = document.createElement('div');
  responseDiv.className = 'response-content';
  responseDiv.textContent = '…';
  bubble.appendChild(responseDiv);
  wrap.appendChild(bubble);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  abortController = new AbortController();
  const timeoutMs = (settings.timeoutHours || 0) * 3_600_000;
  const timeoutId = timeoutMs > 0 ? setTimeout(() => abortController.abort(), timeoutMs) : null;
  const t0 = Date.now();
  let full           = '';
  let streamThinking = '';
  let doneMeta       = null;
  let stopped        = false;

  try {
    // Tool-call loop: keep sending until model responds with text instead of tool calls
    let looping = true;
    while (looping) {
      looping = false;
      const body = { model: state.model, messages: apiMessages, stream: true, options };
      if (tools.length) body.tools = tools;

      const res = await fetch(`${await resolveOllama()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let turnToolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.tool_calls?.length) {
              turnToolCalls.push(...chunk.message.tool_calls);
            }
            if (chunk.message?.thinking) {
              streamThinking += chunk.message.thinking;
              if (settings.showThinking) {
                let tb = bubble.querySelector('.thinking-block');
                if (!tb) {
                  tb = buildThinkingBlock('', false);
                  bubble.insertBefore(tb, responseDiv);
                }
                tb.querySelector('.thinking-content').textContent = streamThinking;
                responseDiv.textContent = '';
              }
              chatWindow.scrollTop = chatWindow.scrollHeight;
            }
            if (chunk.message?.content) {
              full += chunk.message.content;
              if (streamThinking) responseDiv.textContent = full;
              else updateStreamBubble(bubble, responseDiv, full);
              chatWindow.scrollTop = chatWindow.scrollHeight;
            }
            if (chunk.done) doneMeta = { ...chunk, elapsed: Date.now() - t0 };
          } catch {}
        }
      }

      // Handle native tool calls
      if (turnToolCalls.length > 0) {
        renderToolCallBubble(chatWindow, turnToolCalls);
        apiMessages.push({ role: 'assistant', content: '', tool_calls: turnToolCalls });
        for (const tc of turnToolCalls) {
          const result = await executeTool(tc.function.name, tc.function.arguments ?? {});
          renderToolResultBubble(chatWindow, tc.function.name, result);
          apiMessages.push({ role: 'tool', content: String(result) });
        }
        full = ''; streamThinking = ''; doneMeta = null;
        responseDiv.textContent = '…';
        looping = true;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') stopped = true;
    else responseDiv.textContent = `Error: ${err.message}`;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const parsed = streamThinking
    ? { thinking: streamThinking, response: full }
    : parseRaw(full);

  const tb = bubble.querySelector('.thinking-block');
  if (tb) {
    tb.open = false;
    tb.querySelector('summary').textContent = 'Reasoning';
    tb.querySelector('.thinking-content').textContent = parsed.thinking || '';
  }

  const finalResponse = (parsed.response || '') + (stopped ? '\n\n*(stopped)*' : '');
  applyMarkdown(responseDiv, finalResponse);
  wrap.appendChild(buildMeta('assistant', parsed.response || '', doneMeta));

  const asstMsg = { id: uid(), role: 'assistant', content: parsed.response || '', thinking: parsed.thinking, meta: doneMeta };
  thread.messages.push(asstMsg);
  api('POST', `/api/threads/${thread.id}/messages`, {
    id: asstMsg.id, role: 'assistant', content: asstMsg.content,
    thinking: asstMsg.thinking,
    tokens: doneMeta?.eval_count, evalDuration: doneMeta?.eval_duration,
  }).catch(() => {});

  isGenerating      = false;
  abortController   = null;
  sendBtn.disabled  = false;
  abandonBtn.hidden = true;
  userInput.focus();
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// ── Chat — events ─────────────────────────────────────────────────────────────
newChatBtn.addEventListener('click', createThread);

modelSelect.addEventListener('change', () => {
  state.model = modelSelect.value;
  save(); // persists model to current thread
});

clearBtn.addEventListener('click', () => {
  const t = activeThread();
  if (!t) return;
  t.messages = [];
  t.name     = 'New chat';
  api('DELETE', `/api/threads/${t.id}/messages`).catch(() => {});
  renderSidebar();
  renderChat();
});

sendBtn.addEventListener('click', send);
abandonBtn.addEventListener('click', () => abortController?.abort());

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
});

document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    userInput.focus();
  }
});

// ── Plans ─────────────────────────────────────────────────────────────────────

let plans          = [];
let activePlanName = null;
let planHistory    = [];
let planAbort      = null;
let planBusy       = false;
let planPreviewMode = false;

async function loadPlanList() {
  try {
    const r = await fetch('/api/plans');
    if (r.ok) plans = (await r.json()).filter(name => !name.startsWith('.'));
    else plans = [];
  } catch (_) { plans = []; }
}

async function fetchPlanContent(name) {
  try {
    const r = await fetch(`/api/plans/${encodeURIComponent(name)}`);
    return r.ok ? await r.text() : '';
  } catch (_) { return ''; }
}

async function writePlan(name, content) {
  return fetch(`/api/plans/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  }).catch(() => {});
}

async function deletePlanFile(name) {
  await fetch(`/api/plans/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
}

async function createPlan() {
  const date = new Date().toISOString().slice(0, 10);
  let name = `Plan ${date}.md`;
  let n = 2;
  while (plans.includes(name)) name = `Plan ${date} ${n++}.md`;
  await writePlan(name, '');
  await loadPlanList();
  renderPlanList();
  openPlan(name);
}

async function openPlan(name) {
  activePlanName = name;
  planHistory = [];
  const content = await fetchPlanContent(name);
  renderPlanList();
  renderPlanEditor(name, content);
}

function renderPlanList() {
  const list = document.getElementById('plan-list');
  if (!list) return;
  if (plans.length === 0) {
    list.innerHTML = '<li class="sidebar-empty">No plans yet</li>';
    return;
  }
  list.innerHTML = plans.map(name => `
    <li class="sidebar-item${name === activePlanName ? ' active' : ''}" data-name="${escHtml(name)}">
      ${escHtml(name.replace(/\.md$/, ''))}
    </li>
  `).join('');
  list.querySelectorAll('.sidebar-item').forEach(li =>
    li.addEventListener('click', () => openPlan(li.dataset.name))
  );
}

const PLAN_PROMPTS = {
  editor: {
    label: 'Plan editor (default)',
    text:  'You are a plan editor. The user will give you instructions to modify, restructure, or extend the plan. Respond with ONLY the complete updated plan — no preamble, no explanation, no code fences. Your entire response replaces the current plan.',
  },
  drafter: {
    label: 'Draft from scratch',
    text:  'You are a planning assistant. The user will describe what they need and you will write a clear, structured plan. Respond with ONLY the plan content. Your response becomes the plan.',
  },
  critic: {
    label: 'Critic & improve',
    text:  'You are a critical planning assistant. Find weaknesses or gaps in the plan and rewrite it to address them. Respond with ONLY the improved plan — no commentary. Your response replaces the current plan.',
  },
  custom: {
    label: 'Custom',
    text:  '',
  },
};

const PLAN_FORMAT_BUTTONS = [
  { md: 'bold',     label: '<b>B</b>',    title: 'Bold' },
  { md: 'italic',   label: '<i>I</i>',    title: 'Italic' },
  { md: 'code',     label: '&lt;/&gt;',   title: 'Inline code' },
  { md: 'ul',       label: '≡',      title: 'Bullet list' },
  { md: 'ol',       label: '1.',          title: 'Numbered list' },
  { md: 'quote',    label: '”',      title: 'Quote' },
];

const PLAN_FORMAT_BLOCKS = [
  { md: 'codeblock', label: 'Code block' },
  { md: 'link',      label: 'Link' },
  { md: 'hr',        label: 'Divider' },
];

function renderPlanEditor(name, content) {
  const main = document.getElementById('plans-main');
  planPreviewMode = false;
  const presetOptions = Object.entries(PLAN_PROMPTS)
    .map(([k, v]) => `<option value="${k}">${escHtml(v.label)}</option>`).join('');

  const formatButtons = PLAN_FORMAT_BUTTONS
    .map(b => `<button type="button" class="pft-btn" data-md="${b.md}" title="${escHtml(b.title)}">${b.label}</button>`)
    .join('');
  const formatBlocks = PLAN_FORMAT_BLOCKS
    .map(b => `<button type="button" class="pft-btn pft-btn-wide" data-md="${b.md}">${escHtml(b.label)}</button>`)
    .join('');

  main.innerHTML = `
    <div class="plans-toolbar">
      <input type="text" id="plan-title" class="plan-title-input" value="${escHtml(name.replace(/\.md$/, ''))}">
      <select id="plan-model">
        ${models.map(m => `<option value="${escHtml(m)}"${m === state.model ? ' selected' : ''}>${escHtml(m)}</option>`).join('')}
      </select>
      <button id="plan-preview-toggle" class="plan-preview-toggle">Preview</button>
      <button id="delete-plan-btn" class="btn-danger">Delete</button>
      <button id="save-plan-btn">Save</button>
    </div>
    <div class="plans-body">
      <div class="plans-editor-col">
        <textarea id="plan-textarea" placeholder="Start writing your plan...">${escHtml(content)}</textarea>
        <div id="plan-preview" class="plan-preview" hidden></div>
      </div>
      <div class="plan-format-toolbar">
        <div class="pft-group">
          <label class="pft-label">Style</label>
          <select id="plan-heading-select" title="Text style">
            <option value="h0">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
          </select>
        </div>
        <div class="pft-group pft-row">${formatButtons}</div>
        <div class="pft-group">${formatBlocks}</div>
      </div>
    </div>
    <div class="plan-chat-panel">
      <details class="plan-prompt-details">
        <summary class="plan-prompt-summary">
          <span>AI mode:</span>
          <select id="plan-prompt-preset" onclick="event.stopPropagation()">${presetOptions}</select>
        </summary>
        <textarea id="plan-system-prompt" class="plan-system-prompt-ta" rows="3">${escHtml(PLAN_PROMPTS.editor.text)}</textarea>
      </details>
      <div id="plan-chat-window"></div>
      <div class="plan-input-area">
        <textarea id="plan-user-input" placeholder="Instruct the AI to edit the plan… (Enter to send)" rows="2"></textarea>
        <div class="plan-input-actions">
          <button id="plan-abandon-btn" hidden>Abandon</button>
          <button id="plan-send-btn">Send</button>
          <button id="plan-execute-btn" class="btn-motion">▶ Execute plan</button>
        </div>
      </div>
    </div>`;

  // Preset selector fills the system prompt textarea
  document.getElementById('plan-prompt-preset').addEventListener('change', e => {
    const prompt = PLAN_PROMPTS[e.target.value];
    document.getElementById('plan-system-prompt').value = prompt?.text ?? '';
  });

  document.getElementById('plan-preview-toggle').addEventListener('click', () => setPlanPreviewMode(!planPreviewMode));

  document.querySelectorAll('.plan-format-toolbar .pft-btn').forEach(btn =>
    btn.addEventListener('click', () => applyPlanFormat(btn.dataset.md))
  );
  document.getElementById('plan-heading-select').addEventListener('change', e => {
    applyPlanFormat(e.target.value);
    e.target.value = 'h0';
  });

  document.getElementById('save-plan-btn').addEventListener('click', async () => {
    const title   = document.getElementById('plan-title').value.trim() || 'untitled';
    const newName = title.endsWith('.md') ? title : `${title}.md`;
    const text    = document.getElementById('plan-textarea').value;
    if (newName !== activePlanName) {
      await deletePlanFile(activePlanName);
      activePlanName = newName;
    }
    await writePlan(activePlanName, text);
    await loadPlanList();
    renderPlanList();
    const btn = document.getElementById('save-plan-btn');
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 1500); }
  });

  document.getElementById('delete-plan-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${activePlanName}"?`)) return;
    await deletePlanFile(activePlanName);
    activePlanName = null;
    planHistory    = [];
    await loadPlanList();
    renderPlanList();
    main.innerHTML = '<p class="empty-state">Select a plan or create a new one</p>';
  });

  const sendBtn    = document.getElementById('plan-send-btn');
  const abandonBtn = document.getElementById('plan-abandon-btn');
  const input      = document.getElementById('plan-user-input');

  sendBtn.addEventListener('click', sendPlanMessage);
  document.getElementById('plan-execute-btn').addEventListener('click', setPlanInMotion);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPlanMessage(); }
  });
  abandonBtn.addEventListener('click', () => { if (planAbort) planAbort.abort(); });
}

function setPlanPreviewMode(on) {
  planPreviewMode = on;
  const ta      = document.getElementById('plan-textarea');
  const preview = document.getElementById('plan-preview');
  const toggle  = document.getElementById('plan-preview-toggle');
  const toolbar = document.querySelector('.plan-format-toolbar');
  if (!ta || !preview) return;
  if (on) {
    preview.innerHTML = marked.parse(ta.value || '');
    ta.hidden = true;
    preview.hidden = false;
    toggle?.classList.add('active');
    if (toggle) toggle.textContent = 'Edit';
    toolbar?.classList.add('pft-disabled');
  } else {
    ta.hidden = false;
    preview.hidden = true;
    toggle?.classList.remove('active');
    if (toggle) toggle.textContent = 'Preview';
    toolbar?.classList.remove('pft-disabled');
    ta.focus();
  }
}

function applyPlanFormat(action) {
  if (planPreviewMode) setPlanPreviewMode(false);
  const ta = document.getElementById('plan-textarea');
  if (!ta) return;

  const value = ta.value;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const selected = value.slice(start, end);

  const wrapSelection = (before, after, placeholder) => {
    const inner = selected || placeholder;
    ta.setRangeText(before + inner + after, start, end, selected ? 'end' : 'select');
    if (!selected) {
      ta.selectionStart = start + before.length;
      ta.selectionEnd   = start + before.length + placeholder.length;
    }
  };

  const currentLineRange = () => {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    return [lineStart, lineEnd];
  };

  const prefixLines = prefix => {
    const [lineStart, lineEnd] = currentLineRange();
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const already = lines.every(l => l.startsWith(prefix));
    const out = already ? lines.map(l => l.slice(prefix.length)) : lines.map(l => prefix + l);
    ta.setRangeText(out.join('\n'), lineStart, lineEnd, 'end');
  };

  const insertBlock = text => {
    const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    ta.setRangeText(before + text, start, end, 'end');
  };

  switch (action) {
    case 'bold':      wrapSelection('**', '**', 'bold text'); break;
    case 'italic':    wrapSelection('_', '_', 'italic text'); break;
    case 'code':      wrapSelection('`', '`', 'code'); break;
    case 'quote':     prefixLines('> '); break;
    case 'ul':        prefixLines('- '); break;
    case 'ol': {
      const [lineStart, lineEnd] = currentLineRange();
      const lines = value.slice(lineStart, lineEnd).split('\n');
      ta.setRangeText(lines.map((l, i) => `${i + 1}. ${l}`).join('\n'), lineStart, lineEnd, 'end');
      break;
    }
    case 'codeblock': insertBlock(`\`\`\`\n${selected || 'code'}\n\`\`\`\n`); break;
    case 'link':      wrapSelection('[', '](url)', 'link text'); break;
    case 'hr':         insertBlock('\n---\n'); break;
    case 'h0': case 'h1': case 'h2': case 'h3': {
      const level = Number(action.slice(1));
      const [lineStart, lineEnd] = currentLineRange();
      const stripped = value.slice(lineStart, lineEnd).replace(/^#{1,6}\s*/, '');
      ta.setRangeText((level ? '#'.repeat(level) + ' ' : '') + stripped, lineStart, lineEnd, 'end');
      break;
    }
  }
  ta.focus();
}

function addPlanUserBubble(text) {
  const win = document.getElementById('plan-chat-window');
  if (!win) return;
  const div = document.createElement('div');
  div.className = 'plan-message user';
  div.innerHTML = `<div class="plan-bubble">${escHtml(text)}</div>`;
  win.appendChild(div);
  win.scrollTop = win.scrollHeight;
}

function addPlanStatus(text, isError = false) {
  const win = document.getElementById('plan-chat-window');
  if (!win) return;
  const div = document.createElement('div');
  div.className = `plan-status${isError ? ' plan-status-error' : ''}`;
  div.textContent = text;
  win.appendChild(div);
  win.scrollTop = win.scrollHeight;
  return div;
}

async function sendPlanMessage() {
  if (planBusy) return;
  const input = document.getElementById('plan-user-input');
  const text  = input?.value.trim();
  if (!text) return;
  input.value = '';

  const model       = document.getElementById('plan-model')?.value || models[0] || '';
  const planContent = document.getElementById('plan-textarea')?.value || '';
  const basePrompt  = document.getElementById('plan-system-prompt')?.value || PLAN_PROMPTS.editor.text;
  const systemPrompt = buildPlanSystemPrompt(basePrompt, planContent);

  addPlanUserBubble(text);
  planHistory.push({ role: 'user', content: text });

  const sendBtn    = document.getElementById('plan-send-btn');
  const abandonBtn = document.getElementById('plan-abandon-btn');
  sendBtn.hidden    = true;
  abandonBtn.hidden = false;
  planBusy = true;

  const statusEl = addPlanStatus('Writing…');
  const ta       = document.getElementById('plan-textarea');
  let full       = '';

  planAbort = new AbortController();
  try {
    const resp = await fetch(`${await resolveOllama()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...planHistory],
        stream: true,
      }),
      signal: planAbort.signal,
    });
    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          full += chunk.message?.content || '';
          if (ta) ta.value = full;
        } catch (_) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (statusEl) { statusEl.textContent = `Error: ${e.message}`; statusEl.classList.add('plan-status-error'); }
      planHistory.pop();
      planBusy = false;
      sendBtn.hidden = false; abandonBtn.hidden = true;
      return;
    }
  }

  if (full) planHistory.push({ role: 'assistant', content: full });
  if (statusEl) statusEl.textContent = '✓ Plan updated';

  planAbort = null;
  planBusy  = false;
  sendBtn.hidden    = false;
  abandonBtn.hidden = true;
}

function buildPlanSystemPrompt(basePrompt, planContent) {
  const agentCtx = agents.length
    ? '\n\nAvailable agents you can reference and assign tasks to:\n' +
      agents.map(a =>
        `  • "${a.name}"  id: ${a.id}  model: ${a.model}` +
        (a.systemPrompt ? `\n    Purpose: ${a.systemPrompt.slice(0, 200)}` : '')
      ).join('\n')
    : '';
  return basePrompt + agentCtx + (planContent ? `\n\nCurrent plan:\n\n${planContent}` : '');
}

async function setPlanInMotion() {
  const planContent = document.getElementById('plan-textarea')?.value?.trim();
  if (!planContent) { addPlanStatus('Write a plan first.', true); return; }

  const model = document.getElementById('plan-model')?.value || models[0] || '';
  const btn   = document.getElementById('plan-execute-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  const agentList = agents.length
    ? agents.map(a =>
        `  - name: "${a.name}", id: "${a.id}", model: "${a.model}"` +
        (a.systemPrompt ? `, purpose: "${a.systemPrompt.slice(0, 150).replace(/"/g, "'")}"` : '')
      ).join('\n')
    : '  (no agents created yet — tasks will use the default model)';

  const prompt =
    `You are given a plan and a list of available agents. Break the plan into concrete, executable tasks.\n\n` +
    `Available agents:\n${agentList}\n\n` +
    `Plan:\n${planContent}\n\n` +
    `Respond with ONLY a JSON array — no markdown fences, no explanation:\n` +
    `[{"name":"Short task name","agentId":"exact-id-or-null","promptTemplate":"Full prompt to send for this task"}]`;

  addPlanStatus('Analyzing plan…');
  try {
    const resp = await fetch(`${await resolveOllama()}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    });
    const data = await resp.json();
    const raw  = (data.message?.content || '').replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const proposed = JSON.parse(raw);
    if (!Array.isArray(proposed) || !proposed.length) throw new Error('No tasks returned');
    renderTaskPreview(proposed);
  } catch (e) {
    addPlanStatus(`Could not generate tasks: ${e.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Execute plan'; }
  }
}

function renderTaskPreview(proposed) {
  const win = document.getElementById('plan-chat-window');
  if (!win) return;
  win.querySelector('.task-preview-block')?.remove();

  const block = document.createElement('div');
  block.className = 'task-preview-block';

  const cards = proposed.map(t => {
    const agent = agents.find(a => a.id === t.agentId);
    return `<div class="task-preview-card">
      <div class="task-preview-name">${escHtml(t.name || 'Unnamed')}</div>
      ${agent ? `<span class="task-preview-agent">${escHtml(agent.name)}</span>` : ''}
      <div class="task-preview-prompt">${escHtml(t.promptTemplate || '')}</div>
    </div>`;
  }).join('');

  block.innerHTML = `
    <div class="task-preview-header">Proposed tasks (${proposed.length})</div>
    ${cards}
    <div class="task-preview-actions">
      <button class="tpa-cancel">Cancel</button>
      <button class="tpa-confirm btn-primary">Create ${proposed.length} task${proposed.length !== 1 ? 's' : ''}</button>
    </div>`;

  block.querySelector('.tpa-cancel').addEventListener('click', () => block.remove());
  block.querySelector('.tpa-confirm').addEventListener('click', async () => {
    for (const t of proposed) {
      const agent = agents.find(a => a.id === t.agentId);
      const task = {
        id:             uid(),
        name:           t.name || 'Unnamed',
        model:          agent?.model || state.model || models[0] || '',
        agentId:        t.agentId || null,
        promptTemplate: t.promptTemplate || '',
        schedule:       { ...SCHEDULE_DEFAULT },
      };
      tasks.unshift(task);
      await api('POST', '/api/tasks', task).catch(() => {});
    }
    block.innerHTML = `<div class="plan-status">✓ ${proposed.length} task${proposed.length !== 1 ? 's' : ''} created — switch to Tasks to review them</div>`;
  });

  win.appendChild(block);
  win.scrollTop = win.scrollHeight;
}

document.getElementById('new-plan-btn').addEventListener('click', createPlan);

// ── Action block system ───────────────────────────────────────────────────────
// Reusable: brain chat, future agent/task output.
// Model emits ```action\n{...}\n``` fences; frontend parses and renders confirm cards.

const ACTION_FENCE_RE = /```action\n([\s\S]*?)\n```/g;

function parseActionBlocks(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(ACTION_FENCE_RE)) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
    try {
      parts.push({ type: 'action', parsed: JSON.parse(m[1].trim()) });
    } catch (_) {
      // Malformed JSON — render as text so nothing is silently swallowed
      parts.push({ type: 'text', content: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
  return parts;
}

function renderWithActions(container, text) {
  container.innerHTML = '';
  for (const part of parseActionBlocks(text)) {
    if (part.type === 'text') {
      if (part.content.trim()) {
        const div = document.createElement('div');
        div.innerHTML = marked.parse(part.content);
        container.appendChild(div);
      }
    } else {
      container.appendChild(buildActionCard(part.parsed));
    }
  }
}

const ACTION_LABELS = {
  create_agent: 'Create Agent',
  create_task:  'Create Task',
  create_plan:  'Create Plan',
  write_file:   'Write File',
  list_files:   'List Files',
  web_search:   'Web Search',
  web_fetch:    'Web Fetch',
};

function buildActionCard(action) {
  const card = document.createElement('div');
  card.className = 'action-card';

  const label = ACTION_LABELS[action.type] || action.type;
  const fields = Object.entries(action)
    .filter(([k]) => k !== 'type')
    .map(([k, v]) => {
      const display = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
      return `<div class="acf-row">
        <span class="acf-key">${escHtml(k)}</span>
        <span class="acf-val">${escHtml(display.slice(0, 300))}${display.length > 300 ? '…' : ''}</span>
      </div>`;
    }).join('');

  card.innerHTML = `
    <div class="action-card-hdr">
      <span class="action-card-type">${escHtml(label)}</span>
    </div>
    <div class="action-card-fields">${fields}</div>
    <div class="action-card-footer">
      <button class="action-dismiss">Dismiss</button>
      <button class="action-confirm btn-primary">Confirm</button>
    </div>`;

  const footer = card.querySelector('.action-card-footer');

  card.querySelector('.action-dismiss').addEventListener('click', () => {
    footer.innerHTML = '<span class="action-status action-status-dim">Dismissed</span>';
  });

  card.querySelector('.action-confirm').addEventListener('click', async () => {
    const btn = card.querySelector('.action-confirm');
    btn.disabled = true;
    btn.textContent = 'Working…';
    card.querySelector('.action-dismiss').disabled = true;
    try {
      const result = await executeAction(action);
      const statusText = typeof result === 'string' ? result : (result?.status || 'Done');
      footer.innerHTML = `<span class="action-status action-status-ok">✓ ${escHtml(statusText)}</span>`;
      // Web actions return {status, followUp, preview} — show preview + "Send to chat" button
      if (result?.followUp) {
        const preview = document.createElement('pre');
        preview.className = 'action-web-result';
        preview.textContent = (result.preview ?? result.followUp).slice(0, 800);
        card.querySelector('.action-card-fields').appendChild(preview);
        const sendBtn = document.createElement('button');
        sendBtn.className = 'btn-primary';
        sendBtn.textContent = 'Send to chat';
        sendBtn.style.marginLeft = '8px';
        footer.appendChild(sendBtn);
        sendBtn.addEventListener('click', async () => {
          sendBtn.disabled = true;
          sendBtn.textContent = 'Sending…';
          await sendBrainMessage(result.followUp);
          sendBtn.textContent = 'Sent ✓';
        });
      }
    } catch (e) {
      footer.innerHTML = `
        <span class="action-status action-status-err">${escHtml(e.message)}</span>
        <button class="action-confirm btn-primary">Retry</button>`;
      footer.querySelector('.action-confirm').addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = 'Working…';
        try {
          const result = await executeAction(action);
          const statusText = typeof result === 'string' ? result : (result?.status || 'Done');
          footer.innerHTML = `<span class="action-status action-status-ok">✓ ${escHtml(statusText)}</span>`;
        } catch (e2) {
          ev.target.disabled = false;
          ev.target.textContent = 'Retry';
          footer.querySelector('.action-status-err').textContent = e2.message;
        }
      });
    }
  });

  if (brainAutoAccept) {
    footer.innerHTML = '<span class="action-status action-status-dim">⚡ Auto-executing…</span>';
    (async () => {
      try {
        const result = await executeAction(action);
        const statusText = typeof result === 'string' ? result : (result?.status || 'Done');
        footer.innerHTML = `<span class="action-status action-status-ok">⚡ ${escHtml(statusText)}</span>`;
        if (result?.followUp) {
          const preview = document.createElement('pre');
          preview.className = 'action-web-result';
          preview.textContent = (result.preview ?? result.followUp).slice(0, 800);
          card.querySelector('.action-card-fields').appendChild(preview);
          const sendBtn = document.createElement('button');
          sendBtn.className = 'btn-primary';
          sendBtn.textContent = 'Send to chat';
          sendBtn.style.marginLeft = '8px';
          footer.appendChild(sendBtn);
          sendBtn.addEventListener('click', async () => {
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending…';
            await sendBrainMessage(result.followUp);
            sendBtn.textContent = 'Sent ✓';
          });
        }
      } catch (e) {
        footer.innerHTML = `<span class="action-status action-status-err">⚡ Failed: ${escHtml(e.message)}</span>`;
      }
    })();
  }

  return card;
}

async function executeAction(action) {
  switch (action.type) {

    case 'create_agent': {
      const agent = {
        id:           uid(),
        name:         action.name         || 'New agent',
        model:        action.model        || models[0] || '',
        systemPrompt: action.systemPrompt || '',
        temperature:  action.temperature  ?? 0.7,
        topP:         action.topP         ?? 0.9,
        contextLen:   action.contextLen   ?? 4096,
        fileAccess:   action.fileAccess   ?? false,
        webAccess:    action.webAccess    ?? false,
      };
      agents.unshift(agent);
      await api('POST', '/api/agents', agent);
      refreshAgentDropdown();
      return `Agent "${agent.name}" created`;
    }

    case 'create_task': {
      const task = {
        id:             uid(),
        name:           action.name           || 'New task',
        model:          action.model          || models[0] || '',
        agentId:        action.agentId        || null,
        promptTemplate: action.promptTemplate || '',
        schedule:       action.schedule       || { type: 'manual' },
      };
      tasks.unshift(task);
      await api('POST', '/api/tasks', task);
      return `Task "${task.name}" created`;
    }

    case 'create_plan': {
      let name = action.name || `Plan ${new Date().toISOString().slice(0, 10)}`;
      if (!name.endsWith('.md')) name += '.md';
      await writePlan(name, action.content || '');
      await loadPlanList();
      return `Plan "${name}" created`;
    }

    case 'write_file': {
      // scope: 'agent_zone' (requires agentId) | 'project'
      const relPath = action.path || '';
      if (!relPath) throw new Error('write_file requires a path');
      const url = action.scope === 'project'
        ? `/api/project/files/${relPath}`
        : `/api/agents/${action.agentId}/files/${relPath}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: action.content || '',
      });
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      return `Written: ${relPath}`;
    }

    case 'list_files': {
      const url = action.scope === 'project'
        ? '/api/project/files'
        : `/api/agents/${action.agentId}/files`;
      const listing = await api('GET', url);
      // Listing is already visible in the action card fields via buildActionCard.
      // Return a summary for the status line.
      const count = Array.isArray(listing)
        ? listing.length
        : (listing.zone?.length ?? 0) + (listing.project?.length ?? 0);
      return `${count} file${count !== 1 ? 's' : ''} found`;
    }

    case 'web_search': {
      const query = (action.query || '').trim();
      if (!query) throw new Error('web_search requires a query');
      const r = await api('GET', `/api/web/search?q=${encodeURIComponent(query)}`);
      if (r.error && !r.results?.length) throw new Error(r.error);
      const lines = (r.results || []).map((x, i) =>
        `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`
      ).join('\n\n');
      const followUp = `Web search results for "${query}":\n\n${lines || '(no results)'}`;
      return { status: `${r.results?.length ?? 0} results`, followUp, preview: lines || '(no results)' };
    }

    case 'web_fetch': {
      const url = (action.url || '').trim();
      if (!url) throw new Error('web_fetch requires a url');
      const r = await api('GET', `/api/web/fetch?url=${encodeURIComponent(url)}`);
      if (r.error) throw new Error(r.error);
      const followUp = `Content fetched from ${url}:\n\n${r.content}`;
      return { status: 'Fetched', followUp, preview: r.content.slice(0, 800) };
    }

    // Future: edit_file, delete_file, read_file, run_command, …

    default:
      throw new Error(`Unknown action type: "${action.type}"`);
  }
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

let pipelines    = [];
let activePipe   = null;         // full pipeline obj with .steps[]
let pipeCanvas   = { x: 80, y: 60, scale: 1 };
let pipeNodes    = {};           // nodeId → { el, x, y }
let pipeRunning  = false;
let pipeActiveJobId = null;      // job id of the in-flight run (for cancel)
let pipeRunAbort = null;
let pipeRunData  = null;         // stepIndex → step-run object
let pipeDetailId = null;
let pipeViewMode = 'edit';       // 'edit' | 'run'
let pipeRunBarInterval = null;
let pipeRunStartTime   = null;
let pipeThinkStreamEl  = null;  // live stream div inside think panel
let pipeThinkReasonEl  = null;  // live reasoning (model thinking) div inside think panel
let pipeThinkStreamText = '';   // raw markdown accumulated for pipeThinkStreamEl
let pipeThinkReasonText = '';   // raw markdown accumulated for pipeThinkReasonEl
let pipeCurrentRunId   = null;  // run id of the in-flight / just-finished run
let pipeAwaitingRunId  = null;  // run id parked at the feedback gate
let pipeRuns           = [];    // run history of the active pipeline (newest first)
let pipeViewedRunId    = null;  // run currently shown on the canvas in run mode

const STEP_W = 224, STEP_H = 134, PM_W = 200, PM_H = 84;

// perspective: nodes lower on the canvas sit closer to the camera and render larger
function depthScale(y) {
  const t = Math.max(0, Math.min(1, y / 900));
  return 0.78 + t * 0.40;
}
// depth is applied as CSS zoom so text re-rasterizes at its true size (crisp,
// unlike transform scale). zoom multiplies the element's own left/top, so the
// position vars are written pre-divided; --lx1/--ly1 hold the hover position,
// where zoom snaps to max(1, depth) with the card kept centered in place.
function placeNode(el, x, y) {
  const small = el.dataset.id === '__pm__' || el.dataset.id === '__feedback__';
  const w = small ? PM_W : STEP_W, h = small ? PM_H : STEP_H;
  const z  = depthScale(y);
  const hz = Math.max(1, z);
  el.style.setProperty('--depth', z.toFixed(3));
  el.style.setProperty('--depth-hover', hz.toFixed(3));
  el.style.setProperty('--lx', (x / z).toFixed(2) + 'px');
  el.style.setProperty('--ly', (y / z).toFixed(2) + 'px');
  el.style.setProperty('--lx1', ((x + (z - hz) * w / 2) / hz).toFixed(2) + 'px');
  el.style.setProperty('--ly1', ((y + (z - hz) * h / 2) / hz).toFixed(2) + 'px');
}

// ── List ──────────────────────────────────────────────────────────────────────

async function loadPipelines() {
  try { pipelines = await api('GET', '/api/pipelines'); } catch (_) { pipelines = []; }
}

function renderPipeList() {
  const el = document.getElementById('pipe-list');
  if (!el) return;
  el.innerHTML = pipelines.length
    ? pipelines.map(p => `
        <div class="pipe-list-item${activePipe?.id === p.id ? ' active' : ''}" data-id="${p.id}">
          <span class="pipe-list-name">${escHtml(p.name)}</span>
          <button class="pipe-list-del" data-id="${p.id}">×</button>
        </div>`).join('')
    : '<div class="pipe-empty-hint">No pipelines yet</div>';
  el.querySelectorAll('.pipe-list-item').forEach(row =>
    row.addEventListener('click', e => {
      if (!e.target.classList.contains('pipe-list-del')) selectPipeline(row.dataset.id);
    })
  );
  el.querySelectorAll('.pipe-list-del').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); deletePipeline(btn.dataset.id); })
  );
}

async function selectPipeline(id) {
  try { activePipe = await api('GET', `/api/pipelines/${id}`); } catch (_) { return; }
  pipeRunData = null;
  pipeViewedRunId = null;
  renderPipeList();
  setPipeSidebarView('runs');
  refreshPipeRuns();
  pipeBtns(true);
  document.getElementById('pipe-name-label').textContent = activePipe.name;
  document.getElementById('pipe-canvas-empty').style.display = 'none';
  setPipeViewMode('edit');
  fitPipeCanvas();

  // Open in run view when there's history; live-reconnect if a job is in flight
  const jobs = await api('GET', `/api/jobs?pipeline_id=${activePipe.id}`).catch(() => null);
  const active = jobs?.find(j => j.status === 'running' || j.status === 'queued');
  if (active) maybeReconnectRunningJob(active);
  else enterRunView({ fallbackToEdit: true });
}

async function createPipeline() {
  const r = await api('POST', '/api/pipelines', { name: 'New Pipeline', goal: '' });
  if (!r?.id) return;
  await loadPipelines();
  await selectPipeline(r.id);
  openPipeDetail('settings');
}

async function deletePipeline(id) {
  if (!confirm('Delete this pipeline and all run history?')) return;
  await api('DELETE', `/api/pipelines/${id}`);
  if (activePipe?.id === id) {
    activePipe = null;
    pipeRuns = [];
    pipeViewedRunId = null;
    pipeBtns(false);
    document.getElementById('pipe-name-label').textContent = 'No pipeline selected';
    document.getElementById('pipe-canvas-empty').style.display = '';
    clearPipeCanvas();
    closePipeDetail();
    setPipeSidebarView('list');
    renderPipeRunList();
  }
  await loadPipelines();
  renderPipeList();
}

function pipeBtns(on) {
  ['pipe-run-btn','pipe-add-step-btn','pipe-fit-btn','pipe-runs-btn','pipe-settings-btn','pipe-mode-edit','pipe-mode-run']
    .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !on; });
}

// ── View mode (edit ↔ run) ────────────────────────────────────────────────────

// Run mode is a monitor: layout drag stays available, structural edits are locked
function setPipeViewMode(mode) {
  pipeViewMode = mode;
  document.getElementById('pipe-mode-edit')?.classList.toggle('active', mode === 'edit');
  document.getElementById('pipe-mode-run')?.classList.toggle('active', mode === 'run');
  const addBtn = document.getElementById('pipe-add-step-btn');
  const setBtn = document.getElementById('pipe-settings-btn');
  if (addBtn && activePipe) addBtn.disabled = mode === 'run' || pipeRunning;
  if (setBtn && activePipe) setBtn.disabled = mode === 'run';
  renderPipeCanvas();
  if (!pipeRunning) showViewedRunBar();
  // refresh an open step detail so it matches the mode (edit form vs run output)
  if (pipeDetailId && !['settings', 'replay', 'jobs'].includes(pipeDetailId)) {
    openPipeDetail(pipeDetailId);
  }
}

// Flip to run view showing the latest run (the live one while a run is in flight)
async function enterRunView(opts = {}) {
  if (!activePipe) return;
  if (pipeRunning) { setPipeViewMode('run'); return; }
  let runs = [];
  try { runs = await api('GET', `/api/pipelines/${activePipe.id}/runs`) || []; } catch (_) {}
  pipeRuns = runs;
  if (!runs.length && opts.fallbackToEdit) { renderPipeRunList(); return; }
  if (runs.length) {
    pipeViewedRunId = runs[0].id;
    try { applyRunStepData(await api('GET', `/api/pipeline-runs/${runs[0].id}`)); } catch (_) {}
  }
  renderPipeRunList();
  setPipeViewMode('run');
}

// Canvas + step detail show each step's latest iteration of the given run
function applyRunStepData(run) {
  const stepRuns = run.stepRuns || [];
  const latest = {};
  stepRuns.forEach(sr => {
    const it = sr.iteration || 0;
    if (!latest[sr.stepIndex] || it >= (latest[sr.stepIndex].iteration || 0)) latest[sr.stepIndex] = sr;
  });
  pipeRunData = Object.values(latest);
}

// ── Sidebar run history ───────────────────────────────────────────────────────

function runLabel(run) {
  const i  = pipeRuns.findIndex(r => r.id === run.id);
  const n  = i === -1 ? '' : `Run ${pipeRuns.length - i}`;
  const ts = (run.startedAt || '').slice(5, 16).replace('T', ' ');
  return [n, ts].filter(Boolean).join(' · ');
}

async function refreshPipeRuns() {
  if (!activePipe) { pipeRuns = []; renderPipeRunList(); return; }
  try { pipeRuns = await api('GET', `/api/pipelines/${activePipe.id}/runs`) || []; } catch (_) { pipeRuns = []; }
  renderPipeRunList();
}

// Sidebar drill-down: 'list' shows all pipelines, 'runs' shows the active pipe's runs
function setPipeSidebarView(view) {
  const runs = view === 'runs';
  document.getElementById('pipe-sidebar-header')?.classList.toggle('hidden', runs);
  document.getElementById('pipe-list')?.classList.toggle('hidden', runs);
  document.getElementById('pipe-runs-header')?.classList.toggle('hidden', !runs);
  document.getElementById('pipe-run-list')?.classList.toggle('hidden', !runs);
  const title = document.getElementById('pipe-runs-title');
  if (title && runs) title.textContent = activePipe?.name || 'Runs';
}

function renderPipeRunList() {
  const list = document.getElementById('pipe-run-list');
  if (!list) return;
  if (!pipeRuns.length) {
    list.innerHTML = '<div class="pipe-empty-hint">No runs yet. Click ▶ Run to start.</div>';
    return;
  }
  list.innerHTML = pipeRuns.map(r => {
    const live     = pipeRunning && r.id === pipeCurrentRunId;
    const finished = !['running', 'pending'].includes(r.status);
    return `
    <div class="pipe-run-item${r.id === pipeViewedRunId ? ' active' : ''}" data-run-id="${r.id}" title="${r.status.replace(/_/g, ' ')}">
      <span class="pipe-run-dot run-dot-${r.status}"></span>
      <span class="pipe-run-name">${live ? '● Live run' : escHtml(runLabel(r))}</span>
      ${r.userFeedback ? `<span class="run-history-fb" title="${escHtml(r.userFeedback)}">⟲</span>` : ''}
      ${finished ? `<button class="pipe-run-fb" data-run-id="${r.id}" title="Send feedback — re-runs all agents + PM with it">⟲</button>` : ''}
      <button class="pipe-run-del" data-run-id="${r.id}" title="Delete this run">×</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.pipe-run-item').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.closest('.pipe-run-fb, .pipe-run-del')) return;
      viewPipeRun(row.dataset.runId);
    })
  );
  list.querySelectorAll('.pipe-run-fb').forEach(btn =>
    btn.addEventListener('click', () => {
      const text = prompt('Feedback on this run — the whole pipeline re-runs from the start block with it:');
      if (text?.trim()) submitRunFeedback(btn.dataset.runId, text);
    })
  );
  list.querySelectorAll('.pipe-run-del').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this run?')) return;
      await api('DELETE', `/api/pipeline-runs/${btn.dataset.runId}`);
      if (pipeViewedRunId === btn.dataset.runId) pipeViewedRunId = null;
      refreshPipeRuns();
    })
  );
}

function viewPipeRun(runId) {
  // Replaying another run mid-flight would clobber the live canvas state
  if (pipeRunning) {
    if (runId === pipeCurrentRunId) setPipeViewMode('run');
    return;
  }
  loadRunReplay(runId);
}

// Static run bar while replaying a finished run — shows which run is on screen
function showViewedRunBar() {
  if (pipeRunning) return;
  const bar = document.getElementById('pipe-run-bar');
  if (!bar) return;
  const run = pipeRuns.find(r => r.id === pipeViewedRunId);
  if (!run || pipeViewMode !== 'run') { bar.classList.add('hidden'); return; }
  const total = activePipe?.steps?.length ?? 0;
  const done  = (pipeRunData || []).filter(sr => ['done', 'reused'].includes(sr.status)).length;
  bar.classList.remove('hidden');
  document.getElementById('pipe-run-bar-name').textContent     = runLabel(run);
  document.getElementById('pipe-run-bar-progress').textContent = `${done} / ${total} steps`;
  document.getElementById('pipe-run-bar-phase').textContent    = `· ${run.status.replace(/_/g, ' ')}`;
  document.getElementById('pipe-run-bar-step').textContent     = '';
  document.getElementById('pipe-run-bar-elapsed').textContent  = '';
}

// ── Step CRUD ─────────────────────────────────────────────────────────────────

async function addPipeStep() {
  if (!activePipe) return;
  const r = await api('POST', `/api/pipelines/${activePipe.id}/steps`, {
    name: `Step ${(activePipe.steps?.length || 0) + 1}`, task: '',
    handoverFields: [], qualityCriteria: [],
  });
  if (!r?.id) return;
  activePipe = await api('GET', `/api/pipelines/${activePipe.id}`);
  const newStep = activePipe.steps[activePipe.steps.length - 1];
  const prev    = activePipe.steps[activePipe.steps.length - 2];
  const layout  = { ...(activePipe.layout || {}) };
  layout[newStep.id] = prev && layout[prev.id]
    ? { x: layout[prev.id].x + 300, y: layout[prev.id].y }
    : { x: 80 + (activePipe.steps.length - 1) * 300, y: 160 };
  activePipe.layout = layout;
  await api('PUT', `/api/pipelines/${activePipe.id}`, activePipe);
  renderPipeCanvas();
  openPipeDetail(newStep.id);
}

async function deletePipeStep(stepId) {
  if (!activePipe || !confirm('Delete this step?')) return;
  await api('DELETE', `/api/pipelines/${activePipe.id}/steps/${stepId}`);
  const layout = { ...(activePipe.layout || {}) };
  delete layout[stepId];
  activePipe.layout = layout;
  await api('PUT', `/api/pipelines/${activePipe.id}`, activePipe);
  activePipe = await api('GET', `/api/pipelines/${activePipe.id}`);
  if (pipeDetailId === stepId) closePipeDetail();
  renderPipeCanvas();
}

async function savePipeStep(step) {
  await api('PUT', `/api/pipelines/${activePipe.id}/steps/${step.id}`, step);
  const i = activePipe.steps.findIndex(s => s.id === step.id);
  if (i !== -1) activePipe.steps[i] = { ...activePipe.steps[i], ...step };
  renderPipeCanvas();
}

async function savePipeline(updates) {
  Object.assign(activePipe, updates);
  await api('PUT', `/api/pipelines/${activePipe.id}`, activePipe);
  document.getElementById('pipe-name-label').textContent = activePipe.name;
  renderPipeList();
  renderPipeCanvas();
}

// ── Canvas engine ─────────────────────────────────────────────────────────────

function initPipeCanvas() {
  const wrap = document.getElementById('pipe-canvas-wrap');
  if (!wrap || wrap._pipeInit) return;
  wrap._pipeInit = true;

  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const f  = e.deltaY < 0 ? 1.1 : 0.909;
    const ns = Math.min(2.5, Math.max(0.15, pipeCanvas.scale * f));
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    pipeCanvas.x = mx - (mx - pipeCanvas.x) * (ns / pipeCanvas.scale);
    pipeCanvas.y = my - (my - pipeCanvas.y) * (ns / pipeCanvas.scale);
    pipeCanvas.scale = ns;
    applyPipeXform();
  }, { passive: false });

  let pan = null;
  wrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const ok = e.target === wrap || ['pipe-canvas','pipe-nodes','pipe-svg'].includes(e.target.id)
               || e.target.tagName === 'svg' || e.target.tagName === 'SVG';
    if (!ok) return;
    pan = { ox: e.clientX - pipeCanvas.x, oy: e.clientY - pipeCanvas.y };
    wrap.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!pan) return;
    pipeCanvas.x = e.clientX - pan.ox;
    pipeCanvas.y = e.clientY - pan.oy;
    applyPipeXform();
  });
  document.addEventListener('mouseup', () => {
    if (pan) { pan = null; const wrap = document.getElementById('pipe-canvas-wrap'); if (wrap) wrap.style.cursor = ''; }
  });
}

function applyPipeXform() {
  const c = document.getElementById('pipe-canvas');
  if (c) c.style.transform = `translate(${pipeCanvas.x}px,${pipeCanvas.y}px) scale(${pipeCanvas.scale})`;
}

function fitPipeCanvas() {
  if (!activePipe?.steps?.length) return;
  const wrap = document.getElementById('pipe-canvas-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const layout = activePipe.layout || {};
  const xs = activePipe.steps.map(s => layout[s.id]?.x ?? 80);
  const ys = activePipe.steps.map(s => layout[s.id]?.y ?? 160);
  const pad = 80;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const x1 = Math.max(...xs) + STEP_W + pad, y1 = Math.max(...ys) + STEP_H + 160 + pad;
  pipeCanvas.scale = Math.min(1.4, Math.max(0.2, Math.min(rect.width / (x1-x0), rect.height / (y1-y0)) * 0.88));
  pipeCanvas.x = (rect.width  - (x1-x0) * pipeCanvas.scale) / 2 - x0 * pipeCanvas.scale;
  pipeCanvas.y = (rect.height - (y1-y0) * pipeCanvas.scale) / 2 - y0 * pipeCanvas.scale;
  applyPipeXform();
}

function clearPipeCanvas() {
  const n = document.getElementById('pipe-nodes');
  const s = document.getElementById('pipe-svg');
  if (n) n.innerHTML = '';
  if (s) [...s.querySelectorAll('path')].forEach(e => e.remove());
  pipeNodes = {};
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function renderPipeCanvas() {
  clearPipeCanvas();
  if (!activePipe) return;
  const layout = activePipe.layout || {};
  const steps  = activePipe.steps  || [];
  const nodesEl = document.getElementById('pipe-nodes');

  steps.forEach((s, i) => {
    if (!layout[s.id]) layout[s.id] = { x: 80 + i * 300, y: 160 };
  });
  if (steps.length && !layout['__pm__']) {
    const cx = steps.reduce((a, s) => a + (layout[s.id]?.x ?? 80), 0) / steps.length;
    layout['__pm__'] = { x: cx, y: 360 };
  }

  steps.forEach(step => {
    const pos  = layout[step.id];
    const node = buildStepNode(step, pos);
    nodesEl.appendChild(node);
    pipeNodes[step.id] = { el: node, x: pos.x, y: pos.y };
  });

  if (steps.length) {
    const pmPos = layout['__pm__'] || { x: 300, y: 360 };
    const pm    = buildPmNode(pmPos);
    nodesEl.appendChild(pm);
    pipeNodes['__pm__'] = { el: pm, x: pmPos.x, y: pmPos.y };
  }

  if (steps.length && activePipe.feedbackLoop !== false) {
    const last  = steps[steps.length - 1];
    const fbPos = layout['__feedback__'] ||
      { x: (layout[last.id]?.x ?? 80) + 300, y: layout[last.id]?.y ?? 160 };
    const fb = buildFeedbackNode(fbPos);
    nodesEl.appendChild(fb);
    pipeNodes['__feedback__'] = { el: fb, x: fbPos.x, y: fbPos.y };
  }

  drawArrows();
}

function statusLabel(status) {
  return { idle:'○', pending:'○', running:'◉', reviewing:'⟳', done:'✓', pass:'✓', fail:'✗', failed:'✗', retry:'↻', paused:'⏸', skipped:'→' }[status] || '○';
}

function buildStepNode(step, pos) {
  const sr     = pipeViewMode === 'run' ? pipeRunData?.find(r => r.stepIndex === step.stepIndex) : null;
  const status = sr?.status || 'idle';
  const div    = document.createElement('div');
  div.className = `pipe-node status-node-${status}`;
  div.dataset.id = step.id;
  div.style.cssText = `width:${STEP_W}px`;
  placeNode(div, pos.x, pos.y);
  div.innerHTML = `
    <div class="pipe-node-hdr">
      <span class="pipe-node-idx">${step.stepIndex + 1}</span>
      <span class="pipe-node-title">${escHtml(step.name || 'Unnamed')}</span>
      <span class="pipe-node-badge status-badge-${status}" title="${status}">${statusLabel(status)}</span>
    </div>
    <div class="pipe-node-agent">${step.agentName ? `<span class="agent-dot">●</span> ${escHtml(step.agentName)}` : '<span class="pipe-node-dim">— no agent —</span>'}</div>
    <div class="pipe-node-task">${escHtml((step.task || '(no task)').slice(0, 88))}${(step.task||'').length > 88 ? '…' : ''}</div>
    <div class="pipe-node-footer">
      <span class="pipe-node-chips">${step.handoverFields?.length || 0} fields · ${step.qualityCriteria?.length || 0} criteria</span>
      ${pipeViewMode === 'edit' ? '<button class="pipe-node-del" title="Delete step">×</button>' : ''}
    </div>`;
  div.querySelector('.pipe-node-del')?.addEventListener('click', e => { e.stopPropagation(); deletePipeStep(step.id); });
  div.addEventListener('click', e => { if (!e.target.classList.contains('pipe-node-del')) openPipeDetail(step.id); });
  makeNodeDraggable(div, step.id);
  return div;
}

function buildPmNode(pos) {
  const a = agents.find(a => a.id === activePipe.pmAgentId);
  const label = a?.name || activePipe.pmModel || 'No PM configured';

  let reviewHtml = '';
  if (pipeViewMode === 'run' && pipeRunData?.length) {
    const reviewed = pipeRunData.filter(sr => sr.qaVerdict);
    if (reviewed.length) {
      const last = reviewed[reviewed.length - 1];
      const icon = last.qaVerdict === 'pass' ? '✓' : '✗';
      const text = last.qaVerdict === 'pass' ? (last.pmNotes || 'Passed') : (last.qaReason || 'Failed');
      reviewHtml = `<div class="pipe-node-pm-review pm-review-${last.qaVerdict}">${escHtml(icon + ' ' + text)}</div>`;
    }
  }

  const div = document.createElement('div');
  div.className = 'pipe-node pipe-node-pm';
  div.dataset.id = '__pm__';
  div.style.cssText = `width:${PM_W}px`;
  placeNode(div, pos.x, pos.y);
  div.innerHTML = `
    <div class="pipe-node-hdr">
      <span class="pipe-node-pm-icon">◈</span>
      <span class="pipe-node-title">PM Overseer</span>
    </div>
    <div class="pipe-node-agent">${escHtml(label)}</div>
    ${reviewHtml}
    <div class="pipe-node-footer">
      <span>${activePipe.pauseOnFail ? '⏸ Pause on fail' : '→ Continue on fail'}</span>
    </div>`;
  div.addEventListener('click', () => openPipeDetail('settings'));
  makeNodeDraggable(div, '__pm__');
  return div;
}

function updatePmNodeReview(verdict, text) {
  const pmEl = pipeNodes['__pm__']?.el;
  if (!pmEl) return;
  let reviewEl = pmEl.querySelector('.pipe-node-pm-review');
  if (!reviewEl) {
    reviewEl = document.createElement('div');
    const footer = pmEl.querySelector('.pipe-node-footer');
    pmEl.insertBefore(reviewEl, footer);
  }
  const icon = verdict === 'pass' ? '✓' : '✗';
  reviewEl.className = `pipe-node-pm-review pm-review-${verdict}`;
  reviewEl.textContent = `${icon} ${text}`;
}

function buildFeedbackNode(pos) {
  const awaiting = !!pipeAwaitingRunId;
  const div = document.createElement('div');
  div.className = `pipe-node pipe-node-feedback${awaiting ? ' feedback-awaiting' : ''}`;
  div.dataset.id = '__feedback__';
  div.style.cssText = `width:${PM_W}px`;
  placeNode(div, pos.x, pos.y);
  div.innerHTML = `
    <div class="pipe-node-hdr">
      <span class="pipe-node-fb-icon">⟲</span>
      <span class="pipe-node-title">Feedback gate</span>
    </div>
    <div class="pipe-node-agent">You — review &amp; loop to start</div>
    <div class="pipe-node-fb-status">${awaiting ? '⏸ awaiting your feedback' : ''}</div>
    <div class="pipe-node-footer">
      <span>⟲ Re-runs all agents + PM</span>
    </div>`;
  div.addEventListener('click', () => openPipeDetail('__feedback__'));
  makeNodeDraggable(div, '__feedback__');
  return div;
}

function setFeedbackNodeStatus(status) {
  const el = pipeNodes['__feedback__']?.el;
  if (!el) return;
  el.classList.toggle('feedback-awaiting', status === 'awaiting');
  const badge = el.querySelector('.pipe-node-fb-status');
  if (badge) badge.textContent =
    status === 'awaiting' ? '⏸ awaiting your feedback' :
    status === 'done'     ? '✓ approved' : '';
}

function makeNodeDraggable(el, nodeId) {
  let drag = null;
  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('pipe-node-del') || e.button !== 0) return;
    const n = pipeNodes[nodeId];
    drag = { sx: e.clientX, sy: e.clientY, sl: n?.x ?? 0, st: n?.y ?? 0 };
    el.classList.add('dragging');
    e.stopPropagation();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const nx = drag.sl + (e.clientX - drag.sx) / pipeCanvas.scale;
    const ny = drag.st + (e.clientY - drag.sy) / pipeCanvas.scale;
    placeNode(el, nx, ny);
    if (pipeNodes[nodeId]) { pipeNodes[nodeId].x = nx; pipeNodes[nodeId].y = ny; }
    drawArrows();
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    el.classList.remove('dragging');
    if (activePipe) {
      const layout = activePipe.layout || {};
      const n = pipeNodes[nodeId];
      layout[nodeId] = { x: Math.round(n?.x ?? 0), y: Math.round(n?.y ?? 0) };
      activePipe.layout = layout;
      api('PUT', `/api/pipelines/${activePipe.id}`, activePipe).catch(() => {});
    }
  });
}

function nodePt(id, side) {
  const n = pipeNodes[id];
  if (!n) return { x: 0, y: 0 };
  const small = id === '__pm__' || id === '__feedback__';
  const w = small ? PM_W : STEP_W;
  const h = small ? PM_H : STEP_H;
  // depth is a zoom, so the box scales from its top-left corner;
  // anchor arrows to the zoomed edges
  const s  = parseFloat(n.el?.style.getPropertyValue('--depth')) || 1;
  const sw = w * s, sh = h * s;
  return {
    right:  { x: n.x + sw,   y: n.y + sh/2 },
    left:   { x: n.x,        y: n.y + sh/2 },
    bottom: { x: n.x + sw/2, y: n.y + sh },
    top:    { x: n.x + sw/2, y: n.y },
  }[side] || { x: n.x + sw/2, y: n.y + sh/2 };
}

function drawArrows() {
  const svg = document.getElementById('pipe-svg');
  if (!svg) return;
  [...svg.querySelectorAll('path')].forEach(e => e.remove());
  const steps = activePipe?.steps || [];

  for (let i = 0; i < steps.length - 1; i++) {
    const a = nodePt(steps[i].id, 'right');
    const b = nodePt(steps[i+1].id, 'left');
    const mx = (a.x + b.x) / 2;
    addPath(svg, `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`, 'pipe-arrow', 'url(#arrow-head)');
  }

  if (pipeNodes['__pm__']) {
    steps.forEach(step => {
      const a = nodePt(step.id, 'bottom');
      const b = nodePt('__pm__', 'top');
      addPath(svg, `M${a.x},${a.y} C${a.x},${a.y+50} ${b.x},${b.y-50} ${b.x},${b.y}`, 'pipe-arrow pipe-arrow-pm', 'url(#arrow-head-pm)');
    });
  }

  if (pipeNodes['__feedback__'] && steps.length) {
    // Last step → feedback gate
    const a  = nodePt(steps[steps.length - 1].id, 'right');
    const b  = nodePt('__feedback__', 'left');
    const mx = (a.x + b.x) / 2;
    addPath(svg, `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`, 'pipe-arrow', 'url(#arrow-head)');
    // Feedback gate → start block (the user-feedback loop)
    const f    = nodePt('__feedback__', 'top');
    const s0   = nodePt(steps[0].id, 'top');
    const lift = Math.min(f.y, s0.y) - 110;
    addPath(svg, `M${f.x},${f.y} C${f.x},${lift} ${s0.x},${lift} ${s0.x},${s0.y}`, 'pipe-arrow pipe-arrow-loop', 'url(#arrow-head)');
  }
}

function addPath(svg, d, cls, marker) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d); p.setAttribute('class', cls);
  if (marker) p.setAttribute('marker-end', marker);
  svg.appendChild(p);
}

function setNodeStatus(stepIndex, status) {
  const sr = pipeRunData?.find(r => r.stepIndex === stepIndex);
  if (sr) sr.status = status;
  if (pipeViewMode !== 'run') return;  // recorded above; canvas re-renders on mode flip
  const step = activePipe?.steps?.find(s => s.stepIndex === stepIndex);
  if (!step) return;
  const node = pipeNodes[step.id]?.el;
  if (!node) return;
  node.className = `pipe-node status-node-${status}`;
  const badge = node.querySelector('.pipe-node-badge');
  if (badge) { badge.className = `pipe-node-badge status-badge-${status}`; badge.textContent = statusLabel(status); }
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function openPipeDetail(id) {
  pipeDetailId = id;
  const panel = document.getElementById('pipe-detail');
  const title = document.getElementById('pipe-detail-title');
  const body  = document.getElementById('pipe-detail-body');
  if (!panel) return;
  panel.classList.remove('hidden');

  if (id === 'settings') {
    title.textContent = 'Pipeline settings';
    body.innerHTML = buildPipeSettingsHtml();
    bindPipeSettings();
  } else if (id === '__feedback__') {
    title.textContent = 'Feedback gate';
    body.innerHTML = buildFeedbackDetailHtml();
    bindFeedbackDetail();
  } else {
    const step = activePipe?.steps?.find(s => s.id === id);
    if (!step) return;
    title.textContent = `Step ${step.stepIndex + 1}`;
    if (pipeViewMode === 'run') {
      const sr = pipeRunData?.find(r => r.stepIndex === step.stepIndex);
      body.innerHTML = buildStepRunHtml(step, sr);
    } else {
      body.innerHTML = buildStepEditHtml(step);
      bindStepEdit(step);
    }
  }
}

function closePipeDetail() {
  pipeDetailId = null;
  document.getElementById('pipe-detail')?.classList.add('hidden');
}

function buildPipeSettingsHtml() {
  const p = activePipe;
  const agOpts = agents.map(a => `<option value="${a.id}"${a.id===p.pmAgentId?' selected':''}>${escHtml(a.name)}</option>`).join('');
  const mdOpts = models.map(m => `<option value="${m}"${m===p.pmModel?' selected':''}>${escHtml(m)}</option>`).join('');
  return `<div class="detail-form">
    <div class="detail-field"><label>Name</label><input id="pd-name" value="${escHtml(p.name)}"></div>
    <div class="detail-field"><label>Goal / description</label><textarea id="pd-goal" rows="3">${escHtml(p.goal)}</textarea></div>
    <div class="detail-field"><label>PM Agent</label><select id="pd-pm-agent"><option value="">— model only —</option>${agOpts}</select></div>
    <div class="detail-field"><label>PM Model</label><select id="pd-pm-model"><option value="">— pick model —</option>${mdOpts}</select></div>
    <div class="detail-field toggle-field"><label>Pause on QA fail</label><input type="checkbox" id="pd-pause"${p.pauseOnFail?' checked':''}></div>
    <div class="detail-actions">
      <button id="pd-save" class="btn-primary">Save</button>
      <button id="pd-del" class="btn-danger">Delete pipeline</button>
    </div>
  </div>`;
}

function bindPipeSettings() {
  document.getElementById('pd-save')?.addEventListener('click', () => {
    savePipeline({
      name:        document.getElementById('pd-name').value.trim() || 'Pipeline',
      goal:        document.getElementById('pd-goal').value,
      pmAgentId:   document.getElementById('pd-pm-agent').value || null,
      pmModel:     document.getElementById('pd-pm-model').value,
      pauseOnFail: document.getElementById('pd-pause').checked,
    });
  });
  document.getElementById('pd-del')?.addEventListener('click', () => deletePipeline(activePipe.id));
}

// The run feedback applies to: the one parked at the gate, else the viewed run,
// else the latest finished run — so the gate is usable for any old run too
function feedbackTargetRun() {
  if (pipeRunning) return null;
  const finished = r => r && !['running', 'pending'].includes(r.status);
  const byId = id => pipeRuns.find(r => r.id === id);
  return [byId(pipeAwaitingRunId), byId(pipeViewedRunId), pipeRuns.find(finished)].find(finished) || null;
}

function buildFeedbackDetailHtml() {
  const target = feedbackTargetRun();
  const formHtml = target ? `
    <div class="detail-field">
      <label>Your feedback on ${escHtml(runLabel(target))} <span class="label-hint">all agents + the PM re-run from the start block with it</span></label>
      <textarea id="fd-text" rows="4" placeholder="What should change? e.g. the export link is broken — fix it"></textarea>
    </div>
    <div class="detail-actions">
      <button id="fd-send" class="btn-primary">⟲ Send &amp; re-run</button>
      ${target.status === 'awaiting_feedback' ? '<button id="fd-approve">✓ Approve run</button>' : ''}
    </div>` : `
    <div class="detail-run-empty">${pipeRunning
      ? 'Run in progress — feedback opens when it finishes.'
      : 'No finished runs yet. After a run finishes you can send feedback here.'}</div>`;
  return `<div class="detail-form">
    <div class="detail-field">
      <p class="label-hint">After each run the pipeline parks here. Send feedback to loop the whole
      pipe back to the start block — every agent revises its previous output and the PM
      reviews against your feedback — or approve to close the loop.</p>
    </div>
    ${formHtml}
    <div class="detail-field toggle-field"><label>Feedback gate enabled</label><input type="checkbox" id="fd-enabled"${activePipe?.feedbackLoop !== false ? ' checked' : ''}></div>
    <div class="detail-actions"><button id="fd-save" class="btn-primary">Save</button></div>
  </div>`;
}

function bindFeedbackDetail() {
  const target = feedbackTargetRun();
  document.getElementById('fd-send')?.addEventListener('click', () => {
    submitRunFeedback(target?.id, document.getElementById('fd-text')?.value);
  });
  document.getElementById('fd-approve')?.addEventListener('click', () => approveRun(target?.id));
  document.getElementById('fd-save')?.addEventListener('click', async () => {
    await savePipeline({ feedbackLoop: document.getElementById('fd-enabled').checked });
    closePipeDetail();
  });
}

async function submitRunFeedback(runId, text, formEl) {
  text = (text || '').trim();
  if (!runId) return;
  if (!text) { alert('Write what should change first.'); return; }
  let r;
  try {
    const resp = await fetch(`/api/pipeline-runs/${runId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: text }),
    });
    r = await resp.json().catch(() => ({}));
  } catch (e) {
    alert('Could not start the revision run: ' + e.message);
    return;
  }
  if (!r?.jobId) { alert(r?.error || 'Could not start the revision run'); return; }
  formEl?.remove();
  pipeAwaitingRunId = null;
  closePipeDetail();
  refreshPipeRuns();
  maybeReconnectRunningJob();
}

async function approveRun(runId, formEl) {
  if (!runId) return;
  await api('POST', `/api/pipeline-runs/${runId}/approve`);
  formEl?.remove();
  pipeAwaitingRunId = null;
  setFeedbackNodeStatus('done');
  appendThinkEntry('think-run-done', '✓ Approved — feedback loop closed');
  closePipeDetail();
  refreshPipeRuns();
}

const TIER_OPTIONS = ['local', 'fast', 'smart', 'powerful', 'auto'];
const TIER_LABELS  = { local: 'Local (Ollama)', fast: 'Fast (Haiku)', smart: 'Smart (Sonnet)', powerful: 'Powerful (Opus)', auto: 'Auto (by size)' };

function buildStepEditHtml(step) {
  const agOpts   = agents.map(a => `<option value="${a.id}"${a.id===step.agentId?' selected':''}>${escHtml(a.name)}</option>`).join('');
  const tierOpts = TIER_OPTIONS.map(t => `<option value="${t}"${(step.modelTier||'local')===t?' selected':''}>${TIER_LABELS[t]}</option>`).join('');
  const lc = step.loopConfig || {};
  const lcMax  = lc.maxIterations || lc.maxDepth || 5;
  const lcSent = lc.sentinel ?? lc.stopCondition ?? '';
  const lcBack = lc.backToStep ?? step.stepIndex;
  const backOpts = (activePipe?.steps || [])
    .filter(s => s.stepIndex <= step.stepIndex)
    .map(s => `<option value="${s.stepIndex}"${s.stepIndex === lcBack ? ' selected' : ''}>` +
              `Step ${s.stepIndex + 1}: ${escHtml(s.name)}${s.stepIndex === step.stepIndex ? ' (this step)' : ''}</option>`)
    .join('');
  return `<div class="detail-form">
    <div class="detail-field"><label>Step name</label><input id="sd-name" value="${escHtml(step.name)}"></div>
    <div class="detail-field"><label>Agent</label><select id="sd-agent"><option value="">— no agent —</option>${agOpts}</select></div>
    <div class="detail-field"><label>Model tier</label><select id="sd-tier">${tierOpts}</select></div>
    <div class="detail-field"><label>Task</label><textarea id="sd-task" rows="4">${escHtml(step.task)}</textarea></div>
    <div class="detail-field"><label>Agent input <span class="label-hint">optional — injected as context when step runs</span></label><textarea id="sd-input" rows="3">${escHtml(step.agentInput || '')}</textarea></div>
    <div class="detail-field">
      <label>Quality criteria <span class="label-hint">PM checks these after each attempt</span></label>
      <div class="tag-input" id="sd-qc-tags"></div>
      <input id="sd-qc-input" placeholder="Type criterion, press Enter…">
    </div>
    <div class="detail-field">
      <label class="loop-label">
        <input type="checkbox" id="sd-loop-enabled"${lc.enabled?' checked':''}> Enable refinement loop
        <span class="label-hint">PM reviews each pass and decides done / iterate; loop re-runs from the chosen step</span>
      </label>
    </div>
    <div id="sd-loop-fields" style="display:${lc.enabled?'block':'none'}">
      <div class="detail-field"><label>Loop back to</label>
        <select id="sd-loop-back">${backOpts}</select>
      </div>
      <div class="detail-field"><label>Max iterations</label>
        <input type="number" id="sd-loop-max" value="${lcMax}" min="1" max="20" style="width:80px">
      </div>
      <div class="detail-field"><label>Done sentinel <span class="label-hint">optional — loop stops if the output contains this text, e.g. <code>LOOP_DONE</code></span></label>
        <input id="sd-loop-sentinel" value="${escHtml(lcSent)}" placeholder="LOOP_DONE">
      </div>
      <div class="detail-field"><label>Token budget <span class="label-hint">optional — approx tokens across all iterations, 0 = unlimited</span></label>
        <input type="number" id="sd-loop-budget" value="${lc.tokenBudget || 0}" min="0" style="width:100px">
      </div>
    </div>
    <div class="detail-actions">
      <button id="sd-save" class="btn-primary">Save step</button>
      <button id="sd-del" class="btn-danger">Delete</button>
    </div>
  </div>`;
}

function bindStepEdit(step) {
  const qc = [...(step.qualityCriteria || [])];
  renderTagChips('sd-qc-tags', qc);
  bindTagInput('sd-qc-input', qc, 'sd-qc-tags');

  document.getElementById('sd-loop-enabled')?.addEventListener('change', e => {
    document.getElementById('sd-loop-fields').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('sd-save')?.addEventListener('click', () => {
    const agEl    = document.getElementById('sd-agent');
    const aid     = agEl.value;
    const loopOn  = document.getElementById('sd-loop-enabled')?.checked || false;
    if (loopOn) {
      const other = (activePipe?.steps || []).find(s =>
        s.id !== step.id && s.loopConfig?.enabled);
      if (other) {
        alert(`Only one loop-enabled step per pipeline — "${other.name}" already has the loop. Disable it first.`);
        return;
      }
    }
    savePipeStep({ ...step,
      name:            document.getElementById('sd-name').value.trim() || step.name,
      agentId:         aid || null,
      agentName:       aid ? (agEl.options[agEl.selectedIndex]?.text || '') : '',
      task:            document.getElementById('sd-task').value,
      agentInput:      document.getElementById('sd-input').value,
      qualityCriteria: qc,
      modelTier:       document.getElementById('sd-tier')?.value || 'local',
      loopConfig: {
        enabled:       loopOn,
        backToStep:    Number.isNaN(parseInt(document.getElementById('sd-loop-back')?.value, 10))
                         ? step.stepIndex
                         : parseInt(document.getElementById('sd-loop-back').value, 10),
        maxIterations: parseInt(document.getElementById('sd-loop-max')?.value, 10) || 5,
        sentinel:      document.getElementById('sd-loop-sentinel')?.value.trim() || '',
        tokenBudget:   parseInt(document.getElementById('sd-loop-budget')?.value, 10) || 0,
      },
    });
    openPipeDetail(step.id);
  });
  document.getElementById('sd-del')?.addEventListener('click', () => deletePipeStep(step.id));
}

function renderTagChips(containerId, items, onRemove) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map((v, i) =>
    `<span class="tag-chip">${escHtml(v)}<button class="tag-del" data-i="${i}">×</button></span>`
  ).join('');
  el.querySelectorAll('.tag-del').forEach(b => b.addEventListener('click', () => {
    items.splice(+b.dataset.i, 1);
    renderTagChips(containerId, items, onRemove);
    onRemove?.();
  }));
}

function bindTagInput(inputId, arr, tagsId) {
  document.getElementById(inputId)?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (v && !arr.includes(v)) { arr.push(v); renderTagChips(tagsId, arr); }
    e.target.value = '';
    e.preventDefault();
  });
}

function buildStepRunHtml(step, sr) {
  if (!sr || sr.status === 'pending')
    return '<div class="detail-run-empty">Waiting to start…</div>';

  // Handover banner: show which agent handed to this one
  let handoverHtml = '';
  if (step.stepIndex > 0 && pipeRunData) {
    const prevSr   = pipeRunData.find(r => r.stepIndex === step.stepIndex - 1);
    const prevStep = activePipe?.steps?.find(s => s.stepIndex === step.stepIndex - 1);
    if (prevSr && prevStep) {
      handoverHtml = `<div class="run-handover-banner">
        <span class="run-handover-arrow">←</span>
        Handed over from Step ${step.stepIndex}: <span class="run-handover-agent">${escHtml(prevStep.name)}${prevStep.agentName ? ' · ' + escHtml(prevStep.agentName) : ''}</span>
      </div>`;
    }
  }

  // Collect outputs from all previous steps that have run
  const prevOutputs = step.stepIndex > 0 && pipeRunData
    ? pipeRunData
        .filter(r => r.stepIndex < step.stepIndex && r.output)
        .map(r => {
          const prevStep = activePipe?.steps?.find(s => s.stepIndex === r.stepIndex);
          return `<div class="agent-input-step">
            <div class="agent-input-step-label">Step ${r.stepIndex + 1}: ${escHtml(prevStep?.name || '')}</div>
            <div class="agent-input-step-body">${escHtml(r.output)}</div>
            ${r.pmNotes ? `<div class="agent-input-step-pm">PM: ${escHtml(r.pmNotes)}</div>` : ''}
          </div>`;
        }).join('')
    : '';

  return `<div class="detail-run-view">
    ${handoverHtml}
    <div class="run-status-row">
      <span class="status-pill status-pill-${sr.status}">${sr.status.toUpperCase()}</span>
      ${sr.retryCount > 0 ? `<span class="run-retry-badge">retry #${sr.retryCount}</span>` : ''}
    </div>
    ${prevOutputs ? `
    <div class="detail-run-section">
      <div class="detail-run-label">Input from previous steps</div>
      <div class="agent-input-wrap">${prevOutputs}</div>
    </div>` : ''}
    <div class="detail-run-section">
      <div class="detail-run-label">Agent output</div>
      <div class="detail-run-output" id="run-out-${step.stepIndex}">${sr.output ? marked.parse(sr.output) : (sr.status === 'running' || sr.status === 'reviewing' ? '…generating…' : '')}</div>
    </div>
    ${sr.pmNotes ? `
    <div class="detail-run-section">
      <div class="detail-run-label">PM notes</div>
      <div class="detail-run-notes">${escHtml(sr.pmNotes)}</div>
    </div>` : ''}
    ${sr.qaVerdict === 'fail' ? `
    <div class="detail-run-section">
      <div class="detail-run-label detail-run-fail-label">QA fail reason</div>
      <div class="detail-run-notes detail-run-fail">${escHtml(sr.qaReason || '')}</div>
    </div>` : ''}
  </div>`;
}

// ── Run execution ─────────────────────────────────────────────────────────────

function showRunBar() {
  pipeRunStartTime = Date.now();
  const bar = document.getElementById('pipe-run-bar');
  if (bar) bar.classList.remove('hidden');
  const name = document.getElementById('pipe-run-bar-name');
  if (name) name.textContent = '● Live run';
  pipeRunBarInterval = setInterval(() => {
    const s = Math.floor((Date.now() - pipeRunStartTime) / 1000);
    const el = document.getElementById('pipe-run-bar-elapsed');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function updateRunBar(stepIndex, stepName, phase) {
  const total = activePipe?.steps?.length ?? '?';
  const prog = document.getElementById('pipe-run-bar-progress');
  const ph   = document.getElementById('pipe-run-bar-phase');
  const step = document.getElementById('pipe-run-bar-step');
  if (prog) prog.textContent = `Step ${stepIndex + 1} / ${total}`;
  if (ph)   ph.textContent   = phase ? `· ${phase}` : '';
  if (step) step.textContent = stepName || '';
}

function hideRunBar() {
  clearInterval(pipeRunBarInterval);
  pipeRunBarInterval = null;
  document.getElementById('pipe-run-bar')?.classList.add('hidden');
}

// ── Stick-to-bottom log scrolling ─────────────────────────────────────────────
// Auto-scrolls a log container only while the user is pinned to its bottom.
// If they scroll up, new output leaves them alone and a "↓ New output" pill
// appears; clicking it (or scrolling back down) re-pins.
const _stickyLogs = {};   // container id → { el, pinned, pill }

function _stickyState(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  let s = _stickyLogs[id];
  if (!s) {
    s = _stickyLogs[id] = { el, pinned: true, pill: null };
    el.addEventListener('scroll', () => {
      s.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (s.pinned && s.pill) { s.pill.remove(); s.pill = null; }
    });
  }
  return s;
}

function logAutoScroll(id) {
  const s = _stickyState(id);
  if (!s) return;
  if (s.pinned) { s.el.scrollTop = s.el.scrollHeight; return; }
  if (s.pill || !s.el.parentElement) return;
  const pill = document.createElement('button');
  pill.className = 'log-new-pill';
  pill.textContent = '↓ New output';
  pill.addEventListener('click', () => {
    s.pinned = true;
    s.el.scrollTop = s.el.scrollHeight;
    if (s.pill) { s.pill.remove(); s.pill = null; }
  });
  s.el.parentElement.appendChild(pill);
  s.pill = pill;
}

// Call when a log is cleared or a new run starts
function logScrollReset(id) {
  const s = _stickyState(id);
  if (!s) return;
  s.pinned = true;
  if (s.pill) { s.pill.remove(); s.pill = null; }
}

// ── Throttled markdown streaming ──────────────────────────────────────────────
// Streams re-parse their whole accumulated markdown on every chunk; at 100+ KB
// that floods the main thread. Batch renders on a short timer instead.
const _mdQueue = new Map();   // key → { el, text, scrollId }
let _mdTimer = null;

function scheduleMdRender(key, el, text, scrollId) {
  _mdQueue.set(key, { el, text, scrollId });
  if (!_mdTimer) _mdTimer = setTimeout(_flushMdRenders, 150);
}

function _flushMdRenders() {
  _mdTimer = null;
  const scrollIds = new Set();
  for (const { el, text, scrollId } of _mdQueue.values()) {
    if (el?.isConnected) {
      el.innerHTML = marked.parse(text);
      if (scrollId) scrollIds.add(scrollId);
    }
  }
  _mdQueue.clear();
  scrollIds.forEach(logAutoScroll);
}

// Once a live stream grows past this, freeze its head into its own element so
// content-visibility can skip it and only the tail keeps getting re-parsed.
const STREAM_SEAL_CHARS = 16384;

function sealStream(el, text) {
  if (!el || text.length < STREAM_SEAL_CHARS) return null;
  let idx = text.lastIndexOf('\n\n');
  // huge single paragraph: fall back to any newline rather than growing forever
  if (idx < STREAM_SEAL_CHARS / 2 && text.length > STREAM_SEAL_CHARS * 4)
    idx = text.lastIndexOf('\n');
  if (idx < STREAM_SEAL_CHARS / 2) return null;
  const head = text.slice(0, idx);
  if ((head.match(/```/g) || []).length % 2) return null;  // open code fence — wait
  el.innerHTML = marked.parse(head);
  const cont = document.createElement('div');
  cont.className = el.className;
  el.after(cont);
  return { el: cont, text: text.slice(idx).replace(/^\n+/, '') };
}

function showThinkPanel() {
  const panel = document.getElementById('pipe-think');
  if (!panel) return;
  panel.classList.remove('hidden');
  document.getElementById('pipe-think-split')?.classList.remove('hidden');
  const log = document.getElementById('pipe-think-log');
  if (log) log.innerHTML = '';
  logScrollReset('pipe-think-log');
  pipeThinkStreamEl = null;
  pipeThinkStreamText = '';
}

function hideThinkPanel() {
  document.getElementById('pipe-think')?.classList.add('hidden');
  document.getElementById('pipe-think-split')?.classList.add('hidden');
  pipeThinkStreamEl = null;
  pipeThinkStreamText = '';
}

function appendThinkEntry(cls, html) {
  const log = document.getElementById('pipe-think-log');
  if (!log) return null;
  const div = document.createElement('div');
  div.className = `think-entry ${cls}`;
  div.innerHTML = html;
  log.appendChild(div);
  logAutoScroll('pipe-think-log');
  return div;
}

async function runPipeline() {
  if (!activePipe || pipeRunning) return;
  pipeRunning  = true;
  pipeCurrentRunId = null; pipeAwaitingRunId = null;
  pipeRunData  = (activePipe.steps || []).map(s => ({
    stepIndex: s.stepIndex, status: 'pending', output: '', handoverData: null, pmNotes: null,
    qaVerdict: null, qaReason: null, retryCount: 0,
  }));
  const runBtn = document.getElementById('pipe-run-btn');
  runBtn.textContent = '◼ Stop'; runBtn.title = 'Stop run';
  setPipeViewMode('run');
  showRunBar();
  showThinkPanel();
  appendThinkEntry('think-run-start', '▶ Run started');
  updateRunBar(0, activePipe.steps?.[0]?.name, 'starting');

  pipeRunAbort = new AbortController();
  try {
    // Enqueue the job, get back a jobId
    const enqueue = await fetch(`/api/pipelines/${activePipe.id}/run`, {
      method: 'POST', signal: pipeRunAbort.signal,
    });
    const { jobId, error } = await enqueue.json();
    if (error) { console.error('Pipeline enqueue error:', error); stopPipeRun(); return; }
    pipeActiveJobId = jobId;

    // Stream events from the worker via the job's SSE endpoint
    await _streamJobSSE(jobId);
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Pipeline run error:', e);
  } finally {
    stopPipeRun();
  }
}

async function _streamJobSSE(jobId) {
  const resp = await fetch(`/api/jobs/${jobId}/stream`, { signal: pipeRunAbort.signal });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { handlePipeEvent(JSON.parse(line.slice(6))); } catch (_) {}
      }
    }
  }
}

async function maybeReconnectRunningJob(active) {
  if (!activePipe || pipeRunning) return;
  if (!active) {
    const jobs = await api('GET', `/api/jobs?pipeline_id=${activePipe.id}`);
    active = jobs?.find(j => j.status === 'running' || j.status === 'queued');
  }
  if (!active) return;

  pipeRunning  = true;
  pipeCurrentRunId = null; pipeAwaitingRunId = null;
  pipeRunData  = (activePipe.steps || []).map(s => ({
    stepIndex: s.stepIndex, status: 'pending', output: '', handoverData: null,
    pmNotes: null, qaVerdict: null, qaReason: null, retryCount: 0,
  }));
  const runBtn = document.getElementById('pipe-run-btn');
  runBtn.textContent = '◼ Stop'; runBtn.title = 'Stop run';
  setPipeViewMode('run');
  showRunBar();
  showThinkPanel();
  appendThinkEntry('think-run-start', '▶ Reconnected to running job');
  updateRunBar(0, activePipe.steps?.[0]?.name, active.status === 'queued' ? 'waiting' : 'starting');

  pipeActiveJobId = active.id;
  pipeRunAbort = new AbortController();
  try {
    await _streamJobSSE(active.id);
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Pipeline reconnect error:', e);
  } finally {
    stopPipeRun();
  }
}

function cancelPipeRun() {
  // Cancel the job server-side (worker checks between steps), then detach the stream
  if (pipeActiveJobId) {
    fetch(`/api/jobs/${pipeActiveJobId}/cancel`, { method: 'POST' }).catch(() => {});
  }
  stopPipeRun();
}

function stopPipeRun() {
  pipeActiveJobId = null;
  if (pipeRunAbort) { pipeRunAbort.abort(); pipeRunAbort = null; }
  pipeRunning = false;
  hideRunBar();
  const runBtn = document.getElementById('pipe-run-btn');
  if (runBtn) { runBtn.textContent = '▶ Run'; runBtn.title = 'Run pipeline'; }
  const addBtn = document.getElementById('pipe-add-step-btn');
  if (addBtn && activePipe) addBtn.disabled = pipeViewMode === 'run';
  // Refresh the sidebar run list; in run mode fall through to viewing the finished run
  if (activePipe && pipeViewMode === 'run') enterRunView();
  else refreshPipeRuns();
}

function appendFeedbackForm(runId) {
  const log = document.getElementById('pipe-think-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'think-entry think-feedback';
  div.innerHTML = `
    <div class="think-feedback-title">⟲ Run complete — review it. Feedback loops the whole pipe back to the start.</div>
    <textarea class="think-feedback-input" rows="3" placeholder="What should change? e.g. the export link is broken — fix it"></textarea>
    <div class="think-feedback-actions">
      <button class="btn-sm think-feedback-send">⟲ Send &amp; re-run</button>
      <button class="btn-sm think-feedback-approve">✓ Approve</button>
    </div>`;
  div.querySelector('.think-feedback-send').addEventListener('click', () =>
    submitRunFeedback(runId, div.querySelector('.think-feedback-input').value, div));
  div.querySelector('.think-feedback-approve').addEventListener('click', () => approveRun(runId, div));
  log.appendChild(div);
  logAutoScroll('pipe-think-log');
}

function handlePipeEvent(evt) {
  switch (evt.type) {
    case 'run_start':
      pipeCurrentRunId = evt.runId;
      pipeViewedRunId  = evt.runId;
      refreshPipeRuns();
      break;
    case 'feedback_run_start':
      appendThinkEntry('think-entry think-loop',
        `⟲ Revision ${evt.revision || ''} — user feedback: ${escHtml(evt.feedback || '')}`);
      break;
    case 'run_awaiting_feedback':
      pipeAwaitingRunId = evt.runId;
      setFeedbackNodeStatus('awaiting');
      appendFeedbackForm(evt.runId);
      refreshPipeRuns();
      if (pipeDetailId === '__feedback__') openPipeDetail('__feedback__');
      break;
    case 'step_start': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) { sr.status = 'running'; sr.retryCount = evt.retryCount || 0; }
      setNodeStatus(evt.stepIndex, 'running');
      const stepName = activePipe?.steps?.find(s => s.stepIndex === evt.stepIndex)?.name;
      updateRunBar(evt.stepIndex, stepName, 'running');

      // Think panel: handover entry + fresh stream area
      const prevSr   = evt.stepIndex > 0 ? pipeRunData?.find(r => r.stepIndex === evt.stepIndex - 1) : null;
      const prevStep = evt.stepIndex > 0 ? activePipe?.steps?.find(s => s.stepIndex === evt.stepIndex - 1) : null;
      const retryLabel = evt.retryCount > 0 ? ` <span style="color:#e8b84b">(retry #${evt.retryCount})</span>` : '';
      if (prevStep) {
        appendThinkEntry('think-handover', `
          <div class="think-handover-from">← ${escHtml(prevStep.name)}${prevStep.agentName ? ' · ' + escHtml(prevStep.agentName) : ''} handed over</div>
          <div class="think-handover-to">▶ Step ${evt.stepIndex + 1}: ${escHtml(evt.stepName || stepName || '')}${evt.agentName ? ' · ' + escHtml(evt.agentName) : ''}${retryLabel}</div>
        `);
      } else {
        appendThinkEntry('think-handover', `
          <div class="think-handover-to">▶ Step ${evt.stepIndex + 1}: ${escHtml(evt.stepName || stepName || '')}${evt.agentName ? ' · ' + escHtml(evt.agentName) : ''}${retryLabel}</div>
        `);
      }
      // Add live stream element
      const log = document.getElementById('pipe-think-log');
      if (log) {
        const streamDiv = document.createElement('div');
        streamDiv.className = 'think-stream';
        log.appendChild(streamDiv);
        pipeThinkStreamEl = streamDiv;
        pipeThinkStreamText = '';
        pipeThinkReasonEl = null;
        pipeThinkReasonText = '';
        logAutoScroll('pipe-think-log');
      }

      if (pipeDetailId) {
        const step = activePipe?.steps?.find(s => s.id === pipeDetailId);
        if (step?.stepIndex === evt.stepIndex) openPipeDetail(pipeDetailId);
      }
      break;
    }
    case 'step_done': {
      if (evt.diffRatio != null)
        appendThinkEntry('think-entry think-loop',
          `Δ Step ${evt.stepIndex + 1}: ~${Math.round(evt.diffRatio * 100)}% changed vs previous run`);
      setNodeStatus(evt.stepIndex, 'reviewing');
      const stepNameDone = activePipe?.steps?.find(s => s.stepIndex === evt.stepIndex)?.name;
      updateRunBar(evt.stepIndex, stepNameDone, 'reviewing');
      pipeThinkStreamEl = null;
      pipeThinkStreamText = '';
      pipeThinkReasonEl = null;
      pipeThinkReasonText = '';
      break;
    }
    case 'step_thinking': {
      // Model reasoning stream — shown dimmed in the think panel, never part of step output
      const log = document.getElementById('pipe-think-log');
      if (log && !pipeThinkReasonEl) {
        pipeThinkReasonEl = document.createElement('div');
        pipeThinkReasonEl.className = 'think-stream think-reasoning';
        pipeThinkReasonText = '';
        // Keep reasoning above the answer stream created at step_start
        if (pipeThinkStreamEl) log.insertBefore(pipeThinkReasonEl, pipeThinkStreamEl);
        else log.appendChild(pipeThinkReasonEl);
      }
      if (pipeThinkReasonEl) {
        pipeThinkReasonText += evt.chunk;
        const sealed = sealStream(pipeThinkReasonEl, pipeThinkReasonText);
        if (sealed) { pipeThinkReasonEl = sealed.el; pipeThinkReasonText = sealed.text; }
        scheduleMdRender('pipeReason', pipeThinkReasonEl, pipeThinkReasonText, 'pipe-think-log');
      }
      break;
    }
    case 'step_chunk': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) sr.output = (sr.output || '') + evt.chunk;
      const el = document.getElementById(`run-out-${evt.stepIndex}`);
      if (el) scheduleMdRender(`runOut${evt.stepIndex}`, el, sr?.output || '');
      // Stream into think panel
      if (pipeThinkStreamEl) {
        pipeThinkStreamText += evt.chunk;
        const sealed = sealStream(pipeThinkStreamEl, pipeThinkStreamText);
        if (sealed) { pipeThinkStreamEl = sealed.el; pipeThinkStreamText = sealed.text; }
        scheduleMdRender('pipeStream', pipeThinkStreamEl, pipeThinkStreamText, 'pipe-think-log');
      }
      break;
    }
    case 'tool_call': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) sr.output = (sr.output || '') + `\n[tool: ${evt.tool} → ${JSON.stringify(evt.result).slice(0, 120)}]\n`;
      const el = document.getElementById(`run-out-${evt.stepIndex}`);
      if (el) el.innerHTML = marked.parse(sr?.output || '');
      appendThinkEntry('think-entry think-tool', `🔧 ${escHtml(evt.tool)} → ${escHtml(JSON.stringify(evt.result).slice(0, 80))}`);
      break;
    }
    case 'pm_start': {
      setNodeStatus(evt.stepIndex, 'reviewing');
      appendThinkEntry('think-entry think-pm', '◈ PM reviewing…');
      break;
    }
    case 'pm_verdict': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      const ok = ['pass', 'done', 'iterate'].includes(evt.verdict);
      const status = ok ? 'done' : 'retry';
      if (sr) { sr.qaVerdict = evt.verdict; sr.qaReason = evt.reason; sr.pmNotes = evt.pmNotes; sr.status = status; }
      setNodeStatus(evt.stepIndex, status);
      const stepNameV = activePipe?.steps?.find(s => s.stepIndex === evt.stepIndex)?.name;
      updateRunBar(evt.stepIndex, stepNameV, ok ? 'done' : 'retrying');
      updatePmNodeReview(evt.verdict, ok ? (evt.pmNotes || evt.feedback || 'Passed') : (evt.reason || 'Failed'));
      const verdictCls = ok ? 'think-pm-pass' : 'think-pm-fail';
      const verdictIcon = evt.verdict === 'iterate' ? '↻' : ok ? '✓' : '✗';
      appendThinkEntry(`think-entry think-pm ${verdictCls}`, `◈ PM: ${verdictIcon} ${escHtml(evt.pmNotes || evt.feedback || evt.reason || evt.verdict)}`);
      if (pipeDetailId) {
        const step = activePipe?.steps?.find(s => s.id === pipeDetailId);
        if (step?.stepIndex === evt.stepIndex) openPipeDetail(pipeDetailId);
      }
      break;
    }
    case 'step_retry': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) { sr.status = 'retry'; sr.retryCount = evt.retryCount; }
      setNodeStatus(evt.stepIndex, 'retry');
      appendThinkEntry('think-entry think-pm think-pm-fail', `↺ Retrying step ${evt.stepIndex + 1} (#${evt.retryCount})${evt.reason ? ': ' + escHtml(evt.reason) : ''}`);
      break;
    }
    case 'feedback_triage': {
      const t = (evt.targets || []).map(n => n + 1).join(', ');
      const r = (evt.reused || []).map(n => n + 1).join(', ');
      appendThinkEntry('think-entry think-loop',
        `⊜ Feedback targets step(s) ${t || '?'}${r ? ` — reusing step(s) ${r} from previous run` : ''}`);
      break;
    }
    case 'step_reused': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) sr.status = 'reused';
      setNodeStatus(evt.stepIndex, 'done');
      appendThinkEntry('think-entry think-loop',
        `↩ Step ${evt.stepIndex + 1}${evt.stepName ? ' "' + escHtml(evt.stepName) + '"' : ''} reused from previous run`);
      break;
    }
    case 'step_skipped': {
      const sr = pipeRunData?.find(r => r.stepIndex === evt.stepIndex);
      if (sr) sr.status = 'failed';
      setNodeStatus(evt.stepIndex, 'failed');
      appendThinkEntry('think-entry think-run-fail', `⊘ Step ${evt.stepIndex + 1} skipped${evt.reason ? ': ' + escHtml(evt.reason) : ''}`);
      break;
    }
    case 'loop_iteration': {
      const score = evt.score != null ? ` — score ${evt.score}` : '';
      const fb    = evt.feedback ? ` — ${escHtml(evt.feedback)}` : '';
      appendThinkEntry('think-entry think-loop',
        `↻ Iteration ${evt.iteration + 1}/${evt.maxIterations}${score}${fb}`);
      const info = document.getElementById('pipe-loop-info');
      if (info) info.textContent = `Iteration ${evt.iteration + 1}/${evt.maxIterations}`;
      break;
    }
    case 'loop_done': {
      const why = { evaluator_done: 'evaluator satisfied', sentinel: 'sentinel found',
                    max_iterations: 'max iterations', stalled: 'no progress',
                    budget: 'budget spent' }[evt.reason] || evt.reason;
      appendThinkEntry('think-entry think-loop',
        `⊙ Loop finished after ${evt.iteration + 1} pass(es) — ${why}` +
        (evt.score != null ? ` (score ${evt.score})` : ''));
      break;
    }
    case 'run_cancelled':
      appendThinkEntry('think-entry think-run-fail', '✕ Run cancelled');
      break;
    // Legacy events — kept so old job logs still replay
    case 'loop_spawned': {
      appendThinkEntry('think-entry think-loop', `↻ Loop spawned (depth ${evt.depth})`);
      const info = document.getElementById('pipe-loop-info');
      if (info) info.textContent = `Loop #${evt.depth} queued`;
      break;
    }
    case 'loop_stopped':
    case 'loop_max_depth':
      appendThinkEntry('think-entry think-loop', `⊙ Loop stopped at depth ${evt.depth}`);
      break;
    case 'run_paused':
      setNodeStatus(evt.stepIndex, 'paused');
      appendThinkEntry('think-entry think-run-fail', `⏸ Paused: ${escHtml(evt.reason || '')}`);
      alert(`Pipeline paused at step ${evt.stepIndex + 1}:\n${evt.reason}`);
      break;
    case 'run_failed':
    case 'error':
      if (evt.reason || evt.message) console.warn('Pipeline:', evt.reason || evt.message);
      appendThinkEntry('think-run-fail', `✗ ${escHtml(evt.reason || evt.message || 'Failed')}`);
      break;
    case 'run_done':
      appendThinkEntry('think-run-done', '✓ Run complete');
      break;
  }
}

// ── Run replay ────────────────────────────────────────────────────────────────

async function loadRunReplay(runId) {
  const run = await api('GET', `/api/pipeline-runs/${runId}`);
  const stepRuns = run.stepRuns || [];
  applyRunStepData(run);
  pipeViewedRunId = runId;
  pipeDetailId = 'replay';
  setPipeViewMode('run');
  renderPipeRunList();
  const panel = document.getElementById('pipe-detail');
  const title = document.getElementById('pipe-detail-title');
  const body  = document.getElementById('pipe-detail-body');
  panel?.classList.remove('hidden');
  title.textContent = runLabel(run) || `Run · ${(run.startedAt||'').slice(0,16).replace('T',' ')}`;
  // Group by iteration; scores from the anchor's qa data make convergence visible
  const iters = [...new Set(stepRuns.map(sr => sr.iteration || 0))].sort((a, b) => a - b);
  const rows = iters.map(it => {
    const group  = stepRuns.filter(sr => (sr.iteration || 0) === it);
    const header = iters.length > 1 ? `<div class="run-iter-header">Iteration ${it + 1}</div>` : '';
    return header + group.map(sr => `
      <div class="run-step-row"${iters.length > 1 ? ' style="padding-left:12px"' : ''}>
        <span class="status-pill status-pill-${sr.status}">${sr.status}</span>
        <span>Step ${sr.stepIndex + 1}: ${escHtml(sr.stepName)}</span>
        <button class="btn-sm run-step-btn" data-idx="${sr.stepIndex}">View</button>
      </div>`).join('');
  }).join('');
  // Feedback stays available on any finished run — it loops the whole pipe back to the start
  const finished = !['running', 'pending'].includes(run.status);
  const feedbackHtml = finished ? `
    <div class="detail-field">
      <label>Feedback on this run <span class="label-hint">all agents + the PM re-run from the start block with it</span></label>
      <textarea id="rr-fb-text" rows="3" placeholder="What should change? e.g. the export link is broken — fix it"></textarea>
    </div>
    <div class="detail-actions">
      <button id="rr-fb-send" class="btn-primary">⟲ Send &amp; re-run</button>
      ${run.status === 'awaiting_feedback' ? '<button id="rr-fb-approve">✓ Approve run</button>' : ''}
    </div>` : '';
  body.innerHTML = `<div class="detail-form">
    ${rows}
    ${feedbackHtml}
  </div>`;
  body.querySelectorAll('.run-step-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const step = activePipe?.steps?.find(s => s.stepIndex === +btn.dataset.idx);
      if (step) openPipeDetail(step.id);
    })
  );
  document.getElementById('rr-fb-send')?.addEventListener('click', () =>
    submitRunFeedback(runId, document.getElementById('rr-fb-text')?.value));
  document.getElementById('rr-fb-approve')?.addEventListener('click', async () => {
    await approveRun(runId);
    loadRunReplay(runId);
  });
}

// ── Job tree (loop run history) ───────────────────────────────────────────────

async function showJobTree() {
  if (!activePipe) return;
  pipeDetailId = 'jobs';
  const panel = document.getElementById('pipe-detail');
  const title = document.getElementById('pipe-detail-title');
  const body  = document.getElementById('pipe-detail-body');
  panel.classList.remove('hidden');
  title.textContent = 'Job history';
  body.innerHTML = '<div class="detail-loading">Loading…</div>';
  try {
    const jobs = await api('GET', `/api/jobs?pipeline_id=${activePipe.id}`);
    if (!jobs.length) { body.innerHTML = '<div class="detail-run-empty">No jobs yet.</div>'; return; }

    // Build tree: root jobs (no parent) and their children
    const roots = jobs.filter(j => !j.parent_job_id);
    const active = new Set(['queued', 'running', 'cancelling']);

    function jobRow(j, indent) {
      const pad    = '&nbsp;'.repeat(indent * 4);
      const dur    = j.finished_at && j.started_at
        ? Math.round((new Date(j.finished_at) - new Date(j.started_at)) / 1000) + 's'
        : j.status === 'running' ? 'running…' : '–';
      const label  = j.loop_depth > 0 ? `Loop #${j.loop_depth}` : 'Run';
      const ts     = (j.created_at || '').slice(0, 16).replace('T', ' ');
      const delBtn = active.has(j.status) ? '' :
        `<button class="btn-sm job-del-btn" data-job-id="${j.id}" title="Delete this run">🗑</button>`;
      return `<div class="job-tree-row" data-depth="${j.loop_depth}">
        <span class="status-pill status-pill-${j.status}">${j.status}</span>
        ${pad}<span class="job-tree-label">${label}</span>
        <span class="job-tree-ts">${ts}</span>
        <span class="job-tree-dur">${dur}</span>
        ${j.error ? `<span class="job-tree-err" title="${escHtml(j.error)}">⚠</span>` : ''}
        ${delBtn}
      </div>`;
    }

    function buildTree(parent, indent) {
      let html = jobRow(parent, indent);
      jobs.filter(j => j.parent_job_id === parent.id)
          .forEach(child => { html += buildTree(child, indent + 1); });
      return html;
    }

    body.innerHTML = `
      <div class="detail-actions"><button id="jobs-del-all-btn" class="btn-danger">Delete all runs</button></div>
      <div class="job-tree">${roots.map(r => buildTree(r, 0)).join('')}</div>`;
    body.querySelectorAll('.job-del-btn').forEach(btn =>
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete this run?')) return;
        await api('DELETE', `/api/jobs/${btn.dataset.jobId}`);
        showJobTree();
      })
    );
    document.getElementById('jobs-del-all-btn')?.addEventListener('click', async () => {
      if (!confirm('Delete all run history for this pipeline?')) return;
      await api('DELETE', `/api/jobs?pipeline_id=${activePipe.id}`);
      showJobTree();
    });
  } catch (e) {
    body.innerHTML = `<div class="detail-run-empty">Error: ${escHtml(e.message)}</div>`;
  }
}

// ── Pipeline event listeners ──────────────────────────────────────────────────

document.getElementById('pipe-new-btn').addEventListener('click', createPipeline);
document.getElementById('pipe-run-btn').addEventListener('click', () => pipeRunning ? cancelPipeRun() : runPipeline());
document.getElementById('pipe-add-step-btn').addEventListener('click', addPipeStep);
document.getElementById('pipe-fit-btn').addEventListener('click', fitPipeCanvas);
document.getElementById('pipe-runs-btn').addEventListener('click', showJobTree);
document.getElementById('pipe-back-btn').addEventListener('click', () => setPipeSidebarView('list'));
document.getElementById('pipe-runs-del-btn').addEventListener('click', async () => {
  if (!activePipe || !confirm('Delete all run history for this pipeline?')) return;
  await api('DELETE', `/api/pipelines/${activePipe.id}/runs`);
  pipeViewedRunId = null;
  if (pipeDetailId === 'replay') closePipeDetail();
  refreshPipeRuns();
});
document.getElementById('pipe-settings-btn').addEventListener('click', () => openPipeDetail('settings'));
document.getElementById('pipe-detail-close').addEventListener('click', closePipeDetail);
document.getElementById('pipe-mode-edit').addEventListener('click', () => {
  if (activePipe && pipeViewMode !== 'edit') setPipeViewMode('edit');
});
document.getElementById('pipe-mode-run').addEventListener('click', () => {
  if (activePipe && pipeViewMode !== 'run') enterRunView();
});

const THINK_SPLIT_KEY = 'pipeThinkWidth';

// Vertical splitter between the canvas area and the Live output panel
(function initThinkSplit() {
  const handle = document.getElementById('pipe-think-split');
  const panel  = document.getElementById('pipe-think');
  if (!handle || !panel) return;

  const saved = parseFloat(localStorage.getItem(THINK_SPLIT_KEY));
  if (!isNaN(saved) && saved >= 240) panel.style.width = `${saved}px`;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      const host = panel.parentElement.getBoundingClientRect();
      let w = host.right - ev.clientX;
      w = Math.min(host.width * 0.7, Math.max(240, w));
      panel.style.width = `${w}px`;
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      const w = parseFloat(panel.style.width);
      if (!isNaN(w)) localStorage.setItem(THINK_SPLIT_KEY, w);
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
})();

// ── Brain ─────────────────────────────────────────────────────────────────────

let brainThread      = null;
let brainAbort       = null;
let brainBusy        = false;
let brainAutoAccept  = false;

const API_REFERENCE = [
  { method: 'GET',    path: '/api/settings',             group: 'settings' },
  { method: 'POST',   path: '/api/settings',             group: 'settings' },
  { method: 'GET',    path: '/api/agents',               group: 'agents' },
  { method: 'POST',   path: '/api/agents',               group: 'agents' },
  { method: 'PUT',    path: '/api/agents/:id',           group: 'agents' },
  { method: 'DELETE', path: '/api/agents/:id',           group: 'agents' },
  { method: 'GET',    path: '/api/threads',              group: 'threads' },
  { method: 'POST',   path: '/api/threads',              group: 'threads' },
  { method: 'PUT',    path: '/api/threads/:id',          group: 'threads' },
  { method: 'DELETE', path: '/api/threads/:id',          group: 'threads' },
  { method: 'GET',    path: '/api/threads/:id/messages', group: 'threads' },
  { method: 'POST',   path: '/api/threads/:id/messages', group: 'threads' },
  { method: 'DELETE', path: '/api/threads/:id/messages', group: 'threads' },
  { method: 'GET',    path: '/api/tasks',                group: 'tasks' },
  { method: 'POST',   path: '/api/tasks',                group: 'tasks' },
  { method: 'PUT',    path: '/api/tasks/:id',            group: 'tasks' },
  { method: 'DELETE', path: '/api/tasks/:id',            group: 'tasks' },
  { method: 'GET',    path: '/api/tasks/:id/runs',       group: 'tasks' },
  { method: 'POST',   path: '/api/tasks/:id/runs',       group: 'tasks' },
  { method: 'GET',    path: '/api/activity?days=N',      group: 'activity' },
  { method: 'GET',    path: '/api/plans',                group: 'plans' },
  { method: 'GET',    path: '/api/plans/:name',          group: 'plans' },
  { method: 'POST',   path: '/api/plans/:name',          group: 'plans' },
  { method: 'DELETE', path: '/api/plans/:name',          group: 'plans' },
  { method: 'GET',    path: '/api/brain/status',         group: 'brain' },
  { method: 'GET',    path: '/api/export',               group: 'data' },
  { method: 'POST',   path: '/api/import',               group: 'data' },
  { method: 'DELETE', path: '/api/data',                 group: 'data' },
];

const DEFAULT_BRAIN_PRE_PROMPT =
`You are the Brain — the central AI assistant for a local Ollama automation platform. You help the user manage and operate the system: creating agents, scheduling tasks, writing plans, and working with files.

## What this system can do
- **Agents** — AI personas with a custom model, system prompt, optional file workspace, and optional web access
- **Tasks** — automated prompts that run on a schedule (daily, weekly, monthly, or cron) using any agent
- **Plans** — markdown strategy documents that can be broken into tasks
- **Chat** — multi-thread conversations with any model or agent
- **Files** — agents with file access can read/write their own zone and the shared projects/ workspace
- **Web** — agents with web access can search and fetch URLs (DuckDuckGo search, HTTP fetch with HTML stripping)
- **You (Brain)** — have full file access (projects/ + all agent zones) and full web access`;

function buildBrainSystemPrompt(status) {
  const agentLines = status.agents?.length
    ? status.agents.map(a => {
        const caps = [
          a.fileAccess ? `files: agent_zones/${a.id}/` : '',
          a.webAccess  ? 'web'  : '',
        ].filter(Boolean).join(', ');
        return `  - "${a.name}"  id: ${a.id}  model: ${a.model || '—'}${caps ? `  [${caps}]` : ''}` +
               (a.systemPrompt ? `\n    purpose: ${a.systemPrompt.slice(0, 120)}` : '');
      }).join('\n')
    : '  (none)';

  const taskLines = status.tasks?.length
    ? status.tasks.map(t => {
        const s = t.schedule || {};
        const sched = s.type && s.type !== 'manual'
          ? `${s.type}${s.time ? ' @ ' + s.time : ''}`
          : 'manual';
        const agent = status.agents?.find(a => a.id === t.agentId);
        return `  - "${t.name}"  [${sched}]${agent ? '  agent: ' + agent.name : ''}`;
      }).join('\n')
    : '  (none)';

  const planLines = status.plans?.length
    ? status.plans.map(p => `  - ${p.replace(/\.md$/, '')}`).join('\n')
    : '  (none)';

  // File workspace listings
  const projectFiles = status.projectFiles?.length
    ? status.projectFiles.map(f => `  - ${f}`).join('\n')
    : '  (empty)';

  const agentZoneBlocks = status.agents?.filter(a => a.fileAccess).map(a => {
    const files = status.agentZoneFiles?.[a.id];
    const listing = files?.length ? files.map(f => `    - ${f}`).join('\n') : '    (empty)';
    return `  agent_zones/${a.id}/  (${a.name})\n${listing}`;
  }).join('\n') || '  (no agents with file access)';

  const intro = settings.brainPrePrompt?.trim() || DEFAULT_BRAIN_PRE_PROMPT;

  return `${intro}

## Agents (${status.agents?.length ?? 0})
${agentLines}

## Tasks (${status.tasks?.length ?? 0})
${taskLines}

## Plans
${planLines}

## Stats
Threads: ${status.threadCount ?? 0} · Messages: ${status.messageCount ?? 0} · Task runs: ${status.runCount ?? 0}

## File workspaces
projects/
${projectFiles}

${agentZoneBlocks}

## Actions
Emit a fenced \`\`\`action block with a JSON object to propose a change. The user sees a confirmation card and must click Confirm before anything executes.

Create agent:
\`\`\`action
{"type":"create_agent","name":"Name","model":"llama3.1:8b","systemPrompt":"You are...","temperature":0.7,"fileAccess":false}
\`\`\`

Create task:
\`\`\`action
{"type":"create_task","name":"Name","model":"llama3.1:8b","agentId":"<id-or-null>","promptTemplate":"Do X on {{date}}.","schedule":{"type":"daily","time":"08:00"}}
\`\`\`
Schedule options: {"type":"manual"} | {"type":"daily","time":"HH:MM"} | {"type":"weekly","day":0-6,"time":"HH:MM"} | {"type":"monthly","monthDay":1-31,"time":"HH:MM"}

Create plan:
\`\`\`action
{"type":"create_plan","name":"Name","content":"# Plan\\n\\n..."}
\`\`\`

Write file (projects/):
\`\`\`action
{"type":"write_file","scope":"project","path":"subfolder/file.md","content":"..."}
\`\`\`

Write file (agent zone):
\`\`\`action
{"type":"write_file","scope":"agent_zone","agentId":"<exact-id>","path":"notes/file.md","content":"..."}
\`\`\`

List files:
\`\`\`action
{"type":"list_files","scope":"project"}
\`\`\`
\`\`\`action
{"type":"list_files","scope":"agent_zone","agentId":"<exact-id>"}
\`\`\`

Web search (DuckDuckGo):
\`\`\`action
{"type":"web_search","query":"your search terms"}
\`\`\`

Fetch a URL (returns cleaned text, private IPs blocked):
\`\`\`action
{"type":"web_fetch","url":"https://example.com/page"}
\`\`\`

Rules:
- Always briefly explain what you're about to do before each block.
- Use exact agent ids from the list above.
- For write_file / list_files: only for agents with fileAccess (Brain always can).
- For web_search / web_fetch: only for agents with webAccess (Brain always can). Private IPs are blocked server-side.
- After web results are fetched the user clicks "Send to chat" before you see the content — wait for that.
- Keep responses concise and practical.`
  + (brainAutoAccept
    ? '\n\n## Auto-accept mode is ON\nEvery action block you emit will execute immediately without manual confirmation. Act directly — write files, create agents, create tasks — without hedging or asking permission. Emit the action block and it will run.'
    : '');
}

async function initBrain() {
  if (!brainThread) {
    brainThread = state.threads.find(t => t.name === '__brain__') || null;
    if (!brainThread) {
      const t = { id: uid(), name: '__brain__', model: '', agentId: null, systemPrompt: '', messages: [] };
      state.threads.push(t);
      brainThread = t;
      await api('POST', '/api/threads', t).catch(() => {});
    }
    initBrainModelSelect();
  }
  renderBrainChat();
  loadBrainPanel();
}

function initBrainModelSelect() {
  const sel = document.getElementById('brain-model-select');
  if (!sel || !models.length) return;
  sel.innerHTML = models.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  const preferred = state.model;
  if (preferred && models.includes(preferred)) sel.value = preferred;
}

function renderBrainChat() {
  const win = document.getElementById('brain-chat-window');
  if (!win || !brainThread) return;
  win.innerHTML = '';
  const msgs = brainThread.messages.filter(m => m.role !== 'system');
  if (!msgs.length) {
    win.innerHTML = '<p class="brain-empty">Ask anything about this system — its APIs, data, architecture, or current state.</p>';
    return;
  }
  msgs.forEach(m => appendBrainMsgEl(win, m.role, m.content));
  win.scrollTop = win.scrollHeight;
}

function appendBrainMsgEl(win, role, content) {
  const div = document.createElement('div');
  div.className = `brain-msg brain-msg-${role}`;
  if (role === 'assistant') {
    div.innerHTML = marked.parse(content || '');
  } else {
    div.textContent = content || '';
  }
  win.appendChild(div);
  return div;
}

async function sendBrainMessage(overrideContent) {
  if (brainBusy || !brainThread) return;
  const input = document.getElementById('brain-input');
  const text  = overrideContent ?? input.value.trim();
  if (!text) return;

  const model = document.getElementById('brain-model-select')?.value || models[0] || '';
  if (!model) { alert('No model selected'); return; }

  if (!overrideContent) {
    input.value = '';
    input.style.height = 'auto';
  }
  brainBusy = true;
  document.getElementById('brain-send-btn').disabled    = true;
  document.getElementById('brain-abandon-btn').hidden   = false;

  const userMsg = { id: uid(), role: 'user', content: text };
  brainThread.messages.push(userMsg);
  api('POST', `/api/threads/${brainThread.id}/messages`, userMsg).catch(() => {});

  const win = document.getElementById('brain-chat-window');
  win.querySelector('.brain-empty')?.remove();
  appendBrainMsgEl(win, 'user', text);
  win.scrollTop = win.scrollHeight;

  // Fetch fresh status to build up-to-date system prompt
  let status = {};
  try { status = await api('GET', '/api/brain/status'); } catch (_) {}

  const apiMessages = [
    { role: 'system', content: buildBrainSystemPrompt(status) },
    ...brainThread.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content })),
  ];

  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'brain-msg brain-msg-assistant';
  win.appendChild(assistantDiv);

  brainAbort = new AbortController();
  let full = '';
  let tokens = 0;

  // Brain always has files + web tools
  const brainToolPerms = { files: true, web: true };
  const brainTools     = buildTools(brainToolPerms);

  try {
    let looping = true;
    while (looping) {
      looping = false;
      const body = { model, messages: apiMessages, stream: true, options: { num_ctx: 8192 } };
      if (brainTools.length) body.tools = brainTools;

      const resp = await fetch(`${await resolveOllama()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: brainAbort.signal,
      });
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let turnToolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.tool_calls?.length) turnToolCalls.push(...chunk.message.tool_calls);
            full   += chunk.message?.content || '';
            tokens  = chunk.eval_count || tokens;
            assistantDiv.innerHTML = marked.parse(full);
            win.scrollTop = win.scrollHeight;
          } catch (_) {}
        }
      }

      if (turnToolCalls.length > 0) {
        renderToolCallBubble(win, turnToolCalls);
        apiMessages.push({ role: 'assistant', content: '', tool_calls: turnToolCalls });
        for (const tc of turnToolCalls) {
          const result = await executeTool(tc.function.name, tc.function.arguments ?? {});
          renderToolResultBubble(win, tc.function.name, result);
          apiMessages.push({ role: 'tool', content: String(result) });
        }
        full = '';
        assistantDiv.innerHTML = '';
        looping = true;
      }
    }
    // After stream: replace with action-card-aware render
    renderWithActions(assistantDiv, full);
    win.scrollTop = win.scrollHeight;
  } catch (e) {
    if (e.name !== 'AbortError') assistantDiv.textContent = `Error: ${e.message}`;
  }

  const assistantMsg = { id: uid(), role: 'assistant', content: full, tokens };
  brainThread.messages.push(assistantMsg);
  api('POST', `/api/threads/${brainThread.id}/messages`, assistantMsg).catch(() => {});

  brainAbort = null;
  brainBusy  = false;
  document.getElementById('brain-send-btn').disabled  = false;
  document.getElementById('brain-abandon-btn').hidden = true;
}

async function loadBrainPanel() {
  const body = document.getElementById('brain-panel-body');
  if (!body) return;
  body.innerHTML = '<p class="brain-empty" style="padding:12px 14px">Loading…</p>';

  let status = {};
  try { status = await api('GET', '/api/brain/status'); } catch (e) {
    body.innerHTML = `<p class="brain-empty" style="padding:12px 14px">Could not load: ${escHtml(e.message)}</p>`;
    return;
  }

  // Build API reference grouped by group
  const groups = {};
  API_REFERENCE.forEach(e => {
    if (!groups[e.group]) groups[e.group] = [];
    groups[e.group].push(e);
  });
  const apiHtml = Object.entries(groups).map(([grp, entries]) => `
    <div class="brain-api-group">
      <div class="brain-api-group-hdr">${escHtml(grp)}</div>
      ${entries.map(e => `
        <div class="brain-api-entry">
          <span class="brain-method brain-method-${e.method.toLowerCase()}">${escHtml(e.method)}</span>
          <span class="brain-path">${escHtml(e.path)}</span>
        </div>`).join('')}
    </div>`).join('');

  // Build DB overview
  const counts = [
    ['Agents',    status.agents?.length    ?? '—'],
    ['Tasks',     status.tasks?.length     ?? '—'],
    ['Threads',   status.threadCount       ?? '—'],
    ['Messages',  status.messageCount      ?? '—'],
    ['Task runs', status.runCount          ?? '—'],
    ['Plans',     status.plans?.length     ?? '—'],
  ];
  const countsHtml = `<div class="brain-db-counts">${
    counts.map(([l, n]) =>
      `<div class="brain-db-count"><span>${l}</span><span class="brain-db-count-n">${n}</span></div>`
    ).join('')
  }</div>`;

  const agentsHtml = status.agents?.length ? `
    <div class="brain-db-group-hdr">Agents</div>
    ${status.agents.map(a => `
      <div class="brain-db-item">
        <span class="brain-db-name">${escHtml(a.name)}</span>
        <span class="brain-db-sub">${escHtml(a.model || '—')}</span>
      </div>`).join('')}` : '';

  const tasksHtml = status.tasks?.length ? `
    <div class="brain-db-group-hdr">Tasks</div>
    ${status.tasks.map(t => {
      const s     = t.schedule || {};
      const sched = s.type && s.type !== 'manual' ? s.type : 'manual';
      return `<div class="brain-db-item">
        <span class="brain-db-name">${escHtml(t.name)}</span>
        <span class="brain-db-sub">${escHtml(sched)}</span>
      </div>`;
    }).join('')}` : '';

  const plansHtml = status.plans?.length ? `
    <div class="brain-db-group-hdr">Plans</div>
    ${status.plans.map(p =>
      `<div class="brain-db-item brain-db-item-plan">${escHtml(p.replace(/\.md$/, ''))}</div>`
    ).join('')}` : '';

  body.innerHTML = `
    <details class="brain-section-details" open>
      <summary class="brain-section-hdr">API Reference</summary>
      <div class="brain-api-list">${apiHtml}</div>
    </details>
    <details class="brain-section-details" open>
      <summary class="brain-section-hdr">Database</summary>
      <div class="brain-db-list">${countsHtml}${agentsHtml}${tasksHtml}${plansHtml}</div>
    </details>`;
}

document.getElementById('brain-auto-btn').addEventListener('click', () => {
  brainAutoAccept = !brainAutoAccept;
  const btn = document.getElementById('brain-auto-btn');
  btn.classList.toggle('active', brainAutoAccept);
  btn.title = brainAutoAccept ? 'Auto-accept: ON — actions execute immediately' : 'Auto-accept actions (off)';
});

document.getElementById('brain-send-btn').addEventListener('click', sendBrainMessage);
document.getElementById('brain-abandon-btn').addEventListener('click', () => brainAbort?.abort());
document.getElementById('brain-clear-btn').addEventListener('click', async () => {
  if (!brainThread || !confirm('Clear brain chat history?')) return;
  brainThread.messages = [];
  api('DELETE', `/api/threads/${brainThread.id}/messages`).catch(() => {});
  renderBrainChat();
});
document.getElementById('brain-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBrainMessage(); }
});
document.getElementById('brain-input').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

// ── Code ──────────────────────────────────────────────────────────────────────

let codeSession  = null;
let monacoEditor = null;
let codeAutoAccept = false;
let codeAbort    = null;
let codeBusy     = false;

function switchCodeMode(mode) {
  const vsPanel   = document.getElementById('code-vscode-panel');
  const monacoWrap = document.getElementById('code-monaco-wrap');
  document.querySelectorAll('.code-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'vscode') {
    vsPanel.style.display    = 'flex';
    monacoWrap.style.display = 'none';
    const frame = document.getElementById('code-server-frame');
    if (!frame.getAttribute('src')) frame.src = settings.codeServerUrl || 'http://localhost:5001';
  } else {
    vsPanel.style.display    = 'none';
    monacoWrap.style.display = 'flex';
  }
}

document.querySelectorAll('.code-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchCodeMode(btn.dataset.mode));
});

async function initCode() {
  switchCodeMode('monaco');
  await loadCodeSession();
  refreshCodeSelects();
  initMonaco();
  renderFileTree();
}

async function loadCodeSession() {
  try {
    const s = await api('GET', '/api/code-session');
    codeSession = { root_path: '/home/viktor/library/projects', open_files: [], active_file: null, ...s };
    if (typeof codeSession.open_files === 'string') codeSession.open_files = JSON.parse(codeSession.open_files || '[]');
  } catch (_) {
    codeSession = { root_path: '/home/viktor/library/projects', open_files: [], active_file: null };
  }
  const lbl = document.getElementById('code-root-label');
  if (lbl) { lbl.textContent = codeSession.root_path.split('/').pop() || '/'; lbl.title = codeSession.root_path; }
  renderCodeTabs();
}

function saveCodeSession() {
  if (!codeSession) return;
  api('PUT', '/api/code-session', {
    rootPath:   codeSession.root_path,
    openFiles:  codeSession.open_files || [],
    activeFile: codeSession.active_file || null,
  }).catch(() => {});
}

function initMonaco() {
  if (monacoEditor) {
    if (codeSession?.active_file) _monacoOpenFile(codeSession.active_file);
    return;
  }
  if (!window.require) return;
  require(['vs/editor/editor.main'], () => {
    monaco.editor.defineTheme('app-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: { 'editor.background': '#141414', 'editor.lineHighlightBackground': '#1c1c1c' },
    });
    monacoEditor = monaco.editor.create(document.getElementById('monaco-container'), {
      value: '', language: 'plaintext', theme: 'app-dark',
      fontSize: 13, fontFamily: "'Fira Code','Cascadia Code',Consolas,monospace",
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      wordWrap: 'off', automaticLayout: true, renderLineHighlight: 'line',
    });
    monacoEditor.onDidChangeCursorPosition(() => {
      const p = monacoEditor.getPosition();
      const lbl = document.getElementById('code-pos-label');
      if (lbl) lbl.textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
    });
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
    if (codeSession?.active_file) _monacoOpenFile(codeSession.active_file);
  });
}

async function _monacoOpenFile(path) {
  try {
    const r = await api('GET', `/api/fs/read?path=${encodeURIComponent(path)}`);
    if (r.error || !monacoEditor) return;
    const lang = detectLang(path);
    monacoEditor.setModel(monaco.editor.createModel(r.content ?? '', lang));
    const lbl = document.getElementById('code-lang-label');
    if (lbl) lbl.textContent = lang;
  } catch (_) {}
}

function refreshMonacoContent(content) {
  if (!monacoEditor) return;
  const pos = monacoEditor.getPosition();
  monacoEditor.setValue(content ?? '');
  if (pos) monacoEditor.setPosition(pos);
}

function detectLang(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return { js:'javascript', ts:'typescript', tsx:'typescript', jsx:'javascript',
    py:'python', html:'html', css:'css', json:'json', md:'markdown',
    sh:'shell', bash:'shell', yml:'yaml', yaml:'yaml', toml:'ini',
    rs:'rust', go:'go', cpp:'cpp', c:'c', java:'java', rb:'ruby',
    php:'php', sql:'sql', xml:'xml', txt:'plaintext' }[ext] || 'plaintext';
}

function renderCodeTabs() {
  const bar = document.getElementById('code-tabs');
  if (!bar) return;
  const files = codeSession?.open_files || [];
  bar.innerHTML = files.map(f => {
    const name = f.split('/').pop();
    const active = f === codeSession?.active_file;
    return `<div class="code-tab${active ? ' active' : ''}" data-path="${escHtml(f)}" title="${escHtml(f)}">
      <span class="code-tab-name">${escHtml(name)}</span>
      <button class="code-tab-close" data-path="${escHtml(f)}">×</button>
    </div>`;
  }).join('');
  bar.querySelectorAll('.code-tab').forEach(el =>
    el.addEventListener('click', e => { if (!e.target.closest('.code-tab-close')) openCodeFile(el.dataset.path); })
  );
  bar.querySelectorAll('.code-tab-close').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); closeCodeTab(el.dataset.path); })
  );
}

async function openCodeFile(path) {
  if (!codeSession) return;
  if (!codeSession.open_files) codeSession.open_files = [];
  if (!codeSession.open_files.includes(path)) codeSession.open_files.push(path);
  codeSession.active_file = path;
  renderCodeTabs();
  saveCodeSession();
  await _monacoOpenFile(path);
}

function closeCodeTab(path) {
  if (!codeSession) return;
  codeSession.open_files = (codeSession.open_files || []).filter(f => f !== path);
  if (codeSession.active_file === path) {
    codeSession.active_file = codeSession.open_files[codeSession.open_files.length - 1] || null;
  }
  renderCodeTabs();
  if (codeSession.active_file) openCodeFile(codeSession.active_file);
  else if (monacoEditor) monacoEditor.setValue('');
  saveCodeSession();
}

async function saveCurrentFile() {
  if (!codeSession?.active_file || !monacoEditor) return;
  const r = await api('POST', '/api/fs/write', { path: codeSession.active_file, content: monacoEditor.getValue() });
  if (r?.error) appendCodeBubble('system', `Save failed: ${r.error}`);
}

async function renderFileTree() {
  const root = codeSession?.root_path || '/home/viktor/library/projects';
  const el = document.getElementById('code-tree');
  if (!el) return;
  el.innerHTML = '';
  await _renderTreeLevel(el, root, true);
}

async function _renderTreeLevel(container, dirPath, expand) {
  try {
    const r = await api('GET', `/api/fs?path=${encodeURIComponent(dirPath)}`);
    if (r.error) { container.textContent = r.error; return; }
    const entries = [...(r.entries || [])].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const ul = document.createElement('ul');
    ul.className = 'tree-list';
    for (const entry of entries) {
      const fullPath = dirPath.replace(/\/$/, '') + '/' + entry.name;
      const li = document.createElement('li');
      li.className = `tree-item tree-${entry.type}`;
      const row = document.createElement('div');
      row.className = 'tree-row';
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = entry.type === 'dir' ? '▶' : '';
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = entry.name;
      label.title = fullPath;
      row.appendChild(icon);
      row.appendChild(label);
      li.appendChild(row);
      if (entry.type === 'dir') {
        let expanded = false;
        row.addEventListener('click', async () => {
          expanded = !expanded;
          icon.textContent = expanded ? '▼' : '▶';
          const existing = li.querySelector('.tree-list');
          if (existing) { existing.remove(); return; }
          await _renderTreeLevel(li, fullPath, false);
        });
      } else {
        row.addEventListener('click', () => openCodeFile(fullPath));
        row.addEventListener('dblclick', () => openCodeFile(fullPath));
      }
      ul.appendChild(li);
    }
    container.appendChild(ul);
  } catch (e) {
    container.textContent = e.message;
  }
}

function refreshCodeSelects() {
  const modelSel = document.getElementById('code-model-select');
  const agentSel = document.getElementById('code-agent-select');
  if (modelSel) modelSel.innerHTML = models.map(m =>
    `<option value="${escHtml(m)}"${m === state.model ? ' selected' : ''}>${escHtml(m)}</option>`
  ).join('');
  if (agentSel) agentSel.innerHTML = '<option value="">No agent</option>' + agents.map(a =>
    `<option value="${a.id}">${escHtml(a.name)}</option>`
  ).join('');
}

function appendCodeBubble(role, content) {
  const win = document.getElementById('code-chat-window');
  if (!win) return null;
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = role === 'user' ? `<p>${escHtml(content)}</p>` : marked.parse(content);
  win.appendChild(div);
  win.scrollTop = win.scrollHeight;
  if (role === 'assistant') div.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
  return div;
}

async function buildCodeContext() {
  const files = codeSession?.open_files || [];
  if (!files.length) return 'No files are currently open.';
  const parts = ['You are a coding assistant with access to the user\'s open files.\n'];
  for (const path of files) {
    try {
      const r = await api('GET', `/api/fs/read?path=${encodeURIComponent(path)}`);
      if (!r.error) parts.push(`### ${path}\n\`\`\`${detectLang(path)}\n${r.content}\n\`\`\``);
    } catch (_) {}
  }
  if (codeSession?.active_file) parts.push(`\nCurrently active: ${codeSession.active_file}`);
  parts.push(`Project root: ${codeSession?.root_path || ''}`);
  return parts.join('\n');
}

async function sendCodeMessage() {
  if (codeBusy) return;
  const input = document.getElementById('code-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  codeBusy = true;
  document.getElementById('code-send-btn').disabled = true;

  const win = document.getElementById('code-chat-window');
  appendCodeBubble('user', text);

  const agentId = document.getElementById('code-agent-select')?.value;
  const agent   = agents.find(a => a.id === agentId) || null;
  const model   = document.getElementById('code-model-select')?.value || state.model || models[0] || 'llama3.1:8b';
  const toolPerms = agent?.tools && Object.values(agent.tools).some(Boolean)
    ? agent.tools : { files: true, web: false };

  const codeCtx  = await buildCodeContext();
  const manifest = buildToolManifest(toolPerms);
  const sysParts = [codeCtx, agent?.systemPrompt, manifest].filter(Boolean);
  const tools    = buildTools(toolPerms);
  const messages = [
    { role: 'system', content: sysParts.join('\n\n') },
    { role: 'user',   content: text },
  ];

  let assistantDiv = null;
  let fullText = '';

  const doStream = async (msgs) => {
    assistantDiv = appendCodeBubble('assistant', '▋');
    fullText = '';
    codeAbort = new AbortController();
    const body = { model, messages: msgs, stream: true, options: {} };
    if (tools.length) body.tools = tools;
    if (agent?.temperature != null) body.options.temperature = agent.temperature;
    if (agent?.topP        != null) body.options.top_p       = agent.topP;
    if (agent?.contextLen)          body.options.num_ctx     = agent.contextLen;

    const resp = await fetch(`${await resolveOllama()}/api/chat`, {
      method: 'POST', body: JSON.stringify(body), signal: codeAbort.signal,
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let pendingToolCalls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.tool_calls?.length) {
            pendingToolCalls.push(...chunk.message.tool_calls);
          } else if (chunk.message?.content) {
            fullText += chunk.message.content;
            assistantDiv.innerHTML = marked.parse(fullText + (chunk.done ? '' : ' ▋'));
            assistantDiv.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
            win.scrollTop = win.scrollHeight;
          }
        } catch (_) {}
      }
    }

    if (pendingToolCalls.length) {
      renderToolCallBubble(win, pendingToolCalls);
      const toolMsgs = [];
      for (const tc of pendingToolCalls) {
        const name   = tc.function?.name;
        const params = tc.function?.arguments ?? tc.function?.parameters ?? {};
        const result = await executeTool(name, params);
        renderToolResultBubble(win, name, result);
        toolMsgs.push({ role: 'tool', content: String(result) });
      }
      return [...msgs, { role: 'assistant', content: '', tool_calls: pendingToolCalls }, ...toolMsgs];
    }

    if (fullText.includes('```action')) {
      const matches = [...fullText.matchAll(/```action\s*([\s\S]*?)```/g)];
      for (const m of matches) {
        try {
          const parsed = JSON.parse(m[1].trim());
          const result = await executeTool(parsed.tool, parsed.params || {});
          renderToolResultBubble(win, parsed.tool, result);
          msgs = [...msgs, { role: 'user', content: `Tool result for ${parsed.tool}:\n${result}` }];
        } catch (_) {}
      }
    }
    return null;
  };

  try {
    let msgs = messages;
    for (let i = 0; i < 6; i++) {
      const cont = await doStream(msgs);
      if (!cont) break;
      msgs = cont;
    }
    if (assistantDiv) {
      assistantDiv.innerHTML = marked.parse(fullText || '(no response)');
      assistantDiv.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
    }
  } catch (e) {
    if (e.name !== 'AbortError') appendCodeBubble('system', `Error: ${e.message}`);
  } finally {
    codeBusy = false;
    document.getElementById('code-send-btn').disabled = false;
    codeAbort = null;
  }
}

// Code tab event listeners
document.getElementById('code-send-btn').addEventListener('click', sendCodeMessage);
document.getElementById('code-chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCodeMessage(); }
});
document.getElementById('code-chat-input').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});
document.getElementById('code-auto-btn').addEventListener('click', () => {
  codeAutoAccept = !codeAutoAccept;
  const btn = document.getElementById('code-auto-btn');
  btn.title = `Auto-apply file edits (${codeAutoAccept ? 'on' : 'off'})`;
  btn.classList.toggle('active', codeAutoAccept);
});
document.getElementById('code-root-btn').addEventListener('click', () => {
  const newRoot = prompt('Set project root path:', codeSession?.root_path || '/home/viktor/library/projects');
  if (!newRoot?.trim()) return;
  if (!codeSession) codeSession = { open_files: [], active_file: null };
  codeSession.root_path = newRoot.trim();
  const lbl = document.getElementById('code-root-label');
  if (lbl) { lbl.textContent = codeSession.root_path.split('/').pop() || '/'; lbl.title = codeSession.root_path; }
  saveCodeSession();
  renderFileTree();
});
document.getElementById('code-new-file-btn').addEventListener('click', async () => {
  const root = codeSession?.root_path || '/home/viktor/library/projects';
  const name = prompt('New file name (relative to root):');
  if (!name?.trim()) return;
  const path = root.replace(/\/$/, '') + '/' + name.trim();
  const r = await api('POST', '/api/fs/write', { path, content: '' });
  if (r?.error) { alert(r.error); return; }
  renderFileTree();
  openCodeFile(path);
});
document.getElementById('code-new-dir-btn').addEventListener('click', async () => {
  const root = codeSession?.root_path || '/home/viktor/library/projects';
  const name = prompt('New folder name (relative to root):');
  if (!name?.trim()) return;
  const path = root.replace(/\/$/, '') + '/' + name.trim();
  const r = await api('POST', '/api/fs/mkdir', { path });
  if (r?.error) { alert(r.error); return; }
  renderFileTree();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadSettings(), loadAgents(), loadTasks(), load()]);
  await fetchModels();
  refreshAgentDropdown();
  // Restore last active thread's model/agent
  const t = activeThread();
  if (t?.model && models.includes(t.model)) { modelSelect.value = t.model; state.model = t.model; }
  if (t?.systemPrompt) systemPrompt.value = t.systemPrompt;
  if (t?.agentId) { agentSelect.value = t.agentId; state.selectedAgentId = t.agentId; }

  if (state.threads.length === 0) createThread();
  else { renderSidebar(); renderChat(); }
  initHome();
}

// ── Debug panel ───────────────────────────────────────────────────────────────

let dbgPollTimer    = null;
let dbgLogSse       = null;
let dbgSelectedJob  = null;
let dbgChunkEls     = {};
let dbgThinkStreamEl = null;  // current live-stream div in think panel
let dbgThinkStreamText = '';  // raw markdown accumulated for dbgThinkStreamEl
let dbgPrevStepEvt  = null;   // last step_start evt, for handover labels

function initDebug() {
  if (dbgPollTimer) clearInterval(dbgPollTimer);
  dbgSelectedJob = null;
  dbgChunkEls    = {};
  document.getElementById('dbg-log-body').innerHTML = '<p class="dbg-log-empty">Click a job on the left to view its output log.</p>';
  document.getElementById('dbg-log-title').textContent  = 'Select a job to view its log';
  document.getElementById('dbg-log-status').textContent = '';
  dbgLoadStatus();
  dbgPollTimer = setInterval(dbgLoadStatus, 3000);
}
document.getElementById('brain-refresh-btn').addEventListener('click', loadBrainPanel);

function stopDebug() {
  if (dbgPollTimer) { clearInterval(dbgPollTimer); dbgPollTimer = null; }
  if (dbgLogSse)    { dbgLogSse.close(); dbgLogSse = null; }
}

async function dbgLoadStatus() {
  try {
    const data = await api('GET', '/api/debug/status');
    dbgRenderWorker(data.worker, data.db);
    dbgRenderJobs(data.jobs);
    if (!dbgSelectedJob) {
      const running = data.jobs.find(j => j.status === 'running');
      if (running) dbgSelectJob(running);
    }
  } catch (e) {
    document.getElementById('dbg-worker-info').textContent = 'Error: ' + e.message;
  }
}

function dbgRenderWorker(w, db) {
  const active = (w.ActiveState || '').toLowerCase();
  const dot    = active === 'active' ? 'active' : (active ? 'inactive' : 'unknown');
  const pid    = w.MainPID && w.MainPID !== '0' ? `PID&nbsp;${w.MainPID}` : '';
  const nrest  = w.NRestarts ? `Restarts:&nbsp;${w.NRestarts}` : '';
  const sub    = w.SubState || active || '?';
  const dbMB   = db ? `DB&nbsp;${(db.size_bytes / 1048576).toFixed(1)}&nbsp;MB` : '';
  const walMB  = db?.wal_bytes > 0 ? `&nbsp;·&nbsp;WAL&nbsp;${(db.wal_bytes / 1048576).toFixed(1)}&nbsp;MB` : '';
  const parts  = [pid, nrest, dbMB + walMB].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  document.getElementById('dbg-worker-dot').className = `dbg-worker-dot ${dot}`;
  document.getElementById('dbg-worker-info').innerHTML = `<b>${sub}</b>${parts ? `&nbsp;&nbsp;·&nbsp;&nbsp;${parts}` : ''}`;
}

function dbgDuration(start, end) {
  if (!start) return '';
  const ms = Math.abs(new Date(end || Date.now()) - new Date(start));
  if (ms < 60000)   return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function dbgRenderJobs(jobs) {
  const list = document.getElementById('dbg-jobs-list');
  list.innerHTML = '';
  document.getElementById('dbg-jobs-count').textContent = jobs.length;
  jobs.forEach(job => {
    const dur  = dbgDuration(job.started_at, job.status !== 'running' ? job.finished_at : null);
    const name = job.pipeline_name || `Pipeline ${(job.pipeline_id || '').slice(-6)}`;
    const row  = document.createElement('div');
    row.className    = 'dbg-job-row' + (dbgSelectedJob?.id === job.id ? ' active' : '');
    row.dataset.jobId = job.id;
    row.innerHTML = `
      <div class="dbg-job-top">
        <span class="dbg-job-status ${job.status}">${job.status}</span>
        <span class="dbg-job-name" title="${escHtml(name)}">${escHtml(name)}</span>
        <span class="dbg-stat">${dur}</span>
      </div>
      <div class="dbg-job-meta">${(job.created_at || '').slice(0, 19).replace('T', ' ')}${job.loop_depth > 0 ? ` · loop ${job.loop_depth}` : ''}</div>
      ${job.error ? `<div class="dbg-job-error" title="${escHtml(job.error)}">${escHtml(job.error)}</div>` : ''}
    `;
    row.addEventListener('click', () => dbgSelectJob(job));
    list.appendChild(row);
  });
}

function dbgSelectJob(job) {
  dbgSelectedJob = job;
  document.querySelectorAll('.dbg-job-row').forEach(r =>
    r.classList.toggle('active', r.dataset.jobId === job.id)
  );
  const name = job.pipeline_name || `Job ${job.id.slice(-8)}`;
  document.getElementById('dbg-log-title').textContent  = name;
  document.getElementById('dbg-log-status').textContent = job.status;
  document.getElementById('dbg-log-status').className   = `dbg-job-status ${job.status}`;
  const logBody = document.getElementById('dbg-log-body');
  logBody.innerHTML = '';
  logScrollReset('dbg-log-body');
  logScrollReset('dbg-think-body');
  dbgChunkEls = {};
  dbgThinkStreamEl = null;
  dbgThinkStreamText = '';
  dbgPrevStepEvt   = null;
  const thinkBody = document.getElementById('dbg-think-body');
  if (thinkBody) thinkBody.innerHTML = '';
  if (dbgLogSse) { dbgLogSse.close(); dbgLogSse = null; }
  dbgLogSse = new EventSource(`/api/jobs/${job.id}/stream`);
  dbgLogSse.onmessage = e => { try { dbgAppendEvent(JSON.parse(e.data)); } catch (_) {} };
  dbgLogSse.onerror   = () => { dbgLogSse.close(); dbgLogSse = null; };
}

function dbgThinkAppend(cls, html) {
  const body = document.getElementById('dbg-think-body');
  if (!body) return null;
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  body.appendChild(div);
  logAutoScroll('dbg-think-body');
  return div;
}

function dbgAppendEvent(ev) {
  const logBody = document.getElementById('dbg-log-body');

  switch (ev.type) {
    case 'step_start': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-step-start';
      el.textContent = `▸ Step ${(ev.stepIndex ?? 0) + 1}${ev.stepName ? ': ' + ev.stepName : ''}${ev.agentName ? ' (' + ev.agentName + ')' : ''}`;
      logBody.appendChild(el);
      dbgChunkEls[ev.stepIndex] = null;

      // Think panel: handover + fresh stream area
      const handover = dbgThinkAppend('dbg-think-handover', `
        ${dbgPrevStepEvt ? `<div class="dbg-think-handover-from">← Step ${(dbgPrevStepEvt.stepIndex ?? 0) + 1}${dbgPrevStepEvt.stepName ? ': ' + escHtml(dbgPrevStepEvt.stepName) : ''}${dbgPrevStepEvt.agentName ? ' · ' + escHtml(dbgPrevStepEvt.agentName) : ''} handed over</div>` : ''}
        <div class="dbg-think-handover-to">▶ Step ${(ev.stepIndex ?? 0) + 1}${ev.stepName ? ': ' + escHtml(ev.stepName) : ''}${ev.agentName ? ' · ' + escHtml(ev.agentName) : ''}${ev.retryCount > 0 ? ' <span style="color:#e8b84b">(retry #' + ev.retryCount + ')</span>' : ''}</div>
      `);
      const thinkTitle = document.getElementById('dbg-think-title');
      if (thinkTitle) thinkTitle.textContent = `Step ${(ev.stepIndex ?? 0) + 1}${ev.agentName ? ' · ' + ev.agentName : ''}`;
      const streamDiv = document.createElement('div');
      streamDiv.className = 'dbg-think-stream';
      document.getElementById('dbg-think-body')?.appendChild(streamDiv);
      dbgThinkStreamEl = streamDiv;
      dbgThinkStreamText = '';
      dbgPrevStepEvt = ev;
      break;
    }
    case 'step_chunk': {
      let pre = dbgChunkEls[ev.stepIndex];
      if (!pre) {
        pre = document.createElement('pre');
        pre.className = 'dbg-ev-chunk';
        logBody.appendChild(pre);
        dbgChunkEls[ev.stepIndex] = pre;
      }
      pre.textContent += ev.chunk;
      // Mirror into think panel
      if (dbgThinkStreamEl) {
        dbgThinkStreamText += ev.chunk;
        const sealed = sealStream(dbgThinkStreamEl, dbgThinkStreamText);
        if (sealed) { dbgThinkStreamEl = sealed.el; dbgThinkStreamText = sealed.text; }
        scheduleMdRender('dbgStream', dbgThinkStreamEl, dbgThinkStreamText, 'dbg-think-body');
      }
      break;
    }
    case 'tool_call': {
      const wrap = document.createElement('div');
      wrap.className = 'dbg-ev-tool';
      const hdr  = document.createElement('div');
      hdr.className = 'dbg-ev-tool-hdr';
      hdr.innerHTML = `<span>🔧</span><b>${escHtml(ev.tool)}</b><span class="dbg-ev-tool-hint">expand result</span>`;
      const body = document.createElement('div');
      body.className = 'dbg-ev-tool-body';
      body.textContent = JSON.stringify(ev.result, null, 2);
      hdr.addEventListener('click', () => body.classList.toggle('open'));
      wrap.appendChild(hdr);
      wrap.appendChild(body);
      logBody.appendChild(wrap);
      dbgChunkEls[ev.stepIndex] = null;
      dbgThinkStreamEl = null;
      dbgThinkAppend('dbg-think-meta dbg-think-tool', `🔧 ${escHtml(ev.tool)} → ${escHtml(JSON.stringify(ev.result).slice(0, 80))}`);
      break;
    }
    case 'pm_start': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `◈ PM reviewing step ${(ev.stepIndex ?? 0) + 1}…`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-pm', '◈ PM reviewing…');
      break;
    }
    case 'pm_verdict': {
      const pass = ev.verdict === 'pass';
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `◈ PM step ${(ev.stepIndex ?? 0) + 1}: ${ev.verdict}${ev.pmNotes || ev.reason ? ' — ' + (ev.pmNotes || ev.reason) : ''}`;
      logBody.appendChild(el);
      const vcls = pass ? 'dbg-think-pass' : 'dbg-think-fail';
      dbgThinkAppend(`dbg-think-meta dbg-think-pm ${vcls}`, `◈ PM: ${pass ? '✓' : '✗'} ${escHtml(ev.pmNotes || ev.reason || ev.verdict)}`);
      break;
    }
    case 'error': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-error';
      el.textContent = '✖ ' + (ev.message || JSON.stringify(ev));
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-err', `✖ ${escHtml(ev.message || '')}`);
      break;
    }
    case 'run_done': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-done';
      el.textContent = '✓ Pipeline run complete';
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-done', '✓ Run complete');
      dbgThinkStreamEl = null;
      break;
    }
    case 'run_failed': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-error';
      el.textContent = '✖ Run failed' + (ev.reason ? ': ' + ev.reason : '');
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-err', `✖ Run failed${ev.reason ? ': ' + escHtml(ev.reason) : ''}`);
      dbgThinkStreamEl = null;
      break;
    }
    case 'step_retry': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `↺ Step ${(ev.stepIndex ?? 0) + 1} retry #${ev.retryCount}: ${ev.reason || ''}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-fail', `↺ Retry #${ev.retryCount}${ev.reason ? ': ' + escHtml(ev.reason) : ''}`);
      break;
    }
    case 'step_skipped': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `⊘ Step ${(ev.stepIndex ?? 0) + 1} skipped: ${ev.reason || ''}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-fail', `⊘ Skipped${ev.reason ? ': ' + escHtml(ev.reason) : ''}`);
      break;
    }
    case 'feedback_triage': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      const t = (ev.targets || []).map(n => n + 1).join(', ');
      const r = (ev.reused || []).map(n => n + 1).join(', ');
      el.textContent = `⊜ Feedback targets step(s) ${t || '?'}${r ? ` — reusing step(s) ${r}` : ''}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop', `⊜ Triage: revise ${t || '?'}${r ? `, reuse ${r}` : ''}`);
      break;
    }
    case 'step_reused': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `↩ Step ${(ev.stepIndex ?? 0) + 1} reused from previous run`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop', `↩ Step ${(ev.stepIndex ?? 0) + 1} reused`);
      break;
    }
    case 'loop_iteration': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      const score = ev.score != null ? ` score ${ev.score}` : '';
      el.textContent = `↻ Loop iteration ${ev.iteration + 1}/${ev.maxIterations}${score}${ev.feedback ? ' — ' + ev.feedback : ''}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop', `↻ Iteration ${ev.iteration + 1}/${ev.maxIterations}${score}`);
      break;
    }
    case 'loop_done': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      const why = { evaluator_done: 'evaluator satisfied', sentinel: 'sentinel found',
                    max_iterations: 'max iterations', stalled: 'no progress',
                    budget: 'budget spent' }[ev.reason] || ev.reason;
      el.textContent = `⊙ Loop finished after ${ev.iteration + 1} pass(es) — ${why}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop', `⊙ Loop done — ${why}`);
      break;
    }
    case 'run_cancelled': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-fail';
      el.textContent = '✕ Run cancelled';
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-fail', '✕ Run cancelled');
      break;
    }
    // Legacy events — kept so old job logs still replay
    case 'loop_spawned': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = `↻ Loop depth ${ev.depth} spawned (job …${(ev.childJobId || '').slice(-8)})`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop', `↻ Loop spawned (depth ${ev.depth})`);
      break;
    }
    case 'loop_stopped':
    case 'loop_max_depth': {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = ev.type === 'loop_max_depth'
        ? `⊡ Loop max depth (${ev.depth}) reached`
        : `⊠ Loop stopped at depth ${ev.depth}`;
      logBody.appendChild(el);
      dbgThinkAppend('dbg-think-meta dbg-think-loop',
        ev.type === 'loop_max_depth' ? `⊡ Max depth (${ev.depth})` : `⊠ Loop stopped at depth ${ev.depth}`);
      break;
    }
    default: {
      const el = document.createElement('div');
      el.className = 'dbg-ev-info';
      el.textContent = JSON.stringify(ev);
      logBody.appendChild(el);
    }
  }

  logAutoScroll('dbg-log-body');
}

document.getElementById('dbg-restart-btn').addEventListener('click', async () => {
  if (!confirm('Restart atlantis-worker?')) return;
  try {
    await api('POST', '/api/debug/restart', {});
    setTimeout(dbgLoadStatus, 1500);
  } catch (e) { alert('Restart failed: ' + e.message); }
});

// ── Models section ────────────────────────────────────────────────────────────
const modelsUI = { inited: false, sysinfo: null, installed: [], results: [], query: '', page: 1,
                   cap: '', sort: '', fit: '', minPulls: 0, hostId: '' };

const hostsUI = { inited: false };
let hosts = [];
let hostStatus = {};
let hostsPollTimer = null;
let hostsEditingId = null;
let sshCheckStatus = {};
const HOST_OS_LABELS  = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };
const HOST_GPU_LABELS = { nvidia: 'NVIDIA', apple_silicon: 'Apple Silicon', amd: 'AMD', cpu_only: 'CPU only' };

function initModels() {
  if (!modelsUI.inited) {
    modelsUI.inited = true;
    const input = document.getElementById('models-search-input');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        modelsUI.query = input.value.trim();
        modelsUI.page  = 1;
        searchHub();
      }
    });
    // Capability & sort are hub-side: refetch from page 1
    document.getElementById('models-filter-cap').addEventListener('change', e => {
      modelsUI.cap = e.target.value; modelsUI.page = 1; searchHub();
    });
    document.getElementById('models-filter-sort').addEventListener('change', e => {
      modelsUI.sort = e.target.value; modelsUI.page = 1; searchHub();
    });
    // Fit & downloads filter the current results client-side
    document.getElementById('models-filter-fit').addEventListener('change', e => {
      modelsUI.fit = e.target.value; renderHubResults();
    });
    document.getElementById('models-filter-pulls').addEventListener('change', e => {
      modelsUI.minPulls = Number(e.target.value); renderHubResults();
    });
    document.getElementById('models-host-select').addEventListener('change', e => {
      modelsUI.hostId = e.target.value;
      loadSysinfo(modelsUI.hostId);
      loadLocalModels();
    });
    searchHub();
  }
  // Host selection always resets to Auto when the tab is (re-)activated.
  modelsUI.hostId = '';
  loadSysinfo('');
  loadHosts().then(() => {
    const sel = document.getElementById('models-host-select');
    sel.innerHTML = '<option value="">Auto</option>' +
      hosts.map(h => `<option value="${h.id}">${escHtml(h.name)}</option>`).join('');
    sel.value = '';
  });
  loadLocalModels();
}

async function loadSysinfo(hostId = '') {
  const requested = hostId;
  let sysinfo;
  try {
    const q = hostId ? `?host_id=${encodeURIComponent(hostId)}` : '';
    sysinfo = await api('GET', `/api/models/sysinfo${q}`);
  } catch { sysinfo = null; }
  if (modelsUI.hostId !== requested) return; // a newer host switch has already superseded this fetch
  modelsUI.sysinfo = sysinfo;
  const el = document.getElementById('models-hw-chips');
  const s = modelsUI.sysinfo;
  if (s && s.live) {
    el.innerHTML = `
      <span class="hw-chip" title="System memory">RAM ${s.ram_gb} GB</span>
      <span class="hw-chip" title="GPU memory — models up to ~${usableVramGB(s).toFixed(1)} GB run fully on GPU; the rest is headroom for KV cache and compute buffers">VRAM ${s.vram_gb} GB</span>
      ${s.disk_free_gb ? `<span class="hw-chip" title="Free disk space">Disk ${s.disk_free_gb} GB</span>` : ''}`;
  } else if (s && (s.os || s.gpu_arch)) {
    const osLabel  = s.os       ? HOST_OS_LABELS[s.os]       : 'Unknown';
    const gpuLabel = s.gpu_arch ? HOST_GPU_LABELS[s.gpu_arch] : 'Unknown';
    el.innerHTML = `<span class="hw-chip" title="Could not fetch live specs over SSH">${escHtml(osLabel)} · ${escHtml(gpuLabel)} — live specs unavailable</span>`;
  } else if (s) {
    el.innerHTML = `<span class="hw-chip">Specs unknown for this host</span>`;
  } else {
    el.innerHTML = '';
  }
}

async function loadLocalModels() {
  let data;
  try {
    const q = modelsUI.hostId ? `?host_id=${encodeURIComponent(modelsUI.hostId)}` : '';
    data = await api('GET', `/api/models/local${q}`);
  } catch { data = { models: [] }; }
  modelsUI.installed = data.models || [];
  document.getElementById('models-installed-count').textContent = `(${modelsUI.installed.length})`;
  const list = document.getElementById('models-installed-list');
  if (!modelsUI.installed.length) {
    list.innerHTML = '<div class="models-empty">No models installed</div>';
    return;
  }
  list.innerHTML = modelsUI.installed.map(m => {
    const d = m.details || {};
    const meta = [d.parameter_size, d.quantization_level, fmtGB(m.size)].filter(Boolean).join(' · ');
    return `<div class="installed-model">
      <div class="im-name" title="${escHtml(m.name)}">${escHtml(m.name)}</div>
      <div class="im-meta">${escHtml(meta)}</div>
      <button class="im-delete" data-name="${escHtml(m.name)}" title="Delete model">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.im-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteModel(btn.dataset.name)));
}

function fmtGB(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
}

// "8b" → 8, "1.5b" → 1.5, "8x7b" → 56, "540m" → 0.54; null if unparseable
function parseParamsB(s) {
  const m = String(s).toLowerCase().match(/^([\d.]+)(?:x([\d.]+))?([bm])$/);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] ? parseFloat(m[2]) : 1);
  return m[3] === 'm' ? n / 1000 : n;
}

// Rough Q4_K_M download size from parameter count (measured: qwen3.x 27b = 17.4 GB → 0.64 GB/B)
function estSizeGB(paramsB) { return paramsB == null ? null : paramsB * 0.65; }

// Weights alone filling VRAM is not enough for a full-GPU load: the KV cache,
// flash-attention compute buffers and the CUDA context need room too, and
// nvidia-smi's MiB total inflates to decimal GB (a "16 GB" card reports 17.1).
// 2026-07-07: a 17.4 GB model on that card OOMed mid-generation with 1.2 GB
// free. 15% headroom (~2.6 GB at 16 GB) covers the num_ctx tiers worker.py
// picks for each VRAM class.
function usableVramGB(s) { return (s.vram_gb || 0) * 0.85; }

function fitTier(gb) {
  const s = modelsUI.sysinfo;
  if (gb == null || !s || !s.ram_gb) return null;
  if (s.vram_gb && gb <= usableVramGB(s)) return { cls: 'fit-gpu', dot: '◉', label: 'GPU fit' };
  if (gb <= s.ram_gb * 0.65)              return { cls: 'fit-cpu', dot: '◎', label: 'CPU fit' };
  return { cls: 'fit-no', dot: '✕', label: 'Too large' };
}

// "212.3K" / "1.2M" / "5,741" → number; 0 if unparseable
function parsePulls(s) {
  const m = String(s).replace(/,/g, '').match(/^([\d.]+)([KM])?$/i);
  return m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6 }[(m[2] || '').toUpperCase()] || 1) : 0;
}

// Best estimated fit across a card's advertised sizes: 'gpu' | 'cpu' | null
function bestCardFit(m) {
  let best = null;
  for (const s of m.sizes) {
    const t = fitTier(estSizeGB(parseParamsB(s)));
    if (!t) continue;
    if (t.cls === 'fit-gpu') return 'gpu';
    if (t.cls === 'fit-cpu') best = 'cpu';
  }
  return best;
}

function passesLocalFilters(m) {
  if (modelsUI.minPulls && parsePulls(m.pulls) < modelsUI.minPulls) return false;
  if (modelsUI.fit && modelsUI.sysinfo) {
    const f = bestCardFit(m);
    if (modelsUI.fit === 'gpu'  && f !== 'gpu') return false;
    if (modelsUI.fit === 'fits' && !f)          return false;
  }
  return true;
}

async function searchHub() {
  const box = document.getElementById('models-results');
  box.innerHTML = '<div class="models-empty">Searching…</div>';
  let data;
  try {
    const qs = new URLSearchParams({ q: modelsUI.query, p: modelsUI.page });
    if (modelsUI.cap)  qs.set('c', modelsUI.cap);
    if (modelsUI.sort) qs.set('o', modelsUI.sort);
    data = await api('GET', `/api/models/search?${qs}`);
  } catch (e) {
    box.innerHTML = `<div class="models-empty">Search failed: ${escHtml(e.message)}</div>`;
    return;
  }
  modelsUI.results = data.models || [];
  renderHubResults();
}

function renderHubResults() {
  const box = document.getElementById('models-results');
  const installedBases = new Set(modelsUI.installed.map(m => m.name.split(':')[0]));
  const visible = modelsUI.results.filter(passesLocalFilters);
  const hidden = modelsUI.results.length - visible.length;
  document.getElementById('models-filter-note').textContent =
    hidden ? `${hidden} hidden by filters` : '';
  const cards = visible.map(m => {
    const sizeChips = m.sizes.map(s => {
      const t = fitTier(estSizeGB(parseParamsB(s)));
      return `<span class="size-chip ${t ? t.cls : ''}" title="${t ? t.label + ' (estimated)' : ''}">${escHtml(s)}</span>`;
    }).join('');
    const caps = m.capabilities.map(c => `<span class="cap-chip">${escHtml(c)}</span>`).join('');
    const inst = installedBases.has(m.name) ? '<span class="cap-chip installed-chip">installed</span>' : '';
    return `<div class="model-card" data-name="${escHtml(m.name)}">
      <div class="mc-head">
        <span class="mc-name">${escHtml(m.name)}</span>
        <span class="mc-pulls">${escHtml(m.pulls)} pulls</span>
      </div>
      <div class="mc-desc">${escHtml(m.description)}</div>
      <div class="mc-chips">${sizeChips}${caps}${inst}</div>
      <div class="mc-tags" hidden></div>
      <div class="mc-actions">
        <button class="mc-expand">Tags &amp; install ▾</button>
        <div class="mc-progress" hidden>
          <div class="mc-progress-track"><div class="mc-progress-bar"></div></div>
          <span class="mc-progress-label"></span>
        </div>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = (cards || `<div class="models-empty">${hidden ? 'All results on this page hidden by filters' : 'No results'}</div>`) + `
    <div class="models-pager">
      <button id="models-prev" ${modelsUI.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${modelsUI.page}</span>
      <button id="models-next" ${modelsUI.results.length < 10 ? 'disabled' : ''}>Next →</button>
    </div>`;
  box.querySelectorAll('.mc-expand').forEach(btn =>
    btn.addEventListener('click', () => toggleTags(btn.closest('.model-card'))));
  document.getElementById('models-prev').addEventListener('click', () => {
    if (modelsUI.page > 1) { modelsUI.page--; searchHub(); }
  });
  document.getElementById('models-next').addEventListener('click', () => {
    modelsUI.page++; searchHub();
  });
}

async function toggleTags(card) {
  const tagsEl = card.querySelector('.mc-tags');
  if (!tagsEl.hidden) { tagsEl.hidden = true; return; }
  tagsEl.hidden = false;
  if (tagsEl.dataset.loaded) return;
  tagsEl.innerHTML = '<div class="models-empty">Loading tags…</div>';
  let data;
  try {
    data = await api('GET', `/api/models/tags?name=${encodeURIComponent(card.dataset.name)}`);
  } catch (e) {
    tagsEl.innerHTML = `<div class="models-empty">Failed to load tags: ${escHtml(e.message)}</div>`;
    return;
  }
  tagsEl.dataset.loaded = '1';
  const installedSet = new Set(modelsUI.installed.map(m => m.name));
  tagsEl.innerHTML = (data.tags || []).map(t => {
    const fit = fitTier(t.size_gb);
    const tooLarge = fit && fit.cls === 'fit-no';
    return `<div class="tag-row">
      <span class="tag-name">${escHtml(t.tag)}</span>
      <span class="tag-meta">${t.size_gb != null ? t.size_gb.toFixed(1) + ' GB' : ''}${t.context ? ' · ' + escHtml(t.context) + ' ctx' : ''}</span>
      ${fit ? `<span class="fit-badge ${fit.cls}">${fit.dot} ${fit.label}</span>` : ''}
      ${installedSet.has(t.tag)
        ? '<span class="fit-badge fit-gpu">✓ installed</span>'
        : `<button class="tag-install" data-tag="${escHtml(t.tag)}" ${tooLarge ? 'disabled title="Exceeds available memory"' : ''}>↓ Install</button>`}
    </div>`;
  }).join('') || '<div class="models-empty">No tags found</div>';
  tagsEl.querySelectorAll('.tag-install').forEach(btn =>
    btn.addEventListener('click', () => installModel(btn.dataset.tag, card)));
}

async function installModel(name, card) {
  const prog  = card.querySelector('.mc-progress');
  const bar   = card.querySelector('.mc-progress-bar');
  const label = card.querySelector('.mc-progress-label');
  prog.hidden = false;
  prog.classList.remove('failed');
  bar.style.width = '0%';
  label.textContent = `${name} — starting…`;
  card.querySelectorAll('.tag-install').forEach(b => b.disabled = true);
  let ok = false;
  try {
    const resp = await fetch('/api/models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hostId: modelsUI.hostId }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.error) throw new Error(ev.error);
        if (ev.total && ev.completed != null) {
          const pct = Math.round(ev.completed / ev.total * 100);
          bar.style.width = pct + '%';
          label.textContent = `${name} — ${pct}% (${fmtGB(ev.completed)} / ${fmtGB(ev.total)})`;
        } else if (ev.status) {
          label.textContent = `${name} — ${ev.status}`;
          if (ev.status === 'success') ok = true;
        }
      }
    }
    if (ok) {
      bar.style.width = '100%';
      label.textContent = `${name} — installed ✓`;
      loadLocalModels();
    } else {
      prog.classList.add('failed');
      label.textContent = `${name} — pull ended without success`;
    }
  } catch (e) {
    prog.classList.add('failed');
    label.textContent = `${name} — failed: ${e.message}`;
  } finally {
    card.querySelectorAll('.tag-install').forEach(b => b.disabled = false);
  }
}

async function deleteModel(name) {
  if (!confirm(`Delete model ${name}?`)) return;
  const q = modelsUI.hostId ? `&host_id=${encodeURIComponent(modelsUI.hostId)}` : '';
  try { await api('DELETE', `/api/models?name=${encodeURIComponent(name)}${q}`); }
  catch (e) { alert('Delete failed: ' + e.message); }
  loadLocalModels();
}

// ── Hosts ─────────────────────────────────────────────────────────────────

async function loadHosts() {
  try { hosts = await api('GET', '/api/hosts'); }
  catch (_) { hosts = []; }
}

function stopHostsPolling() {
  if (hostsPollTimer) { clearInterval(hostsPollTimer); hostsPollTimer = null; }
}

async function checkAllHosts() {
  sshCheckStatus = {};
  try { hostStatus = await api('POST', '/api/hosts/check'); }
  catch (_) { /* keep last known status */ }
}

function initHosts() {
  if (!hostsUI.inited) {
    hostsUI.inited = true;
    document.getElementById('hosts-add-btn').addEventListener('click', () => openHostForm(null));
    document.getElementById('host-form-cancel-btn').addEventListener('click', closeHostForm);
    document.getElementById('host-form-save-btn').addEventListener('click', saveHostFromForm);
  }
  stopHostsPolling();
  loadHosts().then(async () => {
    await checkAllHosts();
    renderHostList();
    hostsPollTimer = setInterval(async () => { await checkAllHosts(); renderHostList(); }, 10000);
  });
}

function renderHostList() {
  const grid = document.getElementById('hosts-grid');
  if (!hosts.length) {
    grid.innerHTML = '<p class="empty-state">No hosts yet — add one to get started.</p>';
    return;
  }
  grid.innerHTML = hosts.map(h => {
    const st = hostStatus[h.id] || { online: false, ollamaRunning: false, modelCount: 0 };
    const dotClass    = st.ollamaRunning ? 'host-dot-green' : st.online ? 'host-dot-yellow' : 'host-dot-gray';
    const statusCls   = st.ollamaRunning ? 'up' : st.online ? 'down' : 'offline';
    const statusLabel = st.ollamaRunning ? `Ollama up · ${st.modelCount}` : st.online ? 'Ollama down' : 'Offline';
    const osLabel  = h.os      ? HOST_OS_LABELS[h.os]   : 'Unknown';
    const gpuLabel = h.gpuArch ? HOST_GPU_LABELS[h.gpuArch] : 'Unknown';
    const ssh = sshCheckStatus[h.id];
    const sshPending = !!(ssh && ssh.pending);
    const sshPill = (ssh && !ssh.pending)
      ? `<span class="host-pill ${ssh.ok ? 'host-pill-up' : 'host-pill-fail'}">${ssh.ok ? 'SSH OK' : 'SSH failed'}</span>`
      : '';
    return `<div class="host-card host-card-${statusCls}" data-id="${h.id}">
      <div class="host-card-top">
        <span class="host-dot ${dotClass}"></span>
        <span class="host-name">${escHtml(h.name)}</span>
        <span class="host-pill host-pill-${statusCls}">${escHtml(statusLabel)}</span>
      </div>
      <div class="host-ip">${escHtml(h.ip)}:${h.ollamaPort}</div>
      <div class="host-mac">${h.mac ? escHtml(h.mac) : 'No MAC saved'}</div>
      <div class="host-os-gpu">${osLabel} · ${gpuLabel}</div>
      <div class="host-actions">
        <button class="btn-sm host-prio-up" title="Higher priority">↑</button>
        <button class="btn-sm host-prio-down" title="Lower priority">↓</button>
        <button class="btn-sm host-wake-btn" ${(st.online || !h.mac) ? 'disabled' : ''}>Wake</button>
        <button class="btn-sm host-ssh-btn" ${sshPending ? 'disabled' : ''}>${sshPending ? 'Checking…' : 'Check SSH'}</button>
        ${sshPill}
        <button class="btn-sm host-edit-btn">Edit</button>
        <button class="btn-sm host-delete-btn">Delete</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.host-prio-up').forEach(b =>
    b.addEventListener('click', e => moveHostPriority(e.target.closest('.host-card').dataset.id, -1)));
  grid.querySelectorAll('.host-prio-down').forEach(b =>
    b.addEventListener('click', e => moveHostPriority(e.target.closest('.host-card').dataset.id, 1)));
  grid.querySelectorAll('.host-wake-btn').forEach(b =>
    b.addEventListener('click', e => wakeHost(e.target.closest('.host-card').dataset.id)));
  grid.querySelectorAll('.host-ssh-btn').forEach(b =>
    b.addEventListener('click', e => checkSsh(e.target.closest('.host-card').dataset.id)));
  grid.querySelectorAll('.host-edit-btn').forEach(b =>
    b.addEventListener('click', e => openHostForm(e.target.closest('.host-card').dataset.id)));
  grid.querySelectorAll('.host-delete-btn').forEach(b =>
    b.addEventListener('click', e => deleteHost(e.target.closest('.host-card').dataset.id)));
}

async function moveHostPriority(id, dir) {
  const idx = hosts.findIndex(h => h.id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= hosts.length) return;
  [hosts[idx], hosts[swapIdx]] = [hosts[swapIdx], hosts[idx]];
  renderHostList();
  await api('POST', '/api/hosts/reorder', { order: hosts.map(h => h.id) }).catch(() => {});
}

function openHostForm(id) {
  hostsEditingId = id;
  const h = id ? hosts.find(x => x.id === id) : null;
  document.getElementById('host-form-name').value = h ? h.name : '';
  document.getElementById('host-form-ip').value   = h ? h.ip : '';
  document.getElementById('host-form-mac').value  = h ? (h.mac || '') : '';
  document.getElementById('host-form-os').value       = h ? (h.os || '') : '';
  document.getElementById('host-form-gpu').value      = h ? (h.gpuArch || '') : '';
  document.getElementById('host-form-ssh-user').value = h ? h.sshUser : 'viktor';
  document.getElementById('hosts-add-form').hidden = false;
}

function closeHostForm() {
  hostsEditingId = null;
  document.getElementById('hosts-add-form').hidden = true;
}

async function saveHostFromForm() {
  const name    = document.getElementById('host-form-name').value.trim();
  const ip      = document.getElementById('host-form-ip').value.trim();
  const mac     = document.getElementById('host-form-mac').value.trim();
  const os      = document.getElementById('host-form-os').value;
  const gpuArch = document.getElementById('host-form-gpu').value;
  const sshUser = document.getElementById('host-form-ssh-user').value.trim() || 'viktor';
  if (!name || !ip) { alert('Name and IP are required'); return; }
  if (!os || !gpuArch) { alert('OS and GPU architecture are required'); return; }
  if (hostsEditingId) {
    const h = hosts.find(x => x.id === hostsEditingId);
    await api('PUT', `/api/hosts/${hostsEditingId}`,
      { name, ip, mac, ollamaPort: h.ollamaPort, enabled: h.enabled, os, gpuArch, sshUser }).catch(() => {});
  } else {
    await api('POST', '/api/hosts', { id: uid(), name, ip, mac, ollamaPort: 11434, os, gpuArch, sshUser }).catch(() => {});
  }
  closeHostForm();
  await loadHosts();
  await checkAllHosts();
  renderHostList();
}

async function deleteHost(id) {
  if (!confirm('Delete this host?')) return;
  await api('DELETE', `/api/hosts/${id}`).catch(() => {});
  hosts = hosts.filter(h => h.id !== id);
  delete hostStatus[id];
  renderHostList();
}

async function wakeHost(id) {
  try { await api('POST', `/api/hosts/${id}/wake`); }
  catch (e) { alert('Wake failed: ' + e.message); }
}

async function checkSsh(id) {
  sshCheckStatus[id] = { pending: true };
  renderHostList();
  try {
    const res = await api('POST', `/api/hosts/${id}/check-ssh`);
    sshCheckStatus[id] = { ok: res.ok, ts: Date.now() };
  } catch (e) {
    sshCheckStatus[id] = { ok: false, ts: Date.now() };
  }
  renderHostList();
}

init();
