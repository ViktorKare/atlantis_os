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

// Renders a row of click-to-enlarge thumbnails for a sent message's base64
// images and appends it to `bubbleEl`. Shared by web/app.js's addBubble and
// web/code/ai-panel.js's appendBubble — no-ops if `images` is empty/null.
function renderImageThumbnails(bubbleEl, images) {
  if (!images || !images.length) return;
  const imgRow = document.createElement('div');
  imgRow.className = 'msg-image-row';
  images.forEach(b64 => {
    const im = document.createElement('img');
    im.className = 'msg-image-thumb';
    im.src = `data:image/jpeg;base64,${b64}`;
    im.addEventListener('click', () => openImageLightbox(im.src));
    imgRow.appendChild(im);
  });
  bubbleEl.appendChild(imgRow);
}
