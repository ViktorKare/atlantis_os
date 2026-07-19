// Deterministic lazy-edit merge — MIRROR of agent/edit_merge.py; any change there must
// be made here too, thresholds and refusal behavior must stay identical.
// See docs/superpowers/specs/2026-07-19-lazy-edit-merge-design.md.

const SIM_THRESHOLD = 0.85;
const AMBIGUITY_MARGIN = 0.05;

const COMMENT_START_RE = /^\s*(\/\/|#|--|;|\*|\/\*|<!--)/;

function isMarker(line) {
  const t = line.trim();
  if (t === '...' || t === '…') return true;
  return COMMENT_START_RE.test(line) && (t.includes('...') || t.includes('…'));
}

export function parseLazyEdit(editText) {
  const chunks = [];
  let cur = [];
  for (const line of editText.split('\n')) {
    if (isMarker(line)) {
      if (cur.length) { chunks.push(cur); cur = []; }
    } else cur.push(line);
  }
  if (cur.length) chunks.push(cur);
  const out = [];
  for (const c of chunks) {
    while (c.length && !c[0].trim()) c.shift();
    while (c.length && !c[c.length - 1].trim()) c.pop();
    if (c.length) out.push(c);
  }
  return out;
}

function norm(s) {
  return s.trim().replace(/\s+/g, ' ');
}

function lcsLen(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (const ch of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) {
      cur.push(ch === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]));
    }
    prev = cur;
  }
  return prev[b.length];
}

function sim(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const la = a.length, lb = b.length;
  if ((2.0 * Math.min(la, lb)) / (la + lb) < SIM_THRESHOLD) return 0.0; // LCS can't reach threshold
  return (2.0 * lcsLen(a, b)) / (la + lb);
}

// Best position for an anchor line in fileNorm[lo:hi]. `window` is 1-2 normalized chunk
// lines; forward windows anchor window[0] at the returned index (extending down-file),
// backward windows anchor window[window.length-1] (extending up-file).
// Returns an index, null (not found), or the string 'ambiguous'.
function findAnchor(fileNorm, window, lo, hi, backward = false) {
  const anchor = backward ? window[window.length - 1] : window[0];
  let bestIdx = null, secondIdx = null, best = -1.0, second = -1.0;
  for (let i = lo; i < hi; i++) {
    if (sim(fileNorm[i], anchor) < SIM_THRESHOLD) continue;
    let total = 0;
    for (let k = 0; k < window.length; k++) {
      const j = backward ? i - (window.length - 1 - k) : i + k;
      total += (j >= 0 && j < fileNorm.length) ? sim(fileNorm[j], window[k]) : 0.0;
    }
    const score = total / window.length;
    if (score > best) {
      second = best; secondIdx = bestIdx;
      best = score; bestIdx = i;
    } else if (score > second) {
      second = score; secondIdx = i;
    }
  }
  if (bestIdx === null) return null;
  if (secondIdx !== null && second >= best - AMBIGUITY_MARGIN) return 'ambiguous';
  return bestIdx;
}

