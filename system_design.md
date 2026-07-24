# Atlantis OS — System Design

---

## 1. Current State

A single-page vanilla HTML/CSS/JS app served via `python3 server/server.py` (port 5000,
configurable — see "atlantis.config.json" below).
All state lives in SQLite (`data/data.db`, WAL mode). No build step.
A separate `agent/worker.py` daemon executes pipeline jobs in the background.
Both are supervised by `launcher.py`, installed by `install.py` — see
"Installer & process supervision" below for the full cross-platform packaging story.

### Process layout

```
python3 launcher.py            # recommended: supervisor, starts + monitors both below
python3 server/server.py       # HTTP API + SSE streaming, port 5000
python3 agent/worker.py        # Job daemon — polls jobs table, runs pipelines
```

End users start/stop/restart via `start.sh`/`stop.sh`/`restart.sh` (Linux),
`start.command`/`stop.command`/`restart.command` (macOS), or
`start.bat`/`stop.bat`/`restart.bat` (Windows) — each a one-line wrapper around
`python3 launcher.py --start`/`--stop`/`--restart`. The previous single-host
deployment (systemd user services via `setup-services.sh`) has been removed
now that `launcher.py` + the autostart entry `install.py` registers fully
supersede it.

### Directory layout

```
web/            — frontend: app.js, index.html, style.css, favicon.ico
server/         — server.py (HTTP API)
agent/          — worker.py (job daemon)
data/           — gitignored except .gitkeep: data.db, zone/, ollama/
                  (no-root Linux Ollama install), certs/, launcher.pid,
                  .restart / .stop flag files
plans/          — .md plan files (unchanged, repo root)
docs/           — unchanged, repo root
launcher.py, install.py, atlantis.config.json, start/stop/restart.*,
install.sh/.command/.bat, CLAUDE.md, system_design.md  — repo root
```

`web/`, `server/`, and `agent/` are exactly the three directories the in-app
updater (`POST /api/system/update`) validates and replaces — see "In-app
Update/Restart/Stop" below. `plans/`, `docs/`, `CLAUDE.md`, and
`system_design.md` were not moved by the reorg.

### atlantis.config.json

Root-level, gitignored, schema `{"port": 5000, "root_path": "/home/alice"}`.
Written once by `install.py` during first-time setup. `server/server.py`'s
`load_config()` reads it at import time:

```
DEFAULT_CONFIG = {'port': 5000, 'root_path': str(Path.home())}
```

- File missing → defaults.
- File present but not valid JSON, or valid JSON that isn't an object (e.g.
  the file contains `42` or `"hello"`) → defaults (guard added after a bug
  where a non-dict JSON value crashed the merge).
- Otherwise, defaults are shallow-merged under the parsed dict, so a config
  with only `{"port": 5001}` still gets a `root_path` default.

