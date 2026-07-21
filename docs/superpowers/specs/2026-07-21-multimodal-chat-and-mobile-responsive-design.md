# Multimodal chat input + mobile responsive layout — Design

Two independent pieces of work, specced together because they were requested
together. Each can be planned/implemented/merged on its own schedule.

## Part 1: Multimodal chat input

### Purpose

Wire up real functionality behind the Chat tab's inert placeholder buttons
(`attach-file-btn`, `attach-folder-btn` — `class="placeholder"`, "coming
soon" tooltips) and bring the same capability to the two other interactive
chat surfaces that currently have no attach affordance at all: the Home page
composer and the code editor's AI chat pane (`web/code/ai-panel.js`).

### Scope

**In scope:**
- Image attach (click-to-browse + clipboard paste) for Ollama vision models,
  in Chat, Home, and the code editor chat pane
- Generic text/code file attach (click-to-browse + clipboard paste), content
  inserted as prompt context, works with any model, same three surfaces
- PDF text extraction via a new CDN-loaded `pdf.js`, folded into the generic
  file path
- Renaming/rewiring `attach-folder-btn` to **"Change workfolder"** in the
  Chat tab, reusing the folder-picker + persistence mechanism already built
  for the code editor (see "Change workfolder button" below)
- Per-model vision-capability gating via Ollama's `/api/show`

**Out of scope:**
- Drag-and-drop attach
- Voice/mic input (`mic-btn` stays a placeholder)
- Folder-of-files ingestion as chat context (distinct from "Change
  workfolder", which changes the workspace root, not chat context)
- Anthropic vision — not needed: all three interactive chat surfaces talk to
  Ollama directly today (`server/server.py`'s chat-stream handler and
  `web/code/providers.js`'s `RealAIProvider` both call Ollama's `/api/chat`
  only). Anthropic is used server-side only for Pipelines, which this spec
  doesn't touch.

### Data model

Add `messages.images` (`TEXT`, JSON array of base64 strings, default
`'[]'`/`NULL`) — additive column, no migration risk to existing rows.
Generic file/PDF content needs no schema change: it's inserted as plain text
into the existing `content` column, the same way any other prompt text is.

### Client-side image handling

On pick or paste, an image is:
1. Decoded via `FileReader` → `<canvas>`, resized so its longest edge is
   ≤ ~1280px, re-encoded as JPEG (~0.85 quality) — keeps the base64 payload
   (and the DB row) reasonably sized regardless of the source photo's
   resolution
2. Staged as a thumbnail chip above the composer (with a remove button),
   alongside any other staged images/files for that not-yet-sent message
3. On send, bundled into the request as `{mime, base64}` entries; the server
   passes them straight through as Ollama's per-message `images` array
   (raw base64 strings, no data-URI prefix)
4. Persisted into the new `messages.images` column; chat history re-render
   shows stored images as thumbnails in the user bubble, click-to-enlarge

Oversized originals (very large paste/screenshot) are still bounded by the
resize step above — no separate hard reject needed given the resize always
runs first.

### Client-side generic file / PDF handling

A file is treated as attachable text if either its extension matches a
whitelist (`.txt .md .py .js .ts .json .csv .log .yml .yaml .css .html .sh`
etc.) or, for extensionless/ambiguous files, a decode sanity check confirms
it's valid UTF-8 text. Matched files are read as text and inserted into the
outgoing message as a fenced block labeled with the filename. PDFs go
through `pdf.js` (new `<script>` CDN tag in `index.html`, matching the
existing Marked/Prism/Monaco pattern) to extract text first, then follow the
same fenced-block path. Anything else (binary, unrecognized) is rejected
client-side with an inline message before staging.

Extracted text longer than a size threshold (reuse the existing
`editErrorContentLimit`-style truncation convention, ~8–16k chars) is
truncated with a trailing "(truncated)" marker rather than growing the
prompt unbounded.

### Vision capability gating

A small client-side cache (`Map<model, capabilities>`) is populated by
calling Ollama's `/api/show` (`{name: model}` → response includes a
`capabilities` array, containing `"vision"` when supported) once per model
per session, not on every keystroke. The image-attach affordance in each
composer is enabled/disabled based on the *currently selected* model's
cached capability; switching models re-checks the cache. Generic file/PDF
attach has no such gating — it's plain prompt text and works with any model.

### Shared module

The resize/paste/staging/capability-cache logic is factored into one new
module, `web/chat-attachments.js`, rather than written three times:
- `app.js` (plain `<script>`, non-module) pulls it in as a normal script and
  calls its exported functions directly (attached to a shared global, or via
  a small non-module-compatible wrapper — whichever keeps `app.js`'s
  existing non-module structure intact)
- `web/code/ai-panel.js` (ES module) `import`s it directly

### Per-surface wiring

**Chat tab** (`web/index.html`, `web/app.js`): `attach-file-btn` drops
`class="placeholder"`, opens a hidden `<input type="file" multiple>`, routes
picks through the image or generic-file path based on MIME/extension,
renders the staging strip above `#user-input`. A `paste` listener on
`#user-input` handles clipboard images. `attach-folder-btn` is relabeled
"Change workfolder" and rewired per the section below.

**Home page** (`web/index.html`, `web/app.js`): adds an image-attach and a
file-attach icon button to `#home-compose-toolbar` (currently has none),
same staging strip above `#home-input`, same paste handling. No "Change
workfolder" button here — that stays a Chat/code-editor concept.

**Code editor chat pane** (`web/code/ai-panel.js`): adds the same two icon
buttons to `.code-chat-toolbar` next to the existing send button, staging
strip above `.code-chat-input`.

### Change workfolder button

The Chat tab's `attach-folder-btn` is relabeled "Change workfolder" and
wired to the mechanism the code editor already has (built per
`docs/superpowers/specs/2026-07-14-change-workspace-folder-design.md`):
`openFolderPicker()` from `web/code/editor.js`, pulled into `app.js` via a
dynamic `import()` on first use (since `app.js` is a plain script and
`editor.js` is an ES module), followed by `PUT /api/code-session
{rootPath: newPath}` — the same endpoint `web/code/panes.js`'s
`changeWorkspaceFolder()` already calls, which persists to both
`atlantis.config.json` and the `code_sessions` DB row and already validates
the path server-side. No backend change needed for this part — it's UI
wiring reusing an existing, already-hardened endpoint.

### Error handling

| Failure | Behavior |
|---|---|
| Non-text, non-PDF, non-image file picked/pasted | Rejected client-side before staging, inline message naming the file |
| Image attached while selected model lacks vision (race: model switched after staging) | Server/Ollama error surfaces as a normal chat error bubble, same as any other generation failure |
| `/api/show` capability lookup fails (model unreachable, etc.) | Treated as "unknown" → image-attach affordance stays disabled for that model rather than assumed-enabled |
| Extracted text exceeds size threshold | Truncated with a trailing marker, not rejected |
| "Change workfolder" picker/PUT fails | Same inline-error behavior as the existing code-editor flow (modal stays open, no state mutated) |

---

## Part 2: Mobile responsive layout

### Purpose

The app currently has zero `@media` queries — `web/style.css` assumes a
fixed-width desktop shell (`#nav-rail` permanently 52px, `#sidebar`/
`.section-sidebar` permanently 220px). This adds a phone-width layout mode:
a hamburger-collapsible nav and real single-column layouts for the app's
core sections, without attempting to redesign the sections that are
inherently desktop-shaped.

### Scope

**In scope:** one phone breakpoint; hamburger overlay nav; single-column /
drill-down layouts for Home, Chat, Agents, Skills, Tasks, Plans, Pipelines'
list view, Models, Settings.

**Out of scope (best-effort only):** the Pipelines node canvas and the code
editor's multi-pane layout keep their current desktop CSS; on phone they
become scrollable/pinch-zoomable within their panel rather than reflowed.
No tablet-specific breakpoint.

### Breakpoint

Single `@media (max-width: 720px)` tier.

### Navigation

`#nav-rail` is hidden under the breakpoint. A new fixed top bar (hamburger
button + current section name) appears instead. Tapping the hamburger slides
the *same* `#nav-rail` markup in as a fixed-position overlay with a
backdrop, via a new `.open` class — no duplicated markup, no changes to
`switchSection()`. Picking a section or tapping the backdrop closes the
drawer.

### List+detail sections (Agents, Skills, Tasks, Plans, Pipelines' list,
Models)

