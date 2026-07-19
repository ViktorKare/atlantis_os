"""Deterministic lazy-edit merge: applies a model-written 'new version of the changed
region' (with '... existing code ...' elision markers) onto a file by fuzzy-anchoring
each literal chunk's first/last lines. MIRRORED by web/code/edit-merge.js — any change
here must be made there too; thresholds and refusal behavior must stay identical.
See docs/superpowers/specs/2026-07-19-lazy-edit-merge-design.md."""
import re

SIM_THRESHOLD = 0.85
AMBIGUITY_MARGIN = 0.05

class MergeError(ValueError):
    """Malformed edit (empty / markers only) — report straight back to the model."""

class MergeRefusal(ValueError):
    """Couldn't locate the edited region confidently — caller may try the apply model."""

_COMMENT_START_RE = re.compile(r'^\s*(//|#|--|;|\*|/\*|<!--)')

def _is_marker(line):
    t = line.strip()
    if t in ('...', '…'):
        return True
    return bool(_COMMENT_START_RE.match(line)) and ('...' in t or '…' in t)

def parse_lazy_edit(edit_text):
    """Split the edit into literal chunks (lists of lines) separated by elision
    markers; blank lines at each chunk's edges are stripped (they're usually
    formatting around the marker, and anchor lines must be non-blank)."""
    chunks, cur = [], []
    for line in edit_text.split('\n'):
        if _is_marker(line):
            if cur:
                chunks.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        chunks.append(cur)
    out = []
    for c in chunks:
        while c and not c[0].strip():
            c.pop(0)
        while c and not c[-1].strip():
            c.pop()
        if c:
            out.append(c)
    return out

_WS_RUN_RE = re.compile(r'\s+')

def _norm(s):
    return _WS_RUN_RE.sub(' ', s.strip())

def _lcs_len(a, b):
    prev = [0] * (len(b) + 1)
    for ch in a:
        cur = [0]
        for j in range(len(b)):
            cur.append(prev[j] + 1 if ch == b[j] else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]

def _sim(a, b):
    """Char-level LCS ratio on already-normalized strings (exact and
    whitespace-agnostic rungs collapse into `== 1.0` here since both sides are
    normalized). Same formula as the JS mirror — do NOT swap in difflib."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    la, lb = len(a), len(b)
    if 2.0 * min(la, lb) / (la + lb) < SIM_THRESHOLD:  # LCS can't reach threshold
        return 0.0
    return 2.0 * _lcs_len(a, b) / (la + lb)

def _find_anchor(file_norm, window, lo, hi, backward=False):
    """Best position for an anchor line in file_norm[lo:hi]. `window` is 1-2
    normalized chunk lines; forward windows anchor window[0] at the returned
    index (extending down-file), backward windows anchor window[-1] (extending
    up-file). Returns index or None; raises MergeRefusal on ambiguity."""
    anchor = window[-1] if backward else window[0]
    best_idx = second_idx = None
    best = second = -1.0
    for i in range(lo, hi):
        if _sim(file_norm[i], anchor) < SIM_THRESHOLD:
            continue
        total = 0.0
        for k, wl in enumerate(window):
            j = i - (len(window) - 1 - k) if backward else i + k
            total += _sim(file_norm[j], wl) if 0 <= j < len(file_norm) else 0.0
        score = total / len(window)
        if score > best:
            second, second_idx = best, best_idx
            best, best_idx = score, i
        elif score > second:
            second, second_idx = score, i
    if best_idx is None:
        return None
    if second_idx is not None and second >= best - AMBIGUITY_MARGIN:
        raise MergeRefusal(f'anchor line matches multiple places in the file: "{anchor}" '
                           '— include more surrounding unchanged lines to disambiguate')
    return best_idx

def merge_lazy_edit(file_text, edit_text):
    chunks = parse_lazy_edit(edit_text)
    if not chunks:
        raise MergeError('edit is empty or contains only "..." markers — write the new '
                         'content of the region you are changing')
    if not file_text.strip():
        return '\n'.join('\n'.join(c) for c in chunks)

    file_lines = file_text.split('\n')
    file_norm = [_norm(l) for l in file_lines]
    last_real = len(file_lines) - 1
    while last_real > 0 and not file_norm[last_real]:
        last_real -= 1

    out = []
    search = 0
    for ci, chunk in enumerate(chunks):
        wfirst = [_norm(l) for l in chunk[:2]]
        wlast = [_norm(l) for l in chunk[-2:]]
        f_idx = _find_anchor(file_norm, wfirst, search, len(file_lines))

        if len(chunk) == 1:
            if f_idx is None:
                raise MergeRefusal(f'anchor line not found in file: "{chunk[0].strip()}" — start '
                                   'and end your edit with 1-3 unchanged lines copied from the file')
            l_idx = f_idx
        elif f_idx is None:
            # Boundary exception: prepend — the chunk's LAST line anchors the file's first line.
            l_idx = _find_anchor(file_norm, wlast, search, len(file_lines), backward=True)
            if ci == 0 and l_idx == 0:
                f_idx = 0
            else:
                raise MergeRefusal(f'opening anchor line not found in file: "{chunk[0].strip()}" — '
                                   'start the edited region with 1-3 unchanged lines copied from the file')
        else:
            l_idx = _find_anchor(file_norm, wlast, f_idx + 1, len(file_lines), backward=True)
            if l_idx is None:
                # Boundary exception: append — the chunk's FIRST line anchors the file's last line.
                if ci == len(chunks) - 1 and f_idx >= last_real:
                    l_idx = f_idx
                else:
                    raise MergeRefusal(f'closing anchor line not found in file: "{chunk[-1].strip()}" — '
                                       'end the edited region with 1-3 unchanged lines copied from the file')

        out.extend(file_lines[search:f_idx])
        out.extend(chunk)
        search = l_idx + 1
    out.extend(file_lines[search:])
    return '\n'.join(out)
