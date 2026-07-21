# Multimodal Chat Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real image + generic-file/PDF attach into Chat, Home, and the code editor chat pane, with per-model Ollama vision-capability gating, and rewire the Chat tab's "Attach folder" placeholder into a working "Change workfolder" button.

**Architecture:** A new plain script `web/chat-attachments.js` (loaded like `app.js`, not an ES module — matching the existing convention where `web/code/ai-panel.js` already consumes `app.js` globals such as `api()`/`escHtml()`/`resolveOllama()` ambiently) provides image downscaling, text/PDF extraction, an Ollama `/api/show`-backed vision-capability cache, and a `createAttachmentStaging()` factory used independently by all three composers. All three interactive chat surfaces call Ollama's `/api/chat` directly from the browser today (confirmed: no server-side LLM proxying for interactive chat) — the client puts staged images straight into the per-message `images` array Ollama already understands. `messages.images` (new DB column) makes it round-trip through thread reloads for the Chat tab (Home reuses Chat's `send()` for its normal path); the code editor's chat pane is in-memory only, so no DB change reaches it. "Change workfolder" is pure UI wiring onto the already-built `openFolderPicker()` / `PUT /api/code-session` mechanism from `docs/superpowers/specs/2026-07-14-change-workspace-folder-design.md` — no backend change needed for that part.

**Tech Stack:** Vanilla JS (no bundler), Python stdlib `server/server.py`, SQLite. New CDN dependency: `pdfjs-dist` (matching the existing Marked/Prism/Monaco CDN-script convention).

## Global Constraints

- No npm install, no bundler — CDN `<script>` tags only, same as the rest of the app.
- `messages.images` is additive (`ALTER TABLE ... ADD COLUMN`, default `'[]'`) — no destructive migration, no data loss for existing rows.
- No Anthropic vision work — all three interactive chat surfaces call Ollama directly; Anthropic is untouched (Pipelines-only, per `system_design.md`).
- No drag-and-drop, no voice/mic wiring, no folder-of-files-as-context ingestion — out of scope per the design spec.
- Images are downscaled client-side (max long edge ~1280px, JPEG ~0.85 quality) before ever reaching base64/the DB — keeps the DB reasonably sized without a hard size-reject.
- No automated test suite in this repo — verification is `node --check` / `node --input-type=module --check` syntax validation, `python3 -m py_compile`, and curl/manual walkthroughs, matching the convention in `docs/superpowers/plans/2026-07-14-change-workspace-folder-plan.md`.

---

### Task 1: Backend — persist `images` on messages

**Files:**
- Modify: `server/server.py:307` (migrations list)
- Modify: `server/server.py:1389-1401` (`_post_messages`)
- Modify: `server/server.py:1410-1417` (`_msg_out`)

**Interfaces:**
- Produces: `messages.images` DB column (`TEXT`, JSON array of base64 strings, default `'[]'`); `_msg_out(m)` now includes an `images` key (`list[str]`, possibly empty) in every message payload the frontend receives — consumed by Task 3's `renderChat()`/`addBubble()`.

- [ ] **Step 1: Add the migration**

In `server/server.py`, the migrations list currently ends (`server/server.py:306-307`):

```python
            'ALTER TABLE network_hosts ADD COLUMN gpu_name TEXT',
        ]:
```

Replace with:

```python
            'ALTER TABLE network_hosts ADD COLUMN gpu_name TEXT',
            "ALTER TABLE messages ADD COLUMN images TEXT DEFAULT '[]'",
        ]:
```

- [ ] **Step 2: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -m py_compile server/server.py
```

Expected: no output, exit code 0.

- [ ] **Step 3: Store `images` on insert**

`_post_messages` currently reads (`server/server.py:1389-1401`):

```python
    def _post_messages(self, thread_id, body):
        # body is a single message or list
        msgs = body if isinstance(body, list) else [body]
        now  = datetime.datetime.now().isoformat()
        with get_db() as db:
            for m in msgs:
                db.execute(
                    'INSERT INTO messages (id,thread_id,role,content,thinking,tokens,eval_duration,created_at) VALUES (?,?,?,?,?,?,?,?)',
                    (m.get('id', str(time.time_ns())), thread_id, m['role'],
                     m.get('content',''), m.get('thinking'), m.get('tokens'), m.get('evalDuration'), now)
                )
            db.execute('UPDATE threads SET updated_at=? WHERE id=?', (now, thread_id))
        self._json({'ok': True})
```

Replace with:

```python
    def _post_messages(self, thread_id, body):
        # body is a single message or list
        msgs = body if isinstance(body, list) else [body]
        now  = datetime.datetime.now().isoformat()
        with get_db() as db:
            for m in msgs:
                db.execute(
                    'INSERT INTO messages (id,thread_id,role,content,thinking,tokens,eval_duration,images,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                    (m.get('id', str(time.time_ns())), thread_id, m['role'],
                     m.get('content',''), m.get('thinking'), m.get('tokens'), m.get('evalDuration'),
                     json.dumps(m.get('images') or []), now)
                )
            db.execute('UPDATE threads SET updated_at=? WHERE id=?', (now, thread_id))
        self._json({'ok': True})