export function mergeLazyEdit(fileText, editText) {
  const chunks = parseLazyEdit(editText);
  if (!chunks.length) {
    return { error: 'edit is empty or contains only "..." markers — write the new content of the region you are changing' };
  }
  if (!fileText.trim()) {
    return { content: chunks.map(c => c.join('\n')).join('\n') };
  }

  const fileLines = fileText.split('\n');
  const fileNorm = fileLines.map(norm);
  let lastReal = fileLines.length - 1;
  while (lastReal > 0 && !fileNorm[lastReal]) lastReal--;

  const out = [];
  let search = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const wFirst = chunk.slice(0, 2).map(norm);
    const wLast = chunk.slice(-2).map(norm);
    let fIdx = findAnchor(fileNorm, wFirst, search, fileLines.length);
    if (fIdx === 'ambiguous') {
      return { refusal: `anchor line matches multiple places in the file: "${chunk[0].trim()}" — include more surrounding unchanged lines to disambiguate` };
    }
    let lIdx;

    if (chunk.length === 1) {
      if (fIdx === null) {
        return { refusal: `anchor line not found in file: "${chunk[0].trim()}" — start and end your edit with 1-3 unchanged lines copied from the file` };
      }
      lIdx = fIdx;
    } else if (fIdx === null) {
      // Boundary exception: prepend — the chunk's LAST line anchors the file's first line.
      lIdx = findAnchor(fileNorm, wLast, search, fileLines.length, true);
      if (lIdx === 'ambiguous') {
        return { refusal: `anchor line matches multiple places in the file: "${chunk[chunk.length - 1].trim()}" — include more surrounding unchanged lines to disambiguate` };
      }
      if (ci === 0 && lIdx === 0) {
        fIdx = 0;
      } else {
        return { refusal: `opening anchor line not found in file: "${chunk[0].trim()}" — start the edited region with 1-3 unchanged lines copied from the file` };
      }
    } else {
      lIdx = findAnchor(fileNorm, wLast, fIdx + 1, fileLines.length, true);
      if (lIdx === 'ambiguous') {
        return { refusal: `anchor line matches multiple places in the file: "${chunk[chunk.length - 1].trim()}" — include more surrounding unchanged lines to disambiguate` };
      }
      if (lIdx === null) {
        // Boundary exception: append — the chunk's FIRST line anchors the file's last line.
        if (ci === chunks.length - 1 && fIdx >= lastReal) {
          lIdx = fIdx;
        } else {
          return { refusal: `closing anchor line not found in file: "${chunk[chunk.length - 1].trim()}" — end the edited region with 1-3 unchanged lines copied from the file` };
        }
      }
    }

    out.push(...fileLines.slice(search, fIdx));
    out.push(...chunk);
    search = lIdx + 1;
  }
  out.push(...fileLines.slice(search));
  return { content: out.join('\n') };
}

// ── Apply-model output guards (also used for propose_rewrite) ───────────────

// Catches the classic "lazy full rewrite" failure: a placeholder referring back to
// content the output isn't actually including. Moved here from ai-panel.js.
export const LAZY_PLACEHOLDER_RE = /(rest of (the )?(file|content|code|document)|remains?\s+(the\s+same|unchanged|below|above)|existing code (goes|stays|remains)|unchanged\s+(above|below)|content\s+(goes|will go|continues)\s+here|\.\.\.\s*(existing|rest|unchanged)|\[unchanged\])/i;

export function suspiciousRewrite(oldContent, newContent) {
  if (LAZY_PLACEHOLDER_RE.test(newContent)) {
    return 'This looks like it contains a placeholder comment (e.g. "the rest of the content remains below") instead of the actual content. propose_rewrite replaces the ENTIRE file verbatim — there is no way to reference "the rest" of the old content, whatever is not literally included WILL be deleted. Use propose_edit for a small targeted change instead, or resubmit propose_rewrite with the complete file content (unchanged parts included in full).';
  }
  if (oldContent && oldContent.length > 200 && newContent.length < oldContent.length * 0.4) {
    return `New content (${newContent.length} chars) is much shorter than the file's current content (${oldContent.length} chars) — this looks like accidental truncation rather than an intentional rewrite. If a large deletion is really intended, resubmit with confirm_large_deletion:true. Otherwise use propose_edit for just the part that's changing, or include the full original content here.`;
  }
  return null;
}

export function stripFence(text) {
  const t = text.trim();
  if (t.startsWith('```') && t.endsWith('```')) {
    const firstNl = t.indexOf('\n');
    if (firstNl !== -1) return t.slice(firstNl + 1, -3).replace(/\n$/, '');
  }
  return text;
}

export function applyOutputProblem(oldContent, newContent) {
  if (!newContent.trim()) return 'empty output';
  if (LAZY_PLACEHOLDER_RE.test(newContent)) return 'output contains an elision placeholder instead of real content';
  if (oldContent && oldContent.length > 200 && newContent.length < oldContent.length * 0.4) return 'output is much shorter than the file (likely truncated)';
  return null;
}
