// ── Shared agentic-loop client ───────────────────────────────────────────────
// Used by Chat (app.js), the code editor's AI panel (code/ai-panel.js), and the
// Task runner (app.js) — replaces three duplicated `while(looping){ fetch ollama
// directly }` loops with one call into the server-side loop (server.py's
// /api/agent/runs endpoints, running agent/worker.py's ollama_agentic()).
//
// Loaded as a plain classic script (not a module) so both app.js (classic) and
// ai-panel.js (an ES module that already reaches other app.js globals like
// escHtml/api the same way) can call these as bare globals.

async function runAgentTurn({
  messages, tools, model, numCtx, extraOptions, think, clientToolNames,
  signal, onChunk, onThinking, onToolEvent, onClientTool,
}) {
  const startBody = { messages, tools, model };
  if (numCtx) startBody.num_ctx = numCtx;
  if (extraOptions && Object.keys(extraOptions).length) startBody.options = extraOptions;
  if (typeof think === 'boolean') startBody.think = think;
  if (clientToolNames && clientToolNames.size) startBody.client_tool_names = [...clientToolNames];

  const { run_id } = await api('POST', '/api/agent/runs', startBody);

  const cancel = () => { api('POST', `/api/agent/runs/${run_id}/cancel`, {}).catch(() => {}); };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }

  const resp = await fetch(`/api/agent/runs/${run_id}/stream`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = { content: '', error: null };

  outer:
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(6)); } catch (_) { continue; }
      switch (evt.type) {
        case 'step_chunk':
          onChunk?.(evt.chunk);
          break;
        case 'step_thinking':
          onThinking?.(evt.chunk);
          break;
        case 'tool_calls_started':
          onToolEvent?.({ phase: 'batch_started', calls: evt.calls });
          break;
        case 'tool_call':
          onToolEvent?.({ phase: 'done', tool: evt.tool, result: evt.result });
          break;
        case 'tool_call_pending': {
          const answer = await onClientTool?.(evt.tool, evt.args);
          await api('POST', `/api/agent/runs/${run_id}/tool_result`,
            { tool_call_id: evt.toolCallId, result: answer });
          break;
        }
        case 'done':
          result = { content: evt.content || '', error: null };
          break outer;
        case 'error':
          result = { content: '', error: evt.message || 'Unknown error' };
          break outer;
      }
    }
  }
  return { ...result, cancel };
}

// Shared by Chat and the Editor's AI panel — was previously copy-pasted in both
// (web/app.js and web/code/ai-panel.js each had their own near-identical copy).
function renderAskUserCard(container, params, onAnswer) {
  const { question, options = [], allow_multiple: multi = false, allow_free_text: freeText = true } = params || {};
  const wrap = document.createElement('div');
  wrap.className = 'message ask-user-card';
  const optsHtml = options.map((o, i) => `
    <button class="ask-user-opt" data-idx="${i}" type="button">${escHtml(o)}</button>`).join('');
  wrap.innerHTML = `
    <p class="ask-user-question">${escHtml(question || '')}</p>
    <div class="ask-user-opts">${optsHtml}</div>
    ${freeText ? `
    <div class="ask-user-free">
      <input type="text" class="ask-user-input" placeholder="Or type your own answer…">
      <button class="ask-user-submit" type="button">Send</button>
    </div>` : ''}`;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;

  const selected = new Set();
  function finish(answer) {
    wrap.querySelectorAll('button, input').forEach(el => el.disabled = true);
    wrap.classList.add('answered');
    onAnswer(answer);
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
}