```

- [ ] **Step 4: Return `images` on read**

`_msg_out` currently reads (`server/server.py:1410-1417`):

```python
    def _msg_out(self, m):
        meta = None
        if m.get('tokens'):
            meta = {'eval_count': m['tokens'], 'eval_duration': m.get('eval_duration')}
        return {
            'id': m['id'], 'role': m['role'], 'content': m['content'],
            'thinking': m.get('thinking'), 'meta': meta,
        }
```

Replace with:

```python
    def _msg_out(self, m):
        meta = None
        if m.get('tokens'):
            meta = {'eval_count': m['tokens'], 'eval_duration': m.get('eval_duration')}
        try:
            images = json.loads(m.get('images') or '[]')
        except (TypeError, json.JSONDecodeError):
            images = []
        return {
            'id': m['id'], 'role': m['role'], 'content': m['content'],
            'thinking': m.get('thinking'), 'meta': meta, 'images': images,
        }
```

- [ ] **Step 5: Verify syntax again**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -m py_compile server/server.py
```

Expected: no output, exit code 0.

- [ ] **Step 6: Manual verification with curl**

```bash
cd /Volumes/library/projects/atlantis_os
python3 server/server.py &
SERVER_PID=$!
sleep 1

echo "--- create a thread ---"
curl -s -X POST http://localhost:5000/api/threads -H 'Content-Type: application/json' \
  -d '{"id":"t-imgtest","name":"img test","model":"llava"}'

echo "--- post a user message with a fake base64 image ---"
curl -s -X POST http://localhost:5000/api/threads/t-imgtest/messages -H 'Content-Type: application/json' \
  -d '{"id":"m-imgtest","role":"user","content":"whats in this","images":["Zm9v"]}'

echo "--- confirm images round-trip ---"
curl -s http://localhost:5000/api/threads/t-imgtest/messages

echo "--- confirm a message with no images still returns images: [] ---"
curl -s -X POST http://localhost:5000/api/threads/t-imgtest/messages -H 'Content-Type: application/json' \
  -d '{"id":"m-noimg","role":"user","content":"no image here"}'
curl -s http://localhost:5000/api/threads/t-imgtest/messages

curl -s -X DELETE http://localhost:5000/api/threads/t-imgtest > /dev/null
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
```

Expected: the messages list shows `"images": ["Zm9v"]` for `m-imgtest` and `"images": []` for `m-noimg`.

- [ ] **Step 7: Commit**

```bash
git add server/server.py
git commit -m "Persist per-message image attachments in the messages table"
```

---

### Task 2: Shared attachment module — resize, extract, capability cache, staging UI

**Files:**
- Create: `web/chat-attachments.js`
- Modify: `web/index.html:695-704` (CDN scripts — add `pdfjs-dist`), `web/index.html:717` (add the new script tag before `app.js`)
- Modify: `web/style.css` (new rules appended at end of file)

**Interfaces:**
- Consumes: ambient globals already defined by `web/app.js` — `escHtml(s)` (`web/app.js:116`), `resolveOllama()` (`web/app.js:21`, returns the live Ollama base URL) — same ambient-global convention `web/code/ai-panel.js` already relies on.
- Produces (all plain global functions/classes, no `export`, consumed directly by `web/app.js` and, ambiently, by the ES module `web/code/ai-panel.js`):
  - `isImageFile(file) -> boolean`
  - `isPdfFile(file) -> boolean`
  - `resizeImageFile(file) -> Promise<{mime: string, base64: string, previewUrl: string}>`
  - `extractTextFile(file) -> Promise<{name: string, text: string} | null>`
  - `extractPdfFile(file) -> Promise<{name: string, text: string}>`
  - `modelSupportsVision(model) -> Promise<boolean>`
  - `createAttachmentStaging(stripEl) -> { addFiles(fileList, {model}), getImages(), getFileText(), isEmpty(), clear(), getItemsForTransfer(), loadTransferred(items) }`
  - `bindPasteImages(el, staging, getModel)`

- [ ] **Step 1: Add the pdf.js CDN scripts and the new module's script tag**

`web/index.html`'s CDN script block currently reads (`web/index.html:695-704`):

```html
  <script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/prism.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-typescript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-css.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-json.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-sql.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-markup.min.js"></script>
```

Replace with (adds two lines for `pdfjs-dist`):

```html
  <script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/prism.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-typescript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-css.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-json.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-sql.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-markup.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>
```

`web/index.html`'s app scripts currently read (`web/index.html:717-718`):