`PORT` is read directly from the merged config at import time. `root_path` is
different: it is written into the `code_sessions` table (`UPDATE code_sessions
SET root_path=? WHERE id='default'`) on every server boot, making the JSON
file authoritative and the DB row a synced cache of it — this is what the
Code Editor's `_fs_root()` reads. `agent/worker.py` does **not** read
`atlantis.config.json` directly; it only ever sees `root_path` via the DB,
so server/server.py is the single writer that keeps the two in sync.
Changing the workspace root via the Code Editor's "Change folder…" button
(`PUT /api/code-session {rootPath}`) now writes both directions: the DB row
(as before) **and**, via `_write_config_root_path()`, `atlantis.config.json`
itself — so the change survives a server restart instead of being silently
reverted by the boot-time mirror. `_put_code_session` only rewrites the config
file when a truthy `rootPath` is supplied and passes validation (must resolve
under the home-directory fence via `_fs_safe()` and must be an existing
directory — 400 with `{"error": ...}` otherwise, or 500 with
`{"error": ...}` if the config file itself can't be written); a request with
no `rootPath` behaves as before (falls back to `str(Path.home())`, no config
write).

### Installer & process supervision

**`launcher.py`** (repo root) supervises `server/server.py` + `agent/worker.py`
(and, on Linux only, a no-root Ollama at `data/ollama/bin/ollama` — started
via `ollama serve` with `OLLAMA_MODELS` pointed at `data/ollama/models`, but
only if that binary exists and port 11434 isn't already answering, so it
never fights a system-installed Ollama). On macOS/Linux it also supervises
`code-server` (skipped on Windows) at `data/code-server/bin/code-server`
(falling back to a PATH lookup), bound to `0.0.0.0:5001` with
`--auth none`, adding `--cert`/`--cert-key` pointed at
`data/certs/cert.pem`/`key.pem` when both exist. Two modes:

- **Supervisor mode** (`python3 launcher.py`, no args) — the blocking loop
  used by autostart entries (launchd plist / systemd user unit / Windows
  Task Scheduler). Refuses to start a second instance if `data/launcher.pid`
  names a live PID. On fresh start it clears any stale `data/.restart` /
  `data/.stop` flag left over from an unclean prior death — otherwise a
  leftover flag could immediately kill the children of a brand-new start.
  Once running, it polls once a second: `.stop` → terminate children (10s
  grace then kill) and idle until `.restart` reappears; `.restart` (not
  stopped) → terminate + respawn immediately; otherwise, respawn any child
  that died on its own (3s backoff, mirroring systemd's `RestartSec=3`).
  SIGTERM is caught and treated like Ctrl-C (stops children, removes the PID
  file, exits).
- **Control mode** (`python3 launcher.py --start`/`--stop`/`--restart`) — a
  short-lived CLI: `--stop`/`--restart` touch the flag files if a supervisor
  is alive; `--start`, and `--restart` when nothing is alive, spawn a
  detached fresh supervisor process instead. This is what the wrapper
  scripts and the Settings "System" endpoints (below) invoke.

Known accepted limitation (documented in a code comment, not fixed):
`is_alive()` only checks PID existence (`os.kill(pid, 0)` / `tasklist` on
Windows), not process identity, so a sufficiently rare PID-reuse collision
could report a stale PID as "already running." A portable identity check
isn't available in the stdlib across all three OSes, so this was accepted
rather than solved.

**`install.py`** (repo root) is the first-time setup wizard, run via the
bootstrap launchers below. Flow:

1. Print intro, detect OS (`Darwin`/`Windows`/`Linux` → `macos`/`windows`/`linux`).
2. Ask for the workspace root path (default: the user's home folder).
3. Ask to auto-install Ollama (default yes); skipped if something is already
   answering on 11434, or (macOS) `Ollama.app` is already present:
   - **macOS** — downloads the official `Ollama-darwin.zip`, unzips, moves
     `Ollama.app` into `~/Applications`, opens it.
   - **Windows** — downloads the official `OllamaSetup.exe`, runs it with
     `/SILENT`.
   - **Linux (no-root)** — downloads `ollama-linux-amd64.tar.zst` (**not**
     `.tgz` — Ollama renamed their release asset; the plan originally
     assumed `.tgz` and was corrected mid-implementation), shells out to a
     system `zstd`/`unzstd` binary to decompress to a `.tar` (stdlib
     `tarfile`/`zipfile` can't handle zstd), then extracts that tar with
     stdlib `tarfile` into `data/ollama/`. If neither `zstd` nor `unzstd` is
     on `PATH`, prints an apt/dnf hint and gives up cleanly rather than
     failing the whole install.
   - Any Ollama install failure is caught and non-fatal: Atlantis still
     installs, with a message to retry from Settings later.
   - After install, polls `127.0.0.1:11434` for up to 20s to confirm Ollama
     came up.
4. Asks to auto-generate an HTTPS cert (default yes); skipped on Windows or
   if `openssl` isn't on `PATH`. Otherwise shells out to `openssl req -x509`
   to write `data/certs/cert.pem`/`key.pem`, with a `subjectAltName`
   covering `localhost`, `127.0.0.1`, and the machine's LAN IPv4 addresses
   (gathered the same UDP-connect-trick way `server.py`'s `local_ips()`
   does). Both `server.py` (already) and `launcher.py`'s code-server
   supervision (below) pick these up automatically if present.
5. Asks to auto-install code-server (default yes); skipped on Windows
   (official support there is WSL-only). Otherwise installs it standalone,
   no root, via code-server's own install script with
   `--method=standalone --prefix=data/code-server`.
6. Explains the manual `start`/`stop`/`restart` wrapper scripts.
7. Asks whether to auto-start on login (default yes); if so, registers:
   - **macOS** — a `launchd` plist (`~/Library/LaunchAgents/com.atlantis.launcher.plist`,
     `RunAtLoad=true`, `KeepAlive=false`), loaded via `launchctl load`.
   - **Linux** — a systemd user unit (`~/.config/systemd/user/atlantis-launcher.service`,
     `Restart=on-failure`, `RestartSec=3`) with a **double-quoted** `ExecStart`
     (`ExecStart="{python}" "{launcher.py path}"` — added mid-implementation
     because unquoted paths containing spaces broke unit parsing), enabled
     via `systemctl --user enable --now`.
   - **Windows** — a Task Scheduler entry (`schtasks /Create /SC ONLOGON`)
     running with `/RL LIMITED` (no elevation).
   - Registration failures are caught and non-fatal, with a pointer back to
     the manual start scripts.
8. Writes `data/` and `atlantis.config.json` (`{"port": 5000, "root_path": ...}`).
9. Imports `server/server.py` directly (`sys.path.insert(0, .../server); import
   server as server_module`) and calls `server_module.init_db()` to create the
   schema before first launch, without going through HTTP.
10. Starts `launcher.py` detached (`start_new_session` on POSIX; plain `Popen`
    on Windows) and prints the closing message with the configured port.

**Bootstrap launchers** (repo root) — `install.sh` (Linux), `install.command`
(macOS), `install.bat` (Windows) — each checks for a usable Python before
running `install.py`:
- `install.sh` / `install.command`: check `command -v python3`; if missing,
  print package-manager guidance (`apt`/`dnf` on Linux) or trigger
  `xcode-select --install` on macOS (Xcode Command Line Tools bundle python3).
- `install.bat`: tries `python3` then `python` on `PATH`; if neither is
  found, downloads the official Python.org silent installer
  (`python-3.12.7-amd64.exe /quiet InstallAllUsers=0 PrependPath=1`) via
  PowerShell and asks the user to re-run `install.bat` afterward.

### In-app Update/Restart/Stop

Settings tab, "System" group. Three endpoints, all under `/api/system/`:

```
POST /api/system/update     body: raw zip bytes (not JSON — Content-Type
                             without "json" in it, so _read_body() returns
                             bytes) → {ok: true} | {error: "..."}
POST /api/system/restart    no body → {ok: true}
POST /api/system/stop       no body → {ok: true}
```

- **`/api/system/restart`** / **`/api/system/stop`** just touch
  `data/.restart` / `data/.stop` — the same flag files `launcher.py`'s
  supervisor loop polls once a second. The endpoint itself does no process
  management; `launcher.py` does the actual work out-of-band.
- **`/api/system/update`** takes the POST body as a zip file, extracts it to
  a temp dir, and:
  1. Rejects non-zip bodies (`400`, `{"error": "Not a valid zip file"}`).
  2. Locates `server/server.py` inside the extracted tree (`rglob`) to find
     the update's root, then requires all of `UPDATE_REQUIRED_PATHS =
     ('web/index.html', 'server/server.py', 'agent/worker.py')` to exist
     under it (`400` with which path is missing, otherwise) — this runs
     *before* anything live is touched.
  3. Stages each of `web/`, `server/`, `agent/` into sibling `<name>.new`
     directories first (`shutil.copytree`), only after **all three** stagings
     succeed does it swap them into place (`rmtree` the old dir, `rename` the
     staging dir over it). This ordering means a mid-copy failure (e.g. disk
     full) can never leave a live directory deleted with no replacement ready
     — it was changed to this two-phase stage-then-swap after an earlier
     version could brick an install partway through.
  4. Touches `data/.restart` on success so `launcher.py` picks up the new
     code on its next poll.
  5. Any exception anywhere in the process is caught and returned as a clean
     `500 {"error": "Update failed: ..."}` JSON response instead of a dropped
     connection; the `finally` block always removes the temp dir and any
     leftover `.new` staging directories.
  - Never touches `data/` — an update only ever replaces code directories,
    never the database or other user data.
  - Note: the stage-then-swap protects against a mid-*copy* failure, but the
    swap phase itself (`rmtree` old dir, `rename` staging dir over it, done
    sequentially per directory) is not atomic across all three directories —
    if the swap step fails partway (e.g. a file-in-use error on Windows), a
    mixed-version install is possible. Accepted as best-effort for a
    single-user home app; not worth the complexity of a full rollback.

### Layout

  ┌──────┬──────────────────────────────────────────────────┐
  │ Nav  │  Section content (flex: 1)                       │
  │ rail │                                                  │
  │ 52px │                                                  │
  └──────┴──────────────────────────────────────────────────┘

  Nav rail: icon-only buttons (SVG), tooltip on hover, Settings pinned to bottom.
  Active tab glows accent colour. Scroll position restored per section on switch.

  Phone tier (`@media (max-width: 720px)`, single breakpoint, no separate
  tablet tier):
  - Nav rail becomes a hamburger-triggered overlay drawer (`#nav-rail.open`),
    closed via backdrop tap or on navigation (`closeMobileNav()`, called from
    `switchSection()`)
  - Agents/Skills/Tasks/Plans switch to drill-down list↔detail: CSS `:has()`
    shows the detail pane and hides the list once something is selected, with
    a back button to return — no per-section JS, driven entirely by the
    shared `.section-sidebar`/`.editor-area` structure
  - Chat/Models/Pipelines' own sidebars become overlay drawers
    (`.mobile-open` + shared backdrop) via one shared helper,
    `bindMobileSidebarToggle()`
  - Message bubbles, the composer, Home, and Settings go fluid-width instead
    of their desktop fixed/max-width sizing
  - Pipelines' node canvas and the code editor's pane system are left
    desktop-shaped on purpose (no reflow) — they just get `overflow: auto`
    so they scroll instead of clipping

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
  - Compose card supports image and file attach (see Chat's composer bullet
    below for the shared mechanics); in Chat mode, attaching then sending
    transfers the staged items into the new thread's composer before
    delegating to Chat's `send()`; not wired for `@brain`/`@pipe` sends

  **Chat**
  - Thread list sidebar: create, switch, delete threads; collapsible via a
    toggle in the top bar (`#sidebar.collapsed`)
  - Slim top bar: thread-name dropdown (switch/create threads) on the left;
    an overflow "⋯" menu (Clear chat, System prompt toggle) on the right
  - Agent dropdown + Model dropdown live in the composer as pill selects,
    not the top bar
  - Collapsible system prompt textarea (persisted per-thread in DB)
  - Streaming chat via ReadableStream (NDJSON)
  - Thinking block: native chunk.message.thinking field (Ollama ≥0.6)
    with <think> tag fallback; toggle-able in Settings
  - Markdown + Prism.js syntax highlighting (JS/TS/Python/Bash/CSS/JSON/SQL/HTML)
  - Assistant messages render as flat text (no bubble card); user messages
    are a solid dark pill
  - Per-message icon row: Copy (functional) + Speak/More (visual
    placeholders, "coming soon" tooltip, no backing behavior) + token
    count/elapsed/t/s when enabled; a small favicon brand mark follows
    each completed assistant reply
  - Composer is a single rounded pill: textarea, then attach file/attach
    folder/mic + Agent/Model pill selects + Send (swaps to Abandon while
    generating). Mic remains a visual placeholder; attach file and attach
    folder are both live:
      • Attach file (`web/chat-attachments.js`, shared by Chat, Home, and
        the Code chat pane): image attach is gated per-model on Ollama
        vision capability (`modelSupportsVision()`, caches a `POST
        /api/show` capabilities lookup); non-vision models show an inline
        "doesn't support image input" alert and refuse to stage. Images are
        downscaled client-side (`resizeImageFile()`, 1280px max edge,
        re-encoded JPEG) before staging, so large photos stay bounded.
        Generic text/code files and PDFs attach on any model — extracted
        text (`extractTextFile()`/`extractPdfFile()`, via pdf.js) is
        appended to the outgoing message as a fenced block, not sent as an
        image. Unsupported binaries (e.g. `.zip`) show an inline
        "Unsupported file type" alert and are not staged. Staged items
        render as removable chips in a strip above the textarea; clipboard
        paste (`bindPasteImages()`) stages images the same way as the
        attach button. Sent images persist on the message (`messages.images`
        column) and render as thumbnails in the sent bubble
        (`renderImageThumbnails()`), surviving reload/restart. Capability
        gating only blocks new attach attempts — an image already staged
        when the model is switched to a non-vision one still sends with the
        message; a non-vision model receiving an image errors as a normal
        chat error bubble.
      • Attach folder ("Change workfolder…") opens the same folder-picker
        modal as the Code section's File-Tree pane (`openFolderPicker()`,
        dynamically imported from `web/code/editor.js`) and calls `PUT
        /api/code-session` to switch the active root.
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
  - `ask_user` — a general-purpose clarifying-question tool (question +
    optional clickable options / multi-select / free text; blocks the tool
    loop until answered) — is unconditionally included in every agentic
    tool loop's tool list (`buildTools()` in `web/app.js`, `buildCodeTools()`
    in `web/code/ai-panel.js`), independent of the file/web/shell/browser
    toggles above; used by Chat, Agents, Home's Brain mode, and Code chat.
    `renderAskUserCard()` scopes its DOM insertion to the surface the tool
    call originated from (an explicit `targetWindow` param in `web/app.js`;
    a closure over that pane's own `chatWindow` element in `ai-panel.js`,
    since each Code chat pane gets its own tool-loop instance) so a question
    asked from one chat surface doesn't render into another; a Task "Run
    now" (`runTask()`) calls `executeTool()` with `targetWindow: null` since
    it has no interactive surface, so `ask_user` there returns a fixed "no
    interactive surface available, proceed using your best judgement"
    string instead of hanging the run

  **Tasks**
  - CRUD editor: name, agent (optional), model, prompt template
  - Template variable chips: {{date}}, {{time}}, {{datetime}}
  - Schedule field: Manual / Every day at [time] / Every week / Every month / Custom cron
  - "Run now": streams response, saves run to DB
  - Run log: last 50 runs per task
  - Scheduler (background thread in server/server.py) fires due tasks

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
  - Dynamic mode (`pipelines.mode='dynamic'`): pipeline settings replace the
    step canvas with a roster picker (multi-select over agents, each showing
    its `role`), optional `verify_command`, `max_turns` (advanced disclosure),
    and `work_dir` (auto-fills to `<root_path>/pipelines/<id>/` on save if left
    blank). Edit view shows a roster card list instead of the step canvas; run
    view shows a turn feed instead of step nodes — each turn card shows the
    invoked agent, the orchestrator's reasoning, the instructions given, live
    output, workspace diff, and verify pass/fail with its tier (1 = real
    command, 2 = QA-role agent, 3 = self-check). Superseded (rewound) turns
    render dimmed/struck-through rather than disappearing. `agents` gain
    `role`/`agent_goal`/`expected_output` fields (Agents tab, under a "Dynamic
    pipeline role" disclosure) used only when that agent is in a dynamic
    roster. `@pipe`/`@pipeline` on Home (mirrors `@brain`) creates a one-off
    dynamic pipeline from the typed goal, snapshotting the current agent
    roster, runs it immediately, and opens its live turn feed.

  **Code**
  - Two backends behind a mode toggle (`#code-mode-bar`): **Editor** (default)
    — a custom-built, AI-native multi-pane editor — and **VS Code** — the
    existing code-server iframe, unchanged
  - Editor mode is a generic, freely-composable pane layout (`web/code/`):
    any number of Chat / Editor / File-Tree panes, resizable via drag
    handles (same mechanics as `#pipe-think-split`), addable/closable via a
    `+` menu, rendered as floating glass cards over an ambient backdrop
    (reusing Home/Pipelines' horizon-glow + dot-grid effect)
  - Layouts: three built-in presets (Focus/Classic/Compare) plus
    user-saved named layouts; current arrangement persists via
    `GET`/`PUT /api/code-layout-state`, named layouts via `GET`/`POST`/
    `DELETE /api/code-layouts[/:name]` (DB-backed — the `codeCurrentLayout`/
    `codeCustomLayouts`/`codePreferredWidths` `localStorage` stand-in from
    the first Editor-mode pass has been fully replaced)
  - Editing engine: CodeMirror 6 (ESM via CDN, no bundler); each open file
    keeps its own `EditorState` (independent undo history) inside a given
    Editor pane; tabs swap state via `view.setState()`
  - AI chat panes: independent conversations, each with model/skill/
    auto-accept-mode (`Off`/`Auto-accept all`/`Auto-accept, ask on risky`)
    controls; skills UI (picker, keyword auto-suggest chip, active-skill
    status banner); ghost-text and inline diff-review are CM6 decorations;
    `Cmd/Ctrl+K` opens a command palette. Each pane also gets its own attach
    button + staging strip (same `web/chat-attachments.js` module and
    per-model vision-capability gating as Chat/Home — see Chat's composer
    bullet above); staged attachments are independent per pane, since each
    Chat pane owns its own `createAttachmentStaging()` instance
  - **Backend-wired** (`web/code/providers.js`): `RealFileProvider` drives
    the File-Tree and Editor panes off the real `/api/fs*` endpoints (same
    sandbox as Chat/Agents' `read_file`/`write_file`/`list_dir` tools);
    `RealAIProvider` streams real Ollama chat with tool-calling. Code chat
    panes get an Agent select (toolbar dropdown, sourced from `/api/agents`)
    that seeds system prompt/tools/model for that pane's conversation, and a
    real tool-calling loop (`read_file`/`list_dir`/`search_files`/
    `run_command`, gated by the agent's file/shell toggles, plus `ask_user`
    always available and `propose_edit`/`propose_new_file`/`propose_rewrite`
    when file access is on). `propose_edit` takes `{path, edit, instructions?}`
    — a lazy region rewrite: the model writes the NEW version of just the
    region it is changing, eliding unchanged spans with `// ... existing
    code ...` marker lines, and starting/ending each region with 1-3
    unchanged anchor lines copied from the file. The deterministic merge
    (`web/code/edit-merge.js`, mirrored byte-for-byte in behavior by
    `agent/edit_merge.py` for the worker/main-chat `edit_file` tool) locates
    each chunk by fuzzy-anchoring its first/last lines (normalized equality,
    then char-LCS similarity ≥ 0.85 with a 0.05 ambiguity margin; 2-line
    context windows rank duplicate candidates) and refuses rather than
    guesses on any unresolved/ambiguous anchor. A refusal falls back to the
    "apply model" (`applyModel` setting: router tier name or Ollama model
    id; panel default = the pane's current chat model, worker default =
    `fast` tier) which regenerates the whole merged file, guarded against
    truncation/lazy placeholders; apply-model output always gets manual hunk
    review (never auto-accept). If that also fails, the model gets a
    grounded error echoing the file's real content (up to the
    `editErrorContentLimit` setting). `propose_edit`/`propose_new_file`
    route through the same
    multi-hunk diff review (`proposeDiff()` in `web/code/editor.js`) as a
    manual edit: hunks render as inline CM6 accept/reject widgets, and the
    buffer is locked read-only (both `EditorView.editable` and
    `EditorState.readOnly`, to also block keymap-bound edit commands and the
    ghost-text Tab-accept) while any hunk in that file is under review. The
    per-pane auto-accept mode (`Off`/`All`/`Risky`) short-circuits that
    review: `All` applies every hunk immediately; `Risky` auto-applies when
    the target file is already open in some Editor pane (edit stays visible
    for the user to catch), and falls back to manual review when it isn't
    (`shouldAutoAccept()` in `ai-panel.js` treats "not open anywhere" as the
    risky case). Ghost text (`web/code/editor.js`'s debounced CM6 completion
    trigger) calls `POST /api/code/ghost-text`, tier-gated by the `codeGhostTextTier`
    setting (Settings tab); Tab accepts, Esc dismisses, and it's likewise
    suppressed while the buffer is read-only. `MockFileProvider`/
    `MockAIProvider` remain in `providers.js` (unused by `panes.js`, kept
    for reference/future reuse) — `RealAIProvider.listSkills()` still
    delegates to `MockAIProvider`'s static skill list.
  - Change workspace folder: the File-Tree pane header (`createTreePane`,
    `web/code/editor.js`) shows the current root's folder name next to a
    "Change…" button; clicking it opens a modal (`openFolderPicker()`) that
    browses directories only (files filtered out) via the same
    `fileProvider.list(path)` the tree itself uses, with Up/"Select this
    folder"/Cancel controls — an in-modal error (e.g. a 400 from server-side
    validation) shows inline and keeps the modal open rather than closing it.
    Selecting a folder calls `panes.js`'s `changeWorkspaceFolder(newPath)`,
    which `PUT`s `/api/code-session {rootPath}`, and on success updates every
    mounted tree pane in the current layout (`refresh(newRootPath,
    newRootLabel)` — re-renders that pane's listing and header label at the
    new root) and clears every mounted editor pane's open tabs
    (`closeAllTabs()`), matching the "start clean on folder switch" decision;
    `changeWorkspaceFolder` also updates `panes.js`'s in-memory `rootPath`/
    `rootLabel` so newly added panes and the next session reload pick up the
    new root. See "atlantis.config.json" above for the server-side validation
    and persistence contract.

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
  - System group: Update (upload a release zip → POST /api/system/update),
    Restart, Stop — see "In-app Update/Restart/Stop" above for the endpoint
    contract; the UI side just POSTs and reports the JSON result

  **Welcome overlay** (one-time, not a nav-rail section)
  - Full-viewport overlay (`#welcome-overlay` in web/index.html, markup +
    styling live alongside the section panels but shown independent of
    `switchSection()`) introducing Atlantis and pointing new users at the
    Models tab to install a model sized for their hardware
  - Gated by `settings.welcomeDismissed`: `maybeShowWelcomeOverlay()` runs once
    at startup and un-hides the overlay only if the flag is falsy; the "Got
    it" button hides it and persists `{welcomeDismissed: true}` via the
    existing generic `POST /api/settings` — no dedicated endpoint

### Files

  main/
  ├── web/
  │   ├── index.html                — shell, nav rail, section panels, CDN tags,
  │   │                                welcome overlay markup
  │   ├── style.css                 — dark-only theme, all section styles
  │   ├── app.js                    — all frontend logic
  │   ├── agent-client.js           — shared runAgentTurn()/renderAskUserCard()
  │   │                                client for the server-side agent-run loop
  │   │                                (Chat/Editor/Task-runner/Brain mode)
  │   └── favicon.ico
  ├── server/
  │   └── server.py                 — HTTP server + SQLite CRUD + scheduler + SSE +
  │                                    atlantis.config.json loader + /api/system/*
  ├── agent/
  │   └── worker.py                 — job daemon: pipeline executor, model router
  ├── data/                         — gitignored except .gitkeep
  │   ├── data.db                   — SQLite database (WAL mode, auto-created)
  │   ├── zone/
  │   ├── ollama/                   — no-root Linux Ollama install (bin/, models/)
  │   ├── certs/
  │   ├── launcher.pid
  │   └── .restart / .stop          — flag files launcher.py polls
  ├── launcher.py                   — process supervisor
  ├── install.py                    — first-time setup wizard
  ├── atlantis.config.json          — gitignored: {port, root_path}
  ├── start.sh / stop.sh / restart.sh            (Linux)
  ├── start.command / stop.command / restart.command  (macOS)
  ├── start.bat / stop.bat / restart.bat         (Windows)
  ├── install.sh / install.command / install.bat — bootstrap launchers for install.py
  ├── plans/                        — .md plan files
  └── .claude/

### Database schema (data.db)

  settings          key / value (JSON-encoded)
  agents            id, name, model, system_prompt, temperature, top_p, context_len,
                    file_access, web_access, tools (JSON), fallback_model,
                    role, agent_goal, expected_output (dynamic-pipeline-only, nullable)
  threads           id, name, model, agent_id, system_prompt, updated_at, tools
  messages          id, thread_id, role, content, thinking, tokens, eval_duration, created_at,
                    images (TEXT, JSON array of base64-encoded image strings, default '[]')
  tasks             id, name, model, agent_id, prompt_template, schedule (JSON), created_at
  task_runs         id, task_id, started_at, finished_at, output, tokens, error

  pipelines         id, name, goal, pm_agent_id, pm_model, schedule, pause_on_fail,
                    feedback_loop, layout (JSON), created_at,
                    mode ('fixed'|'dynamic', default 'fixed'), roster (JSON agent-id array),
                    verify_command, max_turns (default 20), work_dir
  pipeline_steps    id, pipeline_id, step_index, name, agent_id, agent_name, task,
                    handover_fields (JSON), quality_criteria (JSON), pass_full_output,
                    agent_input, model_tier, loop_config (JSON)
  pipeline_runs     id, pipeline_id, status, started_at, finished_at, error
  pipeline_step_runs id, run_id, step_id, step_index, step_name, agent_name, status,
                    output, handover_data, pm_notes, qa_verdict, qa_reason,
                    retry_count, started_at, finished_at, iteration

  pipeline_turns    id, run_id, turn_index, agent_id, agent_name,
                    action ('invoke'|'verify'|'done'|'fail'), instructions, reasoning,
                    output, workspace_diff, verify_status ('passed'|'failed'),
                    superseded_by (turn_index of the rewind that invalidated this turn),
                    status, started_at, finished_at
                    — the dynamic-mode analog of pipeline_step_runs; unused when mode='fixed'

  jobs              id, pipeline_id, status, output_log (NDJSON event stream),
                    error, parent_job_id (legacy), loop_depth (legacy),
                    created_at, started_at, finished_at
                    status ∈ queued|running|done|failed|paused|cancelling|cancelled

  code_sessions     id, root_path, open_files, active_file, updated_at
  code_layouts      name (PK), panes_json, updated_at
  code_layout_state id (PK, default 'default'), current_layout_name, panes_json
                    (default '[]'), preferred_widths_json (default '{}'), updated_at
                    — singleton row ('default'), auto-inserted by init_db()

  network_hosts     id, name, ip, mac, ollama_port, priority, enabled, created_at,
                    os (macos|linux|windows, nullable), gpu_arch (nvidia|apple_silicon|
                    amd|cpu_only, nullable), ssh_user

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
  PUT  /api/code-session          update session; a truthy rootPath is validated
                                  (must exist, be a directory, and resolve under
                                  the home-directory fence) — 400 {"error"} if
                                  not, 500 {"error"} if atlantis.config.json can't
                                  be written; on success the new root_path is
                                  written to both the DB row and the config file
  GET  /api/code-layouts          list saved layouts → [{name, panes}]
  POST /api/code-layouts          upsert a named layout, body: {name, panes} →
                                  {ok:true} | {error:'name required'} (400)
  DELETE /api/code-layouts/:name  delete a named layout → {ok:true}
  GET  /api/code-layout-state     the single current-arrangement row →
                                  {currentLayoutName, panes, preferredWidths}
                                  (defaults to {null, [], {}} if never written)
  PUT  /api/code-layout-state     upsert the current-arrangement row, body:
                                  {currentLayoutName, panes, preferredWidths} → {ok:true}
  POST /api/code/ghost-text       body: {prefix, suffix, path} → {completion} |
                                  {completion:'', error} on failure (never a non-200
                                  status — errors are reported in-body so the CM6
                                  trigger can fail silently); model tier resolved from
                                  settings.codeGhostTextTier (default 'local') via the
                                  same resolve_llm()/model_router used by pipelines;
                                  language inferred from path's extension for the
                                  prompt; response has markdown code fences stripped

  POST /api/system/update         body: raw zip bytes → stage+swap web/server/agent →
                                  touch data/.restart → {ok:true} | {error}
  POST /api/system/restart        touch data/.restart (launcher.py picks it up) → {ok:true}
  POST /api/system/stop           touch data/.stop (launcher.py picks it up) → {ok:true}

  GET  /*                         static file serving

### Agent runs (Chat / Editor / Task runner / Brain mode)

  Chat, the code editor's AI panel, the Task runner, and Home's Brain mode all
  share one server-side agentic-loop implementation with pipelines —
  `agent/worker.py`'s `ollama_agentic()` — instead of each running its own
  client-side copy. The loop itself is unchanged; what differs is how its
  optional hooks are wired:

  - Pipelines: `emit`/`is_cancelled` default to `log_event()`/DB polling
    against the `jobs` table (unchanged), `unload_after=True` (model evicted
    after every call).
  - Chat/Editor/Task-runner/Brain: `server.py` wires `emit` to an in-memory
    `queue.Queue`, `is_cancelled` to an in-memory flag, and passes
    `unload_after=False` (model stays warm between turns). Run state lives
    entirely in a module-level `_AGENT_RUNS` dict in `server.py`, keyed by a
    UUID `run_id` — **no DB table, no durability**: a lost connection or
    server restart abandons the run (by design; these are interactive,
    single-session calls, not queued background jobs like pipelines).

  `ask_user` (all four surfaces) and the Editor's `propose_edit` /
  `propose_new_file` / `propose_rewrite` (diff-review tools that manipulate
  the live Monaco editor) never run server-side — the loop calls a
  `request_client_tool(name, args)` hook instead of `exec_tool()`, which
  blocks (polling a `threading.Event`, bounded by a ~30-minute idle timeout)
  until the browser answers via `POST .../tool_result`. Every other tool
  (`read_file`, `run_command`, `search_files`, browser_* tools, etc.) executes
  in-process via the same `exec_tool()` pipelines use.

  POST /api/agent/runs            {messages, tools, model, num_ctx?, options?,
                                   think?, client_tool_names?} → {run_id};
                                   spawns a background thread running
                                   ollama_agentic() with the hooks above
  GET  /api/agent/runs/:id/stream SSE stream of the run's events (see below);
                                   a client write failure here (browser closed)
                                   self-cancels the run — the same flag
                                   POST .../cancel sets
  POST /api/agent/runs/:id/tool_result  {tool_call_id, result} → resumes a
                                   run blocked in request_client_tool; 404 if
                                   the run is gone, 409 if tool_call_id
                                   doesn't match the currently-pending call
  POST /api/agent/runs/:id/cancel  sets the run's cancelled flag → {ok:true}

  Client-side, `web/agent-client.js`'s `runAgentTurn()` is the single shared
  entry point for all four surfaces (`fetch`+`ReadableStream` against
  `.../stream`, same convention as the pipeline SSE reader — not
  `EventSource`), replacing what used to be four separate
  `while(looping){ fetch ollama directly }` client-side loops.

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
  6. server/server.py /api/jobs/:id/stream tails output_log every 400ms and pushes SSE

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
  turn_start             {turnIndex, action, agentName, reasoning, instructions}
  turn_done              {turnIndex, status, error?}
  verification_result    {turnIndex, status, tier}
  verification_override  {turnIndex}    — orchestrator said done but the code-enforced gate forced a verify instead
  turn_superseded        {rootCauseTurn, byTurn}
                         (dynamic-mode only; run_start additionally carries {mode:'dynamic'} instead of {totalSteps})
  error          {message}

  Legacy (no longer emitted, UI still replays them from old logs):
  loop_spawned {childJobId, depth, stepIndex} · loop_stopped {stepIndex, depth}
  · loop_max_depth {depth, stepIndex}

  Agent-run events (emitted by ollama_agentic() for both pipelines and the
  in-memory agent runs above — pipelines silently ignore the ones their
  replay UI doesn't switch on, since these are additive):
  step_thinking       {stepIndex, chunk}       — <think> token stream, mirrors step_chunk
  tool_calls_started  {stepIndex, calls:[{tool, args}]}  — fired once per round,
                      right before that round's tool calls execute, so a
                      client can render every call in the round as one
                      grouped "Running…" bubble (existing tool_call events,
                      one per call, then fill in each result)
  tool_call_pending   {tool, args, toolCallId} — a client-only tool
                      (ask_user/propose_*) is blocked waiting on
                      POST .../tool_result with a matching tool_call_id
  done                {content}                — agent-run terminal success
                      (pipelines don't emit this; they use run_done instead)
  error               {message}                — reused for both pipeline
                      run-level failures and agent-run terminal failures

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
  ✓ 7.  Schedule backend — server/server.py scheduler reads/writes SQLite
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
  ✓ 14. Worker daemon (agent/worker.py) — background job execution, decoupled from HTTP thread
  ✓ 15. Jobs table + SSE stream — enqueue → stream → replay on reconnect
  ✓ 16. Model router — per-step tier (local/fast/smart/powerful/auto), router config in settings
  ✓ 17. Anthropic API support — streaming + tool use via /v1/messages
  ✓ 18. Loop primitive — evaluator-driven in-process loop (done/iterate/fail verdict,
        backToStep, termination stack); replaced child-job spawning + stop-condition eval
  ✓ 19. Job tree UI — history panel with per-iteration grouping in run detail
        (legacy loop-child hierarchy still renders for old jobs)
  ✓ 21. Job cancellation — POST /api/jobs/:id/cancel, worker checks between steps,
        ◼ Stop button cancels server-side (previously only detached the stream)
  ✓ 20. systemd user services — deploy/legacy/setup-services.sh, auto-restart on
        crash (superseded as the primary path by launcher.py + install.py, see 23-30;
        kept under deploy/legacy/ for reference)
  ✓ 22. Models tab — hub browser + installed list, hardware fit badges,
        streaming install, delete (plans/model-selector-tab.md)
  ✓ 23. Directory reorg — web/ (frontend), server/ (server.py), agent/ (worker.py),
        deploy/legacy/ (old systemd deployment), data/ (all mutable/host-specific
        state); plans/, docs/, CLAUDE.md, system_design.md unmoved
  ✓ 24. atlantis.config.json + config loader — root-level gitignored {port,
        root_path}; server/server.py's load_config() defaults on missing/malformed
        JSON (including non-dict-but-valid JSON); root_path mirrored into
        code_sessions on every boot, making the file authoritative over the DB
  ✓ 25. launcher.py process supervisor — supervises server + worker (+ optional
        no-root Linux Ollama); PID file; .restart/.stop flag files polled every
        1s; supervisor mode (blocking loop, autostart entry point) + control
        mode (--start/--stop/--restart CLI); clears stale flags on fresh start
  ✓ 26. Per-OS start/stop/restart wrapper scripts — .sh (Linux)/.command
        (macOS)/.bat (Windows), one-liners around launcher.py --start/--stop/--restart
  ✓ 27. In-app Update/Restart/Stop — Settings "System" group; POST
        /api/system/update (zip validation → stage-then-swap web/server/agent →
        touch .restart), /api/system/restart, /api/system/stop (touch flag files)
  ✓ 28. install.py first-time setup wizard — OS detect, workspace root_path
        prompt, optional per-OS Ollama auto-install (macOS zip / Windows silent
        exe / Linux no-root tar.zst via system zstd), optional autostart
        registration (launchd/systemd user unit/Task Scheduler), writes data/ +
        atlantis.config.json, calls server/server.py's init_db() directly,
        starts launcher.py detached
  ✓ 29. Per-OS bootstrap launchers — install.sh/install.command/install.bat:
        check for python3 (OS-appropriate install guidance if missing), run
        python3 install.py
  ✓ 30. One-time welcome overlay — full-viewport overlay in web/index.html/app.js/
        style.css, gated by settings.welcomeDismissed via the existing generic
        /api/settings endpoint
  ✓ 31. Portability fixes — _fs_safe()/_pipe_path_safe() in server/server.py use
        Path.home() instead of a hardcoded /home fence (fixes macOS/Windows);
        server/server.py has `from __future__ import annotations` for Python
        3.9 compatibility (the module uses `X | None` type hints)
  ✓ 32. Change workspace folder — File-Tree pane "Change…" button +
        folder-picker modal (existing directories only, home-directory
        fence); PUT /api/code-session validates a provided rootPath and, on
        success, persists it to both code_sessions and atlantis.config.json
        (_write_config_root_path()) so it survives a restart; on success all
        mounted tree panes reload at the new root and all editor panes close
        their tabs (closeAllTabs())

---

## 3. Decisions (locked)

  - Nav rail: icon only, tooltip on hover
  - Home is the default section on load/refresh
  - Scroll position: restored per section on tab switch
  - Agent selection in Chat: separate dropdown alongside model dropdown
  - Task run log: last 50 runs per task, pruned in DB
  - Prompt timeout: hours unit, 0 = disabled, default 5h
  - server/server.py is the entry point (replaces python3 -m http.server 5000)
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
  - No per-OS package manager (brew/choco/apt) as the install mechanism —
    install.py is a plain stdlib Python script, consistent with "no Docker"
  - atlantis.config.json (not a DB row, not an env var) is the one
    user-editable, gitignored source of truth for port/root_path;
    server/server.py mirrors root_path into the DB so the rest of the
    codebase can keep reading it from SQLite like every other setting
  - agent/worker.py never reads atlantis.config.json directly — it only ever
    gets root_path via the DB, so server/server.py stays the single writer
  - launcher.py, not systemd/launchd/Task Scheduler directly, is what's
    supervised by the OS — the OS-level entry just runs `python3 launcher.py`
    once; restart/crash-recovery logic lives in one cross-platform script
    instead of three OS-specific service definitions
  - Control-plane communication with a running supervisor is via flag files
    (data/.restart, data/.stop) polled once a second, not signals or a socket
    — simplest thing that works identically on all three OSes
  - is_alive() checks PID existence only, not process identity — accepted
    PID-reuse race rather than solved, since a portable identity check isn't
    available in stdlib across macOS/Linux/Windows
  - In-app update stages web.new/server.new/agent.new and only swaps them in
    after all three copy successfully — never delete-then-copy in place
  - Linux Ollama install is no-root: downloaded under data/ollama/, run via
    `ollama serve` with OLLAMA_MODELS pointed at data/ollama/models, launched
    by launcher.py only if that binary exists and 11434 isn't already taken
  - _fs_safe()/_pipe_path_safe() fence file access to Path.home(), not a
    hardcoded /home — portability requirement once macOS/Windows were in scope
  - HTTPS/certs are back in scope for install.py (supersedes the prior
    "dropped for friend installs" decision) — self-signed, installer-
    generated, best-effort; a failure just means plain HTTP, never blocks
    install
  - code-server is installed/supervised by install.py/launcher.py
    (standalone, no-root, under data/code-server/), replacing the
    superseded deploy/legacy/atlantis-code-server.service as the actual
    running mechanism; deploy/legacy/ itself is left untouched as reference
  - Both HTTPS cert generation and code-server are skipped entirely on
    Windows (no bundled openssl; code-server's official Windows support is
    WSL-only) rather than partially supported
  - Exact-string (old_string/new_string) AI editing is retired (2026-07-19):
    small local models can't reproduce file content verbatim, no matter how
    much error-feedback scaffolding is stacked on top. All AI edits
    (`edit_file` in worker/main chat, `propose_edit` in the code editor) are
    lazy region rewrites — new region content with "..." elision markers and
    1-3 unchanged anchor lines at each region edge — resolved by the
    mirrored merge modules `agent/edit_merge.py` / `web/code/edit-merge.js`
    (keep the two behaviorally identical; thresholds: similarity 0.85,
    ambiguity margin 0.05). The merge refuses rather than guesses; refusals
    fall back to the `applyModel` (settings key, tier or model id) full-file
    regeneration with truncation/placeholder guards, then to a grounded
    error. Apply-model output never auto-accepts in the editor panel.

---

## 4. Next / Future Work

  - WebSocket upgrade (bidirectional streaming; job cancel now solved via
    POST /api/jobs/:id/cancel + worker polling)
  - OpenAI provider implementation in agent/worker.py (route already exists, LLM calls not yet)
  - Pipeline scheduler (run pipeline on cron, not just manual trigger)
  - Multi-worker parallelism (claim_job already atomic — just run N workers)
  - Model router settings UI (edit tiers from Settings page without raw JSON)
  - Attach files/images to chat messages (multimodal models)
  - Compare two models side-by-side in Chat
  - Rename threads