These already share one structural pattern: a `.section-sidebar` list next
to a `-main`/`.editor-area` detail pane that starts in an empty state until
something is selected. Under the breakpoint this becomes drill-down: the
list is shown full-width by default; selecting an item hides the list and
shows the detail pane full-width, with a new mobile-only "← Back" button
that returns to the list. This is expressed as a small number of generic
CSS rules keyed off a shared class pattern, not bespoke per-section CSS, and
rides on selection state each section already tracks (`activeAgentId`,
`activeTaskId`, etc.) — only the visibility toggle is new.

### Chat

Structurally different: the chat window is usable with nothing selected in
the thread list, so drill-down doesn't fit. `#sidebar` already has a
`.collapsed` class and a toggle button (`sidebar-toggle-btn`). Under the
breakpoint, `.collapsed` (and its inverse) switch from "shrink to 0 width
in the flex row" to "fixed-position slide-over with a backdrop, ~85vw wide"
— same JS/state, different CSS. Defaults to collapsed on phone.

### Home

Already single-column and centered (`#home-inner`, `max-width: 620px`).
Needs padding/font-size adjustments for narrow width and
`#home-compose-toolbar` allowed to wrap onto a second row instead of
overflowing.

### Composer rows & message bubbles (all chat surfaces)

Fixed pixel `max-width`s on bubbles become percentage-based under the
breakpoint. Composer toolbars (attach/agent/model/send) wrap instead of
overflowing horizontally.

### Settings

Already a single scrolling form column with no sidebar — needs width/
padding adjustments only, no structural change.

### Testing

No automated test suite in this repo — verification is `node --check` /
`node --input-type=module --check` syntax validation on touched JS, plus a
manual walkthrough of both parts: on Part 1, attach an image to a vision
model and a non-vision model, attach a text file and a PDF, paste an image,
switch models mid-compose, reload a thread and confirm images/re-render;
on Part 2, resize the browser (or use device emulation) across the
breakpoint on each affected section and confirm the drawer/drill-down/
wrapping behavior.