```html
  <script src="app.js"></script>
  <script type="module" src="code/panes.js"></script>
```

Replace with:

```html
  <script src="chat-attachments.js"></script>
  <script src="app.js"></script>
  <script type="module" src="code/panes.js"></script>
```

- [ ] **Step 2: Create `web/chat-attachments.js`**

```javascript
// ── Multimodal chat attachments ─────────────────────────────────────────────
// Plain script (not a module) — defines globals consumed both by app.js and,
// ambiently, by the ES module web/code/ai-panel.js, matching the convention
// those modules already use for api()/escHtml()/resolveOllama().
//
// Uses pdfjsLib (CDN, loaded before this file) and resolveOllama()/escHtml()
// (defined later in app.js, but not called until after DOMContentLoaded/user
// interaction — by then app.js has already run top-to-bottom and defined
// them).

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const ATTACH_MAX_IMAGE_EDGE  = 1280;
const ATTACH_IMAGE_QUALITY   = 0.85;
const ATTACH_MAX_FILE_CHARS  = 12000;
const ATTACH_TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','py','js','ts','jsx','tsx','json','csv','log',
  'yml','yaml','css','html','htm','sh','bash','xml','ini','toml','sql',
]);

function isImageFile(file) {
  return file.type.startsWith('image/');
}
function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// Resize+re-encode an image File/Blob to a bounded JPEG, returned as raw
// base64 (no data: prefix) — what Ollama's per-message `images` array wants.
function resizeImageFile(file, maxEdge = ATTACH_MAX_IMAGE_EDGE, quality = ATTACH_IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxEdge || height > maxEdge) {
        const scale = maxEdge / Math.max(width, height);
        width  = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ mime: 'image/jpeg', base64: dataUrl.split(',')[1], previewUrl: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not decode image: ${file.name}`)); };
    img.src = url;
  });
}

// Read a text-like File as UTF-8, truncating with a trailing marker if it
// exceeds maxChars. Returns null for anything not on the whitelist and not
// decodable as text (binary sniff via a leading-NUL-byte check).
async function extractTextFile(file, maxChars = ATTACH_MAX_FILE_CHARS) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ATTACH_TEXT_EXTENSIONS.has(ext)) {
    const head  = await file.slice(0, 4096).arrayBuffer();
    const bytes = new Uint8Array(head);
    if (bytes.some(b => b === 0)) return null;
  }
  let text;
  try { text = await file.text(); } catch (_) { return null; }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
  return { name: file.name, text };
}

// PDF text extraction via pdf.js.
async function extractPdfFile(file, maxChars = ATTACH_MAX_FILE_CHARS) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages && text.length < maxChars; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
  return { name: file.name, text };
}

// ── Vision capability cache ─────────────────────────────────────────────────
const _visionCapCache = new Map(); // model -> boolean

async function modelSupportsVision(model) {
  if (!model) return false;
  if (_visionCapCache.has(model)) return _visionCapCache.get(model);
  try {
    const res = await fetch(`${await resolveOllama()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return false; // unreachable/unknown model — don't cache, retry next time
    const data = await res.json();
    const supported = Array.isArray(data.capabilities) && data.capabilities.includes('vision');
    _visionCapCache.set(model, supported);
    return supported;
  } catch (_) {
    return false;
  }
}

// ── Staging: the in-progress attachment list for one composer ──────────────
// One instance per composer (Chat, Home, each code-editor chat pane) — never
// shared/global, since multiple chat panes can be open at once (Compare layout).
function createAttachmentStaging(stripEl) {
  let items = []; // { type:'image', name, mime, base64, previewUrl } | { type:'file', name, text }

  function render() {
    stripEl.innerHTML = '';
    stripEl.classList.toggle('hidden', items.length === 0);
    items.forEach((item, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (item.type === 'image') {
        chip.innerHTML = `<img class="attach-chip-thumb" src="${item.previewUrl}" alt="">`;
      } else {
        chip.innerHTML = `<span class="attach-chip-file">\u{1F4C4} ${escHtml(item.name)}</span>`;
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'attach-chip-remove';
      rm.title = 'Remove';
      rm.textContent = '×';
      rm.addEventListener('click', () => { items.splice(idx, 1); render(); });
      chip.appendChild(rm);
      stripEl.appendChild(chip);
    });
  }

  async function addFiles(fileList, { model } = {}) {
    for (const file of Array.from(fileList)) {
      if (isImageFile(file)) {
        if (model && !(await modelSupportsVision(model))) {
          alert(`The selected model doesn't support image input: ${file.name}`);
          continue;
        }
        try {
          const img = await resizeImageFile(file);
          items.push({ type: 'image', name: file.name, ...img });
        } catch (e) {
          alert(e.message);
        }
      } else if (isPdfFile(file)) {
        try {
          items.push({ type: 'file', ...(await extractPdfFile(file)) });
        } catch (e) {
          alert(`Could not read PDF: ${file.name}`);
        }
      } else {
        const extracted = await extractTextFile(file);
        if (extracted) items.push({ type: 'file', ...extracted });
        else alert(`Unsupported file type: ${file.name}`);
      }
    }
    render();
  }

  return {
    addFiles,
    getImages:   () => items.filter(i => i.type === 'image').map(i => i.base64),
    getFileText: () => items.filter(i => i.type === 'file')
      .map(i => `\`\`\`${i.name}\n${i.text}\n\`\`\``).join('\n\n'),
    isEmpty: () => items.length === 0,
    clear:   () => { items = []; render(); },
    getItemsForTransfer: () => items,
    loadTransferred: newItems => { items = newItems; render(); },
  };
}

