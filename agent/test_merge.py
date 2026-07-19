#!/usr/bin/env python3
"""Standalone regression tests for edit_merge.py — run: python3 agent/test_merge.py
No framework (repo has no test runner); prints one line per case, exits non-zero on failure."""
import sys
from edit_merge import merge_lazy_edit, parse_lazy_edit, MergeError, MergeRefusal

FILE = """def greet(name):
    print(f"hello {name}")
    return name

def add(a, b):
    return a + b

def main():
    greet("world")
    print(add(1, 2))
"""

CASES = []
def case(name, fn):
    CASES.append((name, fn))

# ── parse_lazy_edit ──────────────────────────────────────────────────────────
def t_parse_markers():
    chunks = parse_lazy_edit("line1\n// ... existing code ...\nline2\n# ...\nline3")
    assert chunks == [["line1"], ["line2"], ["line3"]], chunks
case("parse: comment markers split chunks", t_parse_markers)

def t_parse_bare_dots():
    chunks = parse_lazy_edit("a\n...\nb\n…\nc")
    assert chunks == [["a"], ["b"], ["c"]], chunks
case("parse: bare ... and … are markers", t_parse_bare_dots)

def t_parse_spread_not_marker():
    chunks = parse_lazy_edit("const x = {\n  ...rest,\n}")
    assert chunks == [["const x = {", "  ...rest,", "}"]], chunks
case("parse: JS spread ...rest is NOT a marker", t_parse_spread_not_marker)

def t_parse_html_marker():
    chunks = parse_lazy_edit("<div>\n<!-- ... unchanged ... -->\n</div>")
    assert chunks == [["<div>"], ["</div>"]], chunks
case("parse: HTML comment marker", t_parse_html_marker)

def t_parse_blank_edges_stripped():
    chunks = parse_lazy_edit("\n\nline1\n\n...\n\nline2\n\n")
    assert chunks == [["line1"], ["line2"]], chunks
case("parse: blank edges stripped per chunk", t_parse_blank_edges_stripped)

# ── merge: happy paths ───────────────────────────────────────────────────────
def t_exact_replace():
    edit = 'def add(a, b):\n    return a + b + 0  # noop\n\ndef main():'
    out = merge_lazy_edit(FILE, edit)
    assert 'return a + b + 0  # noop' in out and 'def greet' in out and 'def main' in out, out
    assert '\n    return a + b\n' not in out, out
case("merge: exact anchors replace interior", t_exact_replace)

def t_tail_rewrite_without_anchor_refused():
    # Closing line rewritten beyond similarity threshold AND no closing anchor:
    # spec says refuse (single-anchor, non-boundary) rather than guess the span.
    try:
        merge_lazy_edit(FILE, 'def add(a, b):\n    return math.fsum([a, b, 0])  # noop')
    except MergeRefusal:
        return
    raise AssertionError('expected MergeRefusal')
case("refusal: rewritten tail with no closing anchor", t_tail_rewrite_without_anchor_refused)

def t_ws_drift():
    edit = 'def add(a,  b):\n        return a * b'  # anchor line has ws drift; body changed
    out = merge_lazy_edit(FILE, edit)
    assert 'return a * b' in out and 'return a + b' not in out, out
case("merge: whitespace-drifted anchor still matches", t_ws_drift)

def t_typo_anchor():
    edit = 'def ad(a, b):\n    return a - b'  # small typo in anchor (similarity rung)
    out = merge_lazy_edit(FILE, edit)
    assert 'return a - b' in out, out
case("merge: near-match anchor (typo) via similarity", t_typo_anchor)

def t_two_chunks():
    edit = ('def greet(name):\n    print(f"hi {name}")\n    return name\n'
            '// ... existing code ...\n'
            'def main():\n    greet("moon")\n    print(add(1, 2))')
    out = merge_lazy_edit(FILE, edit)
    assert 'hi {name}' in out and 'greet("moon")' in out and 'return a + b' in out, out
case("merge: two chunks in one edit", t_two_chunks)

def t_insertion():
    edit = '    return name\n\ndef sub(a, b):\n    return a - b\n\ndef add(a, b):'
    out = merge_lazy_edit(FILE, edit)
    assert 'def sub' in out and 'def add' in out and 'def greet' in out, out
case("merge: pure insertion between adjacent anchors", t_insertion)

def t_append():
    edit = '    print(add(1, 2))\n\nif __name__ == "__main__":\n    main()'
    out = merge_lazy_edit(FILE, edit)
    assert out.rstrip().endswith('main()') and '__main__' in out, out
case("merge: append at end of file (boundary exception)", t_append)

def t_prepend():
    edit = 'import sys\n\ndef greet(name):'
    out = merge_lazy_edit(FILE, edit)
    assert out.startswith('import sys'), out
    assert out.count('def greet') == 1, out
case("merge: prepend at start of file (boundary exception)", t_prepend)

def t_empty_file():
    out = merge_lazy_edit('', 'hello\nworld')
    assert out == 'hello\nworld', repr(out)
case("merge: empty file gets edit content verbatim", t_empty_file)

# ── merge: refusals & errors ─────────────────────────────────────────────────
def t_not_found():
    try:
        merge_lazy_edit(FILE, 'def nothing_like_this_exists():\n    pass\n    also_not_here()')
    except MergeRefusal:
        return
    raise AssertionError('expected MergeRefusal')
case("refusal: anchors not found", t_not_found)

def t_ambiguous():
    f = 'a\nx = 1\nb\na\nx = 2\nb\n'
    try:
        merge_lazy_edit(f, 'a\nx = 9\nb')
    except MergeRefusal:
        return
    raise AssertionError('expected MergeRefusal (ambiguous)')
case("refusal: duplicate anchor context is ambiguous", t_ambiguous)

def t_marker_only():
    try:
        merge_lazy_edit(FILE, '// ... existing code ...\n...')
    except MergeError:
        return
    raise AssertionError('expected MergeError')
case("error: marker-only edit", t_marker_only)

def t_empty_edit():
    try:
        merge_lazy_edit(FILE, '   \n  ')
    except MergeError:
        return
    raise AssertionError('expected MergeError')
case("error: blank edit", t_empty_edit)

def main():
    failed = 0
    for name, fn in CASES:
        try:
            fn()
            print(f'  ok    {name}')
        except Exception as e:
            failed += 1
            print(f'  FAIL  {name}: {e}')
    print(f'{len(CASES) - failed}/{len(CASES)} passed')
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
