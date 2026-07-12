# Atlantis OS — System Design

---

## 1. Current State

A single-page vanilla HTML/CSS/JS app served via `python3 server.py` (port 5000).
All state lives in SQLite (`data.db`, WAL mode). No build step.
A separate `worker.py` daemon executes pipeline jobs in the background.

### Process layout

```
python3 server.py    # HTTP API + SSE streaming, port 5000
python3 worker.py    # Job daemon — polls jobs table, runs pipelines
```

Both started as systemd user services via `bash setup-services.sh`.

### Layout

  ┌──────┬──────────────────────────────────────────────────┐
  │ Nav  │  Section content (flex: 1)                       │
  │ rail │                                                  │
  │ 52px │                                                  │
  └──────┴──────────────────────────────────────────────────┘

  Nav rail: icon-only buttons (SVG), tooltip on hover, Settings pinned to bottom.
  Active tab glows accent colour. Scroll position restored per section on switch.

### Sections

  **Home** (default on load)
  - Greeting + single compose card; landing state collapses to just greeting +
    compose + side panel, expanding into a chat view (`.home-active`) once a
    message is sent
  - Two modes, toggled via "⚡ Brain" button (`homeMode`, `'chat' | 'brain'`):
      • Chat mode: agent + model dropdowns, sending creates/switches a normal
        thread and hands off to the Chat section (`switchSection('chat')`)
      • Brain mode: agent dropdown hidden, animated gradient border on the
        compose card, sends into the persistent `__brain__` thread in place
        (stays on Home) via System Brain (see below); "Clear history" empties
        `__brain__` and returns Home to landing state
      • `@brain`/`/brain` prefix sends a one-off Brain-mode message from Chat
        mode without flipping the persisted toggle
  - System Brain: system prompt auto-built each send from live system context
    (agents, tasks, DB counts — `buildBrainSystemPrompt()`) so answers stay
    grounded in real agent/task/file names rather than drifting generic
  - Side panel: "Recent" (last 3 non-brain threads, click → Chat) and "Recent
    Pipeline Runs" (`GET /api/pipeline-runs/recent`, click → Pipelines)

  **Chat**
  - Thread list sidebar: create, switch, delete threads
  - Toolbar: Agent dropdown + Model dropdown + Clear button
  - Collapsible system prompt textarea (persisted per-thread in DB)
  - Streaming chat via ReadableStream (NDJSON)
  - Thinking block: native chunk.message.thinking field (Ollama ≥0.6)
    with <think> tag fallback; toggle-able in Settings
  - Markdown + Prism.js syntax highlighting (JS/TS/Python/Bash/CSS/JSON/SQL/HTML)
  - Copy button + token count + elapsed time + t/s per assistant message
  - Abandon button (AbortController) to cancel in-flight request
  - Prompt timeout (AbortController + setTimeout, default 5h, 0 = disabled)
  - "/" shortcut to focus input; auto-growing textarea

  **Agents**
  - CRUD editor: name, model, system prompt, temperature (0–2), top-p (0–1),
    context length, native tools toggles (file system / web search & fetch /
    shell / browser — sent as an Ollama `tools` array for function calling)
  - Brain is pinned as the first entry in the list: a virtual, undeletable
    agent whose editor pane shows only a system-prompt textarea (backed by
    `settings.brainPrePrompt`, the same value Home's Brain mode sends)
  - Saved agents appear in Chat toolbar "Agent" dropdown (Brain is excluded —
    it's only usable via Home's Brain mode)

  **Tasks**
  - CRUD editor: name, agent (optional), model, prompt template
  - Template variable chips: {{date}}, {{time}}, {{datetime}}
  - Schedule field: Manual / Every day at [time] / Every week / Every month / Custom cron
  - "Run now": streams response, saves run to DB
  - Run log: last 50 runs per task
  - Scheduler (background thread in server.py) fires due tasks

  **Plans**
  - Sidebar: lists .md files from plans/ directory
  - Vertical split: plan textarea (top) + AI chat panel (bottom, 280px)
  - AI chat: stream response directly into plan textarea
  - "▶ Execute plan": model returns JSON task array, user confirms to create tasks
  - Save/rename: writes .md files via /api/plans/:name

  **Pipelines**
  - Canvas: drag-and-drop step nodes with zoom/pan
  - Per-step config: name, agent, model tier, task, agent input, quality criteria,
    refinement loop (loop-back target, max iterations, done sentinel, token budget)
  - Per-pipeline config: name, goal, PM agent, PM model, pause-on-fail
  - Run: POST /api/pipelines/:id/run → jobId → SSE stream /api/jobs/:id/stream
  - Live canvas: nodes pulse/glow/go green/red as events arrive via SSE
  - Reconnect: selectPipeline() calls maybeReconnectRunningJob() to auto-attach
    to any running/queued job for that pipeline (replays output_log via SSE)
  - Step detail: live output streaming, PM verdict, retry count; handover banner
    shows which agent/step passed work to the current step
  - Live think panel (#pipe-think, right side): visible during runs; shows agent
    handovers, continuous streaming output, tool calls, PM verdicts, loop events
  - Job history panel: run list; legacy loop children (pre-evaluator loop) still
    render indented under their parent with status, timestamp, duration
  - Loop primitive (evaluator-driven, in-process): at most one loop-enabled step
    (the "anchor") per pipeline. The PM reviews the anchor's output with a
    three-way verdict — done (exit loop), iterate (jump back to backToStep with
    feedback + iteration history injected), fail (retry path). Termination stack:
    evaluator done → sentinel substring → max iterations → stall (identical
    output hash) → token budget. Every exit proceeds downstream with the latest
    passing output. Run detail groups step runs by iteration.
  - Cancel: ◼ Stop button POSTs /api/jobs/:id/cancel; worker checks between
    steps and flips the run to cancelled

  **Debug** (job/worker monitor + system reference — the monitor promoted out
  of Pipelines, the reference panel absorbed from the now-removed standalone
  Brain section)
  - Left/main (`#pipe-debug-area`): status bar with worker process state
    (online/offline dot, PID/restart info via `#dbg-worker-info`, ↺ Restart
    worker button) + jobs panel (recent jobs list, status/duration/pipeline
    name) + log panel (click a job to view its full NDJSON output log)
  - Right (`#brain-panel`, "Reference"): API endpoint list grouped by area +
    live DB counts, fetched from `/api/brain/status`; ⟳ refresh button
    — this is the reference panel formerly hosted in the standalone Brain
    section, now living alongside the job monitor instead

  **Models**
  - Two-panel: installed models sidebar (name, params, quant, size, ✕ delete)
    + hub browser (search ollama.com library, paginated)
  - Hardware chips: RAM / VRAM / free disk from /api/models/sysinfo
    (Linux: /proc/meminfo + nvidia-smi; macOS: sysctl, unified memory = VRAM)
  - Host dropdown (Auto + one per network host): Auto probes the Atlantis
    server's own machine; a specific host probes that host's real specs
    live over SSH, with fit badges computed the same way for both
  - Fit badges per size/tag: ◉ GPU fit (≤ VRAM) · ◎ CPU fit (≤ RAM × 0.65) · ✕ too large
    — search results use estimated size (params × 0.6 GB ≈ Q4_K_M);
    expanding a card fetches /library/:name/tags for exact per-tag GB + context
  - Install: streams Ollama pull NDJSON through POST /api/models/pull into a
    progress bar (fetch + ReadableStream, same pattern as chat); "too large"
    tags have Install disabled
  - Lazy init on first tab activation; installed list refreshed on every switch

  **Hosts**
  - Card grid, one card per LAN machine that may run Ollama: name, ip:port,
    MAC, OS · GPU architecture line, status dot (green = online + Ollama
    running, yellow = online only, gray = offline), priority ↑/↓, Wake
    (disabled without a saved MAC), Check SSH (transient result pill,
    clears on the next 10s poll), Edit, Delete
  - Host CRUD regenerates settings.endpoint (the Ollama fallback chain
    resolve_ollama_endpoint() already consumes) from enabled hosts ordered
    by priority
  - Auto-polls /api/hosts/check every 10s while the tab is visible;
    cleared on navigating away

  **Settings**
  - Endpoint URL (Ollama, default: http://localhost:11434)
  - Prompt timeout in hours
  - Show token stats / thinking block toggles
  - API Keys: Anthropic (sk-ant-…), OpenAI (sk-…)
  - Pre-prompts: Brain / All agents / All chats
  - Export / Import / Clear data

### Files

  main/
  ├── index.html                    — shell, nav rail, section panels, CDN tags
  ├── style.css                     — dark-only theme, all section styles
  ├── app.js                        — all frontend logic
  ├── server.py                     — HTTP server + SQLite CRUD + scheduler + SSE
  ├── worker.py                     — job daemon: pipeline executor, model router
  ├── atlantis-server.service       — systemd user unit for server.py
  ├── atlantis-worker.service       — systemd user unit for worker.py
  ├── setup-services.sh             — install + enable both services
  ├── data.db                       — SQLite database (WAL mode, auto-created)
  ├── plans/                        — .md plan files
  └── .claude/

### Database schema (data.db)

  settings          key / value (JSON-encoded)
  agents            id, name, model, system_prompt, temperature, top_p, context_len,
                    file_access, web_access, tools (JSON)
  threads           id, name, model, agent_id, system_prompt, updated_at, tools
  messages          id, thread_id, role, content, thinking, tokens, eval_duration, created_at
  tasks             id, name, model, agent_id, prompt_template, schedule (JSON), created_at
  task_runs         id, task_id, started_at, finished_at, output, tokens, error

  pipelines         id, name, goal, pm_agent_id, pm_model, schedule, pause_on_fail,
                    layout (JSON), created_at
  pipeline_steps    id, pipeline_id, step_index, name, agent_id, agent_name, task,
                    handover_fields (JSON), quality_criteria (JSON), pass_full_output,
                    agent_input, model_tier, loop_config (JSON)
  pipeline_runs     id, pipeline_id, status, started_at, finished_at, error
  pipeline_step_runs id, run_id, step_id, step_index, step_name, agent_name, status,
                    output, handover_data, pm_notes, qa_verdict, qa_reason,
                    retry_count, started_at, finished_at, iteration

  jobs              id, pipeline_id, status, output_log (NDJSON event stream),
                    error, parent_job_id (legacy), loop_depth (legacy),
                    created_at, started_at, finished_at
                    status ∈ queued|running|done|failed|paused|cancelling|cancelled

  code_sessions     id, root_path, open_files, active_file, updated_at

  network_hosts     id, name, ip, mac, ollama_port, priority, enabled, created_at,
                    os (macos|linux|windows, nullable), gpu_arch (nvidia|apple_silicon|
                    amd|cpu_only, nullable), ssh_user (default 'viktor')

### Model router (stored in settings as model_router JSON)

  Default tiers:
    local    → Ollama (uses pipeline step's agent model or PM model)
    fast     → Anthropic claude-haiku-4-5-20251001
    smart    → Anthropic claude-sonnet-4-6
    powerful → Anthropic claude-opus-4-8
    auto     → heuristic: prompt tokens < 2k → local, < 8k → fast, else smart

  API keys stored in settings: anthropic_api_key, openai_api_key
  Adding a new provider = updating model_router JSON in settings, no code change.

### Server API endpoints

  GET  /api/settings              key/value settings object
  POST /api/settings              save settings

  GET  /api/agents                agent list
  POST /api/agents                create agent
  PUT  /api/agents/:id            update agent
  DELETE /api/agents/:id          delete agent

  GET  /api/hosts                 host list
  POST /api/hosts                 create host
  PUT  /api/hosts/:id             update host
  DELETE /api/hosts/:id           delete host
  POST /api/hosts/reorder         reorder by priority {order: [ids]}
  POST /api/hosts/check           concurrent ping+Ollama probe → {host_id: {online, ollamaRunning, modelCount}}
  POST /api/hosts/:id/wake        send Wake-on-LAN magic packet
  POST /api/hosts/:id/check-ssh   real key-based SSH reachability check → {ok, error?}

  GET  /api/threads               all threads with embedded messages
  POST /api/threads               create thread
  PUT  /api/threads/:id           update thread
  DELETE /api/threads/:id         delete thread + messages
  GET  /api/threads/:id/messages  messages for thread
  POST /api/threads/:id/messages  append message(s)
  DELETE /api/threads/:id/messages  clear thread messages

  GET  /api/tasks                 task list
  POST /api/tasks                 create task
  PUT  /api/tasks/:id             update task
  DELETE /api/tasks/:id           delete task + runs
  GET  /api/tasks/:id/runs        last 50 runs
  POST /api/tasks/:id/runs        append run
  GET  /api/activity?days=7       recent runs across tasks

  GET  /api/brain/status          live DB counts + agent/task/plan lists

  GET  /api/export                full DB export as JSON
  POST /api/import                restore from JSON backup
  DELETE /api/data                clear all data

  GET  /api/plans                 list .md filenames
  GET  /api/plans/:name           read plan file
  POST /api/plans/:name           write plan file
  DELETE /api/plans/:name         delete plan file

  GET  /api/pipelines             pipeline list
  POST /api/pipelines             create pipeline
  GET  /api/pipelines/:id         pipeline + steps
  PUT  /api/pipelines/:id         update pipeline
  DELETE /api/pipelines/:id       delete pipeline
  GET  /api/pipelines/:id/steps   step list
  POST /api/pipelines/:id/steps   add step
  PUT  /api/pipelines/:id/steps/:sid   update step
  DELETE /api/pipelines/:id/steps/:sid delete step
  POST /api/pipelines/:id/run     enqueue pipeline job → {jobId}
  GET  /api/pipelines/:id/runs    run history

  GET  /api/pipeline-runs/:id     run + step_runs detail
  GET  /api/pipeline-runs/recent  last 10 runs across all pipelines, with
                                  pipelineName joined in (Home widget)

  GET  /api/jobs                  job list (optional ?pipeline_id=)
  GET  /api/jobs/:id              job status
  POST /api/jobs/:id/cancel       cancel job (queued → cancelled; running → cancelling,
                                  worker flips to cancelled between steps)
  GET  /api/jobs/:id/stream       SSE stream of NDJSON events from jobs.output_log

  GET  /api/web/search?q=         DuckDuckGo search (pipeline tool)
  GET  /api/web/fetch?url=        URL fetch + HTML strip (pipeline tool)

  GET  /api/models/local          proxy Ollama /api/tags (endpoint from settings)
  GET  /api/models/sysinfo?host_id=   {ram_gb, vram_gb, disk_free_gb, live, os, gpu_arch}
                                   no host_id = local probe (Auto), always live:true;
                                   host_id = remote probe over SSH using that host's
                                   os/ssh_user/gpu_arch; live:false on SSH failure or
                                   unsupported os (falls back to a static os/gpu_arch
                                   badge client-side instead of numeric chips)
  GET  /api/models/search?q=&p=   scrape ollama.com/search → {models:[{name,
                                  description, sizes, capabilities, pulls}]}
  GET  /api/models/tags?name=     scrape ollama.com/library/:name/tags →
                                  {tags:[{tag, size_gb, context}]}
  POST /api/models/pull           {name} → streams Ollama pull NDJSON passthrough
  DELETE /api/models?name=        proxy Ollama /api/delete (name in query — tags
                                  contain ':' and '/')

  GET  /api/fs?path=              list directory
  GET  /api/fs/read?path=         read file
  POST /api/fs/write              write file
  POST /api/fs/mkdir              create directory
  POST /api/fs/rename             rename file
  GET  /api/code-session          active code session
  PUT  /api/code-session          update session

  GET  /*                         static file serving

### Worker — pipeline execution flow

  1. Poll jobs WHERE status='queued' (BEGIN EXCLUSIVE, claim atomically)
  2. Load pipeline, steps, agents, settings from data.db; validate at most one
     loop-enabled step (the "anchor")
  3. Create pipeline_runs + pipeline_step_runs records (iteration 0)
  4. Program-counter loop over steps (checks for cancel between steps):
     a. Resolve model via tier → resolve_llm() → provider/model/credential
     b. Build messages (system prompt + task + handover dict + QA feedback
        + on iterations > 0: evaluator feedback history + previous output)
     c. Call ollama_agentic() or anthropic_agentic() with tool loop
     d. PM review via ollama_once() or anthropic_once()
        — anchor step: three-way verdict done/iterate/fail (+ score + feedback)
        — other steps: pass/fail
     e. On iterate: loop_exit_reason() checks the termination stack
        (evaluator done → sentinel → max iterations → stall → budget);
        if continuing, insert fresh step_run rows for backToStep..anchor with
        iteration+1, drop their handover entries, jump the counter back
     f. On fail: retry up to max_retries, then pause or skip
  5. Write NDJSON events to jobs.output_log throughout
  6. server.py /api/jobs/:id/stream tails output_log every 400ms and pushes SSE

### SSE event types

  run_start      {runId, totalSteps}
  step_start     {stepIndex, stepName, agentName, retryCount, modelTier, iteration}
  step_chunk     {stepIndex, chunk}          — LLM output token stream
  tool_call      {stepIndex, tool, result}
  step_done      {stepIndex}
  pm_start       {stepIndex}
  pm_verdict     {stepIndex, verdict, reason, pmNotes, feedback, score}
  step_retry     {stepIndex, retryCount, reason}
  step_skipped   {stepIndex, reason}
  run_paused     {stepIndex, reason}
  run_failed     {reason}
  run_done       {runId}
  run_cancelled  {reason}
  loop_iteration {stepIndex, iteration, maxIterations, score, feedback}
  loop_done      {stepIndex, iteration, reason, score}
                 reason ∈ evaluator_done|sentinel|max_iterations|stalled|budget
  error          {message}

  Legacy (no longer emitted, UI still replays them from old logs):
  loop_spawned {childJobId, depth, stepIndex} · loop_stopped {stepIndex, depth}
  · loop_max_depth {depth, stepIndex}

### Ollama endpoints used

  GET  /api/tags    list installed models
  POST /api/chat    streaming chat (NDJSON)

---

## 2. Implementation Status

  ✓ 1.  Nav rail — icon-only, tooltip, Settings pinned to bottom
  ✓ 2.  Tab switching — show/hide sections, scroll position restored
  ✓ 3.  Chat section — streaming, thinking, markdown, token stats, abandon, timeout
  ✓ 4.  Settings section — endpoint, timeout, display toggles, API keys, export/import/clear
  ✓ 5.  Agent Management — CRUD, chat integration, tool toggles
  ✓ 6.  Automated Tasks — CRUD, run now, scheduler, run log
  ✓ 7.  Schedule backend — server.py scheduler reads/writes SQLite
  ✓ 8.  SQLite persistence — all data in data.db, localStorage eliminated
  ✓ 9.  Plans section — file-based .md, AI edits plan, execute plan → tasks
  ✓ 10. Home dashboard — split iframe + system report panel; later replaced by
        the greeting/compose/chat layout with dual Chat/Brain modes (see 11)
  ✓ 11. Brain tab — persistent system-context chat + live API/DB reference panel;
        later folded into Home as a toggleable mode (chat sends into `__brain__`
        in place, no separate section) with the reference panel moved into
        Debug alongside the promoted job/worker monitor
  ✓ 12. Pipeline canvas — drag-and-drop nodes, zoom/pan, step config panel
  ✓ 13. Pipeline execution engine — agentic tool loop, PM review, retries, pause-on-fail
  ✓ 14. Worker daemon (worker.py) — background job execution, decoupled from HTTP thread
  ✓ 15. Jobs table + SSE stream — enqueue → stream → replay on reconnect
  ✓ 16. Model router — per-step tier (local/fast/smart/powerful/auto), router config in settings
  ✓ 17. Anthropic API support — streaming + tool use via /v1/messages
  ✓ 18. Loop primitive — evaluator-driven in-process loop (done/iterate/fail verdict,
        backToStep, termination stack); replaced child-job spawning + stop-condition eval
  ✓ 19. Job tree UI — history panel with per-iteration grouping in run detail
        (legacy loop-child hierarchy still renders for old jobs)
  ✓ 21. Job cancellation — POST /api/jobs/:id/cancel, worker checks between steps,
        ◼ Stop button cancels server-side (previously only detached the stream)
  ✓ 20. systemd user services — setup-services.sh, auto-restart on crash
  ✓ 22. Models tab — hub browser + installed list, hardware fit badges,
        streaming install, delete (plans/model-selector-tab.md)

---

## 3. Decisions (locked)

  - Nav rail: icon only, tooltip on hover
  - Home is the default section on load/refresh
  - Scroll position: restored per section on tab switch
  - Agent selection in Chat: separate dropdown alongside model dropdown
  - Task run log: last 50 runs per task, pruned in DB
  - Prompt timeout: hours unit, 0 = disabled, default 5h
  - server.py is the entry point (replaces python3 -m http.server 5000)
  - SQLite (data.db, WAL mode) is the single source of truth and only IPC between server + worker
  - No Redis, no Celery, no message broker — SQLite is enough for one machine
  - No Docker — runs natively alongside Ollama
  - No websockets library (non-stdlib) — SSE polling of output_log solves streaming + replay
  - Anthropic tool format uses input_schema (not parameters like Ollama)
  - System message is a top-level field in Anthropic API, not a message in the array
  - Loop is in-process and evaluator-driven: PM verdict (done/iterate/fail) controls
    the loop; iterate jumps back to backToStep within the same job
    (supersedes: pipeline-level child-job re-runs)
  - Loop stop condition is a plain sentinel substring (e.g. LOOP_DONE), one signal in
    the termination stack (supersedes: safe eval with string-contains fallback)
  - At most one loop-enabled step per pipeline (enforced by worker + UI)
  - Model router config stored in settings table as JSON (not a YAML file)
  - API keys stored in settings table (anthropic_api_key, openai_api_key)
  - Plans are file-based (.md in plans/), not stored in DB
  - systemd user services (not system services) — no root required
  - Ollama hub has no JSON API — server-side scrape of ollama.com HTML
    (x-test-* attributes); search shows estimated sizes, exact GB lazily
    from the /tags page per model
  - Model pull streams NDJSON via fetch + ReadableStream (EventSource
    can't POST); no job record — a pull is not a pipeline job

---

## 4. Next / Future Work

  - WebSocket upgrade (bidirectional streaming; job cancel now solved via
    POST /api/jobs/:id/cancel + worker polling)
  - OpenAI provider implementation in worker.py (route already exists, LLM calls not yet)
  - Pipeline scheduler (run pipeline on cron, not just manual trigger)
  - Multi-worker parallelism (claim_job already atomic — just run N workers)
  - Model router settings UI (edit tiers from Settings page without raw JSON)
  - Attach files/images to chat messages (multimodal models)
  - Compare two models side-by-side in Chat
  - Rename threads