// Clipboard image paste — shared by all three composers.
function bindPasteImages(el, staging, getModel) {
  el.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      staging.addFiles(files, { model: getModel() });
    }
  });
}

// Full-screen click-to-enlarge for a sent image thumbnail.
function openImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'attach-lightbox-overlay';
  overlay.innerHTML = `<img src="${src}" alt="">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}
```

- [ ] **Step 3: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/chat-attachments.js
```

Expected: no output.

- [ ] **Step 4: Add shared CSS**

Append to `web/style.css`:

```css
/* ── Multimodal attachments (shared: Chat, Home, code editor chat) ──────── */
.attach-staging-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 4px 8px;
}
.attach-staging-strip.hidden { display: none; }
.attach-chip {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.attach-chip-thumb { width: 44px; height: 44px; object-fit: cover; display: block; }
.attach-chip-file  { padding: 6px 10px; font-size: 12px; color: var(--text); white-space: nowrap; }
.attach-chip-remove {
  position: absolute;
  top: 2px; right: 2px;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: none;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.msg-image-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.msg-image-thumb {
  max-width: 160px;
  max-height: 160px;
  border-radius: 8px;
  cursor: zoom-in;
  border: 1px solid var(--border);
  display: block;
}
.attach-lightbox-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  cursor: zoom-out;
}
.attach-lightbox-overlay img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
}
```

- [ ] **Step 5: Commit**

```bash
git add web/chat-attachments.js web/index.html web/style.css
git commit -m "Add shared multimodal attachment module (resize, PDF/text extract, vision-capability cache, staging UI)"
```

---

### Task 3: Chat tab — image/file attach + "Change workfolder"

**Files:**
- Modify: `web/index.html:197-206` (composer markup)
- Modify: `web/app.js` (DOM refs near `web/app.js:84-109`; `addBubble`/`renderChat` at `web/app.js:1340-1372`; `send()` at `web/app.js:1683-1882`)

**Interfaces:**
- Consumes: Task 2's `createAttachmentStaging`, `bindPasteImages`, `modelSupportsVision`, `openImageLightbox`; Task 1's `images` field on persisted/loaded messages; the existing `openFolderPicker` (`web/code/editor.js`, dynamically imported) and `RealFileProvider` (`web/code/providers.js`, dynamically imported) from `docs/superpowers/specs/2026-07-14-change-workspace-folder-design.md`'s already-built feature.
- Produces: `addBubble(role, content, meta, thinking, images)` — 5th param, consumed by nothing outside this task (Home reuses `send()`, which calls this internally).

- [ ] **Step 1: Composer markup — un-placeholder attach-file, relabel attach-folder, add staging strip + hidden input**

`web/index.html`'s composer currently reads (`web/index.html:197-206`):

```html
          <div id="input-area">
            <textarea id="user-input" placeholder="Type a message... (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
            <div id="composer-row">
              <button id="attach-file-btn" class="icon-btn placeholder" title="Attach file — coming soon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <button id="attach-folder-btn" class="icon-btn placeholder" title="Attach folder — coming soon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>
              </button>
              <div id="composer-spacer"></div>
```

Replace with:

```html
          <div id="input-area">
            <div id="attach-staging-strip" class="attach-staging-strip hidden"></div>
            <textarea id="user-input" placeholder="Type a message... (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
            <input type="file" id="attach-file-input" multiple hidden>
            <div id="composer-row">
              <button id="attach-file-btn" class="icon-btn" title="Attach image or file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <button id="attach-folder-btn" class="icon-btn" title="Change workfolder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>
              </button>
              <div id="composer-spacer"></div>
```

- [ ] **Step 2: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
python3 -c "import re; assert '<div id=\"attach-staging-strip\"' in open('web/index.html').read()"
```

Expected: no output (assertion passes).

- [ ] **Step 3: DOM refs + staging instance + wire the two buttons**

`web/app.js`'s DOM refs currently include (`web/app.js:92-94`):

```javascript
const chatWindow   = document.getElementById('chat-window');
const userInput    = document.getElementById('user-input');
const abandonBtn   = document.getElementById('abandon-btn');
```

Replace with:

```javascript
const chatWindow   = document.getElementById('chat-window');
const userInput    = document.getElementById('user-input');
const abandonBtn   = document.getElementById('abandon-btn');
const attachFileBtn        = document.getElementById('attach-file-btn');
const attachFileInput      = document.getElementById('attach-file-input');
const attachStagingStrip   = document.getElementById('attach-staging-strip');
const changeWorkfolderBtn  = document.getElementById('attach-folder-btn');
const chatStaging = createAttachmentStaging(attachStagingStrip);
```

Add near the end of the "Chat — events" block, right after the existing `sidebarToggleBtn.addEventListener(...)` block (`web/app.js:1888-1890`):

```javascript
sidebarToggleBtn.addEventListener('click', () => {
  chatSidebar.classList.toggle('collapsed');
});

attachFileBtn.addEventListener('click', () => attachFileInput.click());
attachFileInput.addEventListener('change', async () => {
  await chatStaging.addFiles(attachFileInput.files, { model: state.model });
  attachFileInput.value = '';
});
bindPasteImages(userInput, chatStaging, () => state.model);

changeWorkfolderBtn.addEventListener('click', async () => {
  const { openFolderPicker } = await import('./code/editor.js');
  const { RealFileProvider } = await import('./code/providers.js');
  let currentRoot = '';
  try { currentRoot = (await api('GET', '/api/code-session'))?.root_path || ''; } catch (_) {}
  await openFolderPicker(new RealFileProvider(), currentRoot, async path => {
    await api('PUT', '/api/code-session', { rootPath: path }); // throws on failure — picker shows it inline
  });
});
```

- [ ] **Step 4: Include staged attachments in `send()`**

`send()` currently builds and stores the outgoing user message like this (`web/app.js:1727-1735,1743`):

```javascript
  apiMessages.push(...thread.messages.filter(m => m.role !== 'system'));
  apiMessages.push({ role: 'user', content: text });

  const userMsgId = uid();
  thread.messages.push({ id: userMsgId, role: 'user', content: text });
  if (!thread.temporary) {
    api('POST', `/api/threads/${thread.id}/messages`, { id: userMsgId, role: 'user', content: text }).catch(() => {});
    if (isFirstMsg) save(); // persist updated thread name
  }

  userInput.value = '';
  userInput.style.height = 'auto';
  isGenerating      = true;
  sendBtn.disabled  = true;
  abandonBtn.hidden = false;

  addBubble('user', text);
```

Replace with:

```javascript
  const stagedImages   = chatStaging.getImages();
  const stagedFileText = chatStaging.getFileText();
  const sendContent    = stagedFileText ? `${text}\n\n${stagedFileText}` : text;

  apiMessages.push(...thread.messages.filter(m => m.role !== 'system'));
  apiMessages.push({ role: 'user', content: sendContent, ...(stagedImages.length ? { images: stagedImages } : {}) });

  const userMsgId = uid();
  thread.messages.push({ id: userMsgId, role: 'user', content: sendContent, images: stagedImages });
  if (!thread.temporary) {
    api('POST', `/api/threads/${thread.id}/messages`, { id: userMsgId, role: 'user', content: sendContent, images: stagedImages }).catch(() => {});
    if (isFirstMsg) save(); // persist updated thread name
  }

  userInput.value = '';
  userInput.style.height = 'auto';
  isGenerating      = true;
  sendBtn.disabled  = true;
  abandonBtn.hidden = false;

  addBubble('user', sendContent, null, null, stagedImages);
  chatStaging.clear();
```

Note: `thread.name` (set a few lines earlier via `isFirstMsg`) still uses the original `text`, not `sendContent` — the thread's display name in the sidebar stays the short human-typed text, not the appended file dump.

- [ ] **Step 5: Render image thumbnails — `addBubble` + `renderChat`**

`addBubble` currently reads (`web/app.js:1349-1372`):

```javascript
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
  if (role === 'assistant') wrap.appendChild(buildBrandMark());
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}
```

Replace with:

```javascript
function addBubble(role, content, meta = null, thinking = null, images = null) {
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

  if (role === 'user' && images && images.length) {
    const imgRow = document.createElement('div');
    imgRow.className = 'msg-image-row';
    images.forEach(b64 => {
      const im = document.createElement('img');
      im.className = 'msg-image-thumb';
      im.src = `data:image/jpeg;base64,${b64}`;
      im.addEventListener('click', () => openImageLightbox(im.src));
      imgRow.appendChild(im);
    });
    bubble.appendChild(imgRow);
  }

  wrap.appendChild(bubble);
  wrap.appendChild(buildMeta(role, content, meta));
  if (role === 'assistant') wrap.appendChild(buildBrandMark());
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}
```

`renderChat` currently reads (`web/app.js:1340-1347`):

```javascript
function renderChat() {
  chatWindow.innerHTML = '';
  const t = activeThread();
  if (!t) return;
  t.messages.filter(m => m.role !== 'system').forEach(m => {
    addBubble(m.role, m.content, m.meta, m.thinking);
  });
}
```

Replace with:

```javascript
function renderChat() {
  chatWindow.innerHTML = '';
  const t = activeThread();
  if (!t) return;
  t.messages.filter(m => m.role !== 'system').forEach(m => {
    addBubble(m.role, m.content, m.meta, m.thinking, m.images);
  });
}
```

- [ ] **Step 6: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/app.js
```

Expected: no output.

- [ ] **Step 7: Manual walkthrough**

```bash
cd /Volumes/library/projects/atlantis_os
python3 launcher.py
```

1. Open **Chat**, pick a non-vision model (e.g. a small text-only model) — confirm attaching an image shows the "doesn't support image input" alert and the image is not staged.
2. Pick a vision-capable model installed locally (e.g. `llava` or `qwen2.5vl` if installed — skip this specific check if none is installed, and note it in the task's completion notes) — confirm the image stages as a thumbnail chip above the input, send, and confirm the thumbnail appears in the sent user bubble and the model's response references the image.
3. Attach a `.txt` or `.py` file — confirm it stages as a chip with a file icon, and after sending, the bubble shows the original text plus the fenced file content appended.
4. Attach a `.pdf` — confirm extracted text appears in the sent message the same way.
5. Copy an image to the clipboard (e.g. a screenshot) and paste into the message textarea — confirm it stages the same as a picked file.
6. Reload the page, reopen the same thread — confirm the previously-sent image still renders as a thumbnail (proves the DB round-trip from Task 1).
7. Click "Change workfolder…" (folder icon) — confirm the existing folder-picker modal opens, pick a folder, confirm no error and that `GET /api/code-session` now reflects the new root (e.g. via the Code section's File Tree pane).

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/app.js
git commit -m "Wire image/file attach and Change workfolder into the Chat tab composer"
```

---

### Task 4: Home page — image/file attach

**Files:**
- Modify: `web/index.html:124-142` (Home composer markup)
- Modify: `web/app.js` (DOM refs near `web/app.js:104-109`; `sendFromHome()` at `web/app.js:760-808`)

**Interfaces:**
- Consumes: Task 2's `createAttachmentStaging`, `bindPasteImages`; Task 3's `chatStaging` (Home transfers its staged items into Chat's staging instance before delegating to `send()`).

- [ ] **Step 1: Home composer markup — add buttons + staging strip**

`web/index.html`'s Home composer currently reads (`web/index.html:124-142`):

```html
          <div>
            <div id="home-compose-card">
              <textarea id="home-input" placeholder="Ask anything, or start a chat… (@brain for a one-off system question)" rows="1"></textarea>
              <div id="home-compose-toolbar">
                <select id="home-agent-select"><option value="">No agent</option></select>
                <select id="home-model-select"></select>
                <div id="home-brain-controls" hidden>
                  <button id="home-clear-btn" title="Clear brain chat history">Clear history</button>
                  <button id="home-auto-btn" title="Auto-accept actions (off)">⚡ Auto</button>
                  <button id="home-abandon-btn" hidden>Abandon</button>
                </div>
                <button id="home-mode-toggle" title="Toggle Brain mode">⚡ Brain</button>
                <div id="home-compose-spacer"></div>
                <button id="home-send-btn" title="Send">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
              </div>
            </div>
          </div>
```

Replace with:

```html
          <div>
            <div id="home-compose-card">
              <div id="home-attach-staging-strip" class="attach-staging-strip hidden"></div>
              <textarea id="home-input" placeholder="Ask anything, or start a chat… (@brain for a one-off system question)" rows="1"></textarea>
              <input type="file" id="home-attach-file-input" multiple hidden>
              <div id="home-compose-toolbar">
                <button id="home-attach-file-btn" class="icon-btn" title="Attach image or file">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                </button>
                <select id="home-agent-select"><option value="">No agent</option></select>
                <select id="home-model-select"></select>
                <div id="home-brain-controls" hidden>
                  <button id="home-clear-btn" title="Clear brain chat history">Clear history</button>
                  <button id="home-auto-btn" title="Auto-accept actions (off)">⚡ Auto</button>
                  <button id="home-abandon-btn" hidden>Abandon</button>
                </div>
                <button id="home-mode-toggle" title="Toggle Brain mode">⚡ Brain</button>
                <div id="home-compose-spacer"></div>
                <button id="home-send-btn" title="Send">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
              </div>
            </div>
          </div>
```

- [ ] **Step 2: DOM refs + staging instance**

`web/app.js`'s Home DOM refs currently read (`web/app.js:104-109`):

```javascript
const homeGreeting     = document.getElementById('home-greeting');
const homeInput        = document.getElementById('home-input');
const homeAgentSelect  = document.getElementById('home-agent-select');
const homeModelSelect  = document.getElementById('home-model-select');
const homeSendBtn      = document.getElementById('home-send-btn');
const homeRecent       = document.getElementById('home-recent');
```

Replace with:

```javascript
const homeGreeting     = document.getElementById('home-greeting');
const homeInput        = document.getElementById('home-input');
const homeAgentSelect  = document.getElementById('home-agent-select');
const homeModelSelect  = document.getElementById('home-model-select');
const homeSendBtn      = document.getElementById('home-send-btn');
const homeRecent       = document.getElementById('home-recent');
const homeAttachFileBtn      = document.getElementById('home-attach-file-btn');
const homeAttachFileInput    = document.getElementById('home-attach-file-input');
const homeAttachStagingStrip = document.getElementById('home-attach-staging-strip');
const homeStaging = createAttachmentStaging(homeAttachStagingStrip);
```

- [ ] **Step 3: Wire the button/paste, and transfer staged items into Chat before delegating**

`sendFromHome()`'s normal (non-pipe, non-brain) path currently reads (`web/app.js:792-808`):

```javascript
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
```

Replace with:

```javascript
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
  if (!homeStaging.isEmpty()) {
    chatStaging.loadTransferred(homeStaging.getItemsForTransfer());
    homeStaging.clear();
  }
  send();

  homeInput.value = '';
  homeInput.style.height = 'auto';
}
```

Add the button/paste wiring right after the existing Home input listeners (`web/app.js:836-839`, immediately before `document.getElementById('home-mode-toggle')...`):

```javascript
homeInput.addEventListener('input', () => {
  homeInput.style.height = 'auto';
  homeInput.style.height = Math.min(homeInput.scrollHeight, 160) + 'px';
});

homeAttachFileBtn.addEventListener('click', () => homeAttachFileInput.click());
homeAttachFileInput.addEventListener('change', async () => {
  await homeStaging.addFiles(homeAttachFileInput.files, { model: homeModelSelect.value });
  homeAttachFileInput.value = '';
});
bindPasteImages(homeInput, homeStaging, () => homeModelSelect.value);

document.getElementById('home-mode-toggle').addEventListener('click', toggleHomeMode);
```

Note: attachments staged on Home while in `@brain`/`@pipe` mode are intentionally not sent — those two modes use their own send paths (`sendHomeBrainMessage()`, `launchAdHocPipeline()`), which this task does not touch, matching the design spec's scope. The staged chips simply remain visible until the user switches back to a normal send or manually clears them by removing each chip.

- [ ] **Step 4: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --check web/app.js
python3 -c "assert '<div id=\"home-attach-staging-strip\"' in open('web/index.html').read()"
```

Expected: no output from either command.

- [ ] **Step 5: Manual walkthrough**

```bash
cd /Volumes/library/projects/atlantis_os
python3 launcher.py
```

1. On **Home**, with a vision-capable model selected in the model dropdown, attach an image via the new button — confirm it stages as a thumbnail chip above the input.
2. Send — confirm it navigates to **Chat**, creates a new thread, and the sent bubble shows the image thumbnail (proves the Home→Chat staging transfer works).
3. Attach a text file on Home, send, confirm the fenced file content appears in the resulting Chat message.
4. Paste a clipboard image into the Home textarea — confirm it stages the same as picking a file.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/app.js
git commit -m "Wire image/file attach into the Home composer, transferring staged items into Chat on send"
```

---

### Task 5: Code editor chat pane — image/file attach

**Files:**
- Modify: `web/code/ai-panel.js` (`createChatPane` template at `web/code/ai-panel.js:118-142`; `appendBubble` at `web/code/ai-panel.js:239-259`; `sendMessage` at `web/code/ai-panel.js:327-347`)

**Interfaces:**
- Consumes: Task 2's `createAttachmentStaging`, `bindPasteImages`, `openImageLightbox` (all ambient globals — `ai-panel.js` is an ES module but, per the existing convention in this file, references `api`/`escHtml`/`resolveOllama`/`marked`/`Prism` etc. as globals without importing them).

- [ ] **Step 1: Template — add attach button, hidden input, staging strip**

`createChatPane`'s template currently reads (`web/code/ai-panel.js:118-134`):

```javascript
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
```

Replace with:

```javascript
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
    <div class="attach-staging-strip hidden"></div>
    <div class="code-chat-bar">
      <button class="code-attach-btn icon-btn" title="Attach image or file">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <input type="file" class="code-attach-input" multiple hidden>
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
  const attachBtn   = bodyEl.querySelector('.code-attach-btn');
  const attachInput = bodyEl.querySelector('.code-attach-input');
  const attachStrip = bodyEl.querySelector('.attach-staging-strip');
  const attachStaging = createAttachmentStaging(attachStrip);

  function currentModelForAttach() {
    const agent = agentSelect.value ? agentsList.find(a => a.id === agentSelect.value) : null;
    return agent?.model || modelSelect.value;
  }
  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', async () => {
    await attachStaging.addFiles(attachInput.files, { model: currentModelForAttach() });
    attachInput.value = '';
  });
  bindPasteImages(input, attachStaging, currentModelForAttach);
```

- [ ] **Step 2: Render image thumbnails in `appendBubble`**

`appendBubble` currently reads (`web/code/ai-panel.js:239-259`):

```javascript
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
```

Replace with:

```javascript
  function appendBubble(role, content, images = null) {
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
    if (role === 'user' && images && images.length) {
      const imgRow = document.createElement('div');
      imgRow.className = 'msg-image-row';
      images.forEach(b64 => {
        const im = document.createElement('img');
        im.className = 'msg-image-thumb';
        im.src = `data:image/jpeg;base64,${b64}`;
        im.addEventListener('click', () => openImageLightbox(im.src));
        imgRow.appendChild(im);
      });
      bubble.appendChild(imgRow);
    }
    wrap.appendChild(bubble);
    wrap.appendChild(buildMeta(role, content, null));
    if (role === 'assistant') wrap.appendChild(buildBrandMark());
    chatWindow.appendChild(wrap);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    if (role === 'assistant') bubble.querySelectorAll('pre code').forEach(b => Prism.highlightElement(b));
    return bubble;
  }
```

- [ ] **Step 3: Include staged attachments in `sendMessage`**

`sendMessage` currently starts (`web/code/ai-panel.js:327-339`):

```javascript
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
```

Replace with:

```javascript
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

    const stagedImages   = attachStaging.getImages();
    const stagedFileText = attachStaging.getFileText();
    const sendContent    = stagedFileText ? `${text}\n\n${stagedFileText}` : text;
    attachStaging.clear();

    appendBubble('user', sendContent, stagedImages);
    history.push({ role: 'user', content: sendContent, ...(stagedImages.length ? { images: stagedImages } : {}) });
```

- [ ] **Step 4: Verify syntax**

```bash
cd /Volumes/library/projects/atlantis_os
node --input-type=module --check < web/code/ai-panel.js
```

Expected: no output.

- [ ] **Step 5: Manual walkthrough**

```bash
cd /Volumes/library/projects/atlantis_os
python3 launcher.py
```

1. Open **Code**, add/focus a Chat pane, pick a vision-capable model — attach an image, confirm it stages, send, confirm the thumbnail renders in the sent bubble.
2. Attach a text/code file, confirm the fenced content appears in the message and the model can act on it.
3. If the "Compare" layout (multiple chat panes) is available, confirm each pane's staged attachments are independent — staging in one pane doesn't affect another.

- [ ] **Step 6: Commit**

```bash
git add web/code/ai-panel.js
git commit -m "Wire image/file attach into the code editor's chat pane"
```

---

### Task 6: Full regression pass + documentation

**Files:**
- Modify: `system_design.md` (Chat/Home/Code sections, DB schema section)

**Interfaces:** none — documentation and end-to-end verification only.

- [ ] **Step 1: Document the change**

In `system_design.md`, note in the Chat/Home/Code editor section entries that all three composers now support image attach (gated per-model on Ollama vision capability via `/api/show`) and generic text/PDF file attach (inserted as fenced context, any model), via clipboard paste or the attach button. In the DB schema section, add `messages.images` (`TEXT`, JSON array of base64 strings) to the `messages` table description.

- [ ] **Step 2: Full regression pass**

Run `python3 launcher.py` and walk through, in order:

1. Existing chat flows still work with no attachments (text-only messages, tool calls, agent selection) on all three surfaces — confirms nothing in `send()`/`sendMessage()`/`_post_messages` regressed for the plain-text path.
2. Repeat the multimodal walkthroughs from Tasks 3, 4, and 5 in one pass.
3. Attach an oversized image (e.g. a multi-megapixel photo) — confirm it still stages/sends without hanging (proves the client-side downscale keeps the payload bounded).
4. Attach an unsupported binary file (e.g. a `.zip`) — confirm the inline "Unsupported file type" alert fires and nothing stages.
5. Switch models mid-compose from a vision model to a non-vision one with an image already staged, then send — confirm the existing staged image still sends (capability gating only blocks new attach attempts, doesn't retroactively unstage) and observe how the non-vision model errors surface (should be a normal chat error bubble, not a crash).
6. Restart the server, reopen a thread with a previously-sent image — confirm it still renders (DB round-trip survives a restart, not just the current session).

Fix anything that regressed; if no fixes were needed, skip the commit below.

- [ ] **Step 3: Commit**

```bash
git add system_design.md
git commit -m "Document multimodal chat input in system_design.md"
```
