#!/usr/bin/env python3
"""
Atlantis OS — Job Worker Daemon
Run alongside server.py: python3 worker.py
Polls the jobs table and executes pipeline runs in the background.
"""
import json, os, re, sqlite3, time, datetime, difflib, hashlib, urllib.request, urllib.parse, urllib.error, signal, subprocess, sys, contextlib
from pathlib import Path

BASE_DIR = Path(__file__).parent          # agent/
DB_FILE  = BASE_DIR.parent / 'data' / 'data.db'
RUNNING  = True

# ── DB ────────────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(str(DB_FILE), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn

@contextlib.contextmanager
def db_session():
    # sqlite3.Connection as a context manager only manages the transaction,
    # not the connection lifetime — close explicitly to avoid leaking fds.
    conn = get_db()
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def rows_to_list(rows):
    return [dict(r) for r in rows]

# ── Job log ───────────────────────────────────────────────────────────────────

def log_event(job_id, event):
    line = json.dumps(event) + '\n'
    with db_session() as db:
        db.execute(
            "UPDATE jobs SET output_log = output_log || ? WHERE id = ?",
            (line, job_id)
        )

def claim_job():
    """Atomically claim one queued job. Returns dict or None."""
    db = get_db()
    try:
        db.execute('BEGIN EXCLUSIVE')
        row = db.execute(
            "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if not row:
            db.execute('ROLLBACK')
            db.close()
            return None
        job_id = row['id']
        ts = datetime.datetime.now().isoformat()
        db.execute(
            "UPDATE jobs SET status='running', started_at=? WHERE id=?",
            (ts, job_id)
        )
        db.execute('COMMIT')
        result = dict(row)
        db.close()
        return result
    except Exception:
        try: db.execute('ROLLBACK')
        except Exception: pass
        db.close()
        return None

def finish_job(job_id, status, error=None):
    ts = datetime.datetime.now().isoformat()
    with db_session() as db:
        db.execute(
            "UPDATE jobs SET status=?, finished_at=?, error=? WHERE id=?",
            (status, ts, error, job_id)
        )

# ── Web / filesystem utils ────────────────────────────────────────────────────

_PRIVATE_PREFIXES = (
    'localhost', '127.', '0.0.0.0', '::1',
    '10.', '192.168.',
    '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
)

def safe_url(url):
    try:
        p = urllib.parse.urlparse(url)
    except Exception:
        return 'Invalid URL'
    if p.scheme not in ('http', 'https'):
        return 'Only http/https URLs are allowed'
    host = (p.hostname or '').lower()
    if any(host == pfx.rstrip('.') or host.startswith(pfx) for pfx in _PRIVATE_PREFIXES):
        return 'Private/internal URLs are blocked'
    return None

def strip_html(html):
    html = re.sub(r'<(script|style|nav|footer|header|aside)[^>]*>.*?</\1>',
                  '', html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', html)
    text = (text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                .replace('&nbsp;', ' ').replace('&#39;', "'").replace('&quot;', '"'))
    return re.sub(r'[ \t]+', ' ', re.sub(r'\n\s*\n+', '\n\n', text)).strip()

def web_search_core(query):
    url = 'http://127.0.0.1:5002/search?' + urllib.parse.urlencode({'q': query, 'format': 'json'})
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    return [
        {'title': r.get('title', ''), 'url': r.get('url', ''), 'snippet': r.get('content', '')}
        for r in data.get('results', [])[:8]
        if r.get('url') and r.get('title')
    ]

def web_fetch_core(url):
    err = safe_url(url)
    if err:
        return None, err
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read(131072)
        ct  = resp.headers.get('Content-Type', '')
    text = strip_html(raw.decode('utf-8', errors='replace')) \
           if 'html' in ct else raw.decode('utf-8', errors='replace')
    return text[:50000], None

def get_fs_root():
    with db_session() as db:
        row = db.execute('SELECT root_path FROM code_sessions WHERE id=?', ('default',)).fetchone()
    return Path(row['root_path']) if row and row['root_path'] else Path.home()

# ── Workspace versioning ──────────────────────────────────────────────────────
# The workspace is a git repo so revision runs edit real files against real
# history: one commit per file-writing step, reviewable diffs for the PM, and
# `git revert` instead of prompting a regression away.

def git_run(work_root, *args, timeout=60):
    """Run git in the workspace. Returns stdout on exit 0, else None."""
    try:
        r = subprocess.run(['git', '-C', str(work_root), *args],
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None

def git_workspace_ready(work_root):
    """True when the workspace is safe to snapshot: it is its own repo root.
    Inits a fresh repo when there is none; refuses a repo whose toplevel is a
    parent of the workspace (snapshots would land in that outer repo)."""
    top = git_run(work_root, 'rev-parse', '--show-toplevel')
    if top is None:
        return git_run(work_root, 'init') is not None
    try:
        return Path(top.strip()).resolve() == Path(work_root).resolve()
    except Exception:
        return False

def git_snapshot(work_root, message):
    """Commit everything in the workspace. Returns True when a commit was made."""
    if git_run(work_root, 'add', '-A') is None:
        return False
    # `diff --cached --quiet` exits 0 (→ '' here) only when nothing is staged
    if git_run(work_root, 'diff', '--cached', '--quiet') is not None:
        return False
    return git_run(work_root, '-c', 'user.name=Atlantis Worker',
                   '-c', 'user.email=worker@atlantis.local',
                   'commit', '--no-verify', '-m', message) is not None

def git_churn_stat(work_root, cap=2000):
    """diff --stat of workspace changes since the last snapshot ('' when clean)."""
    git_run(work_root, 'add', '-A')
    stat = git_run(work_root, 'diff', '--cached', '--stat')
    return (stat or '').strip()[:cap]

def _under_workspace(candidate, work_root):
    """True when candidate is work_root itself or a descendant of it. Containment is
    checked on the lexical (un-resolved) path — only collapsing '..' components, not
    following symlinks — so a symlink anywhere inside the workspace (including the
    workspace root itself, e.g. mounted-drive workspaces) can point outside it without
    being rejected, while '..'-based escapes are still blocked."""
    try:
        Path(os.path.normpath(str(candidate))).relative_to(os.path.normpath(str(work_root)))
        return True
    except ValueError:
        return False

def pipe_path_safe(raw, work_root=None):
    if work_root is None:
        work_root = str(get_fs_root())
    raw = str(raw).strip()
    p = Path(raw)
    candidate = p if p.is_absolute() else (Path(work_root) / raw)
    if not _under_workspace(candidate, work_root):
        candidate = Path(work_root) / raw.lstrip('/')
        if not _under_workspace(candidate, work_root):
            raise PermissionError(f'Path outside workspace ({work_root}) is not allowed: {candidate}')
    return candidate.resolve()

def _db_write_guard(p):
    return p.resolve() in (DB_FILE.resolve(), DB_FILE.resolve().with_suffix('.db-wal'),
                           DB_FILE.resolve().with_suffix('.db-shm'))

_SEARCH_SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache'}

def search_files_core(root, pattern, max_results=100):
    try:
        rx = re.compile(pattern)
    except re.error:
        rx = re.compile(re.escape(pattern))
    matches = []
    for p in sorted(root.rglob('*')):
        if len(matches) >= max_results:
            break
        if not p.is_file() or p.stat().st_size > 1_000_000:
            continue
        if any(part in _SEARCH_SKIP_DIRS or part.startswith('.') for part in p.relative_to(root).parts[:-1]):
            continue
        try:
            head = p.open('rb').read(8192)
            if b'\0' in head:
                continue
            for lineno, line in enumerate(p.read_text(errors='replace').splitlines(), 1):
                if rx.search(line):
                    matches.append({'file': str(p), 'line': lineno, 'text': line.strip()[:200]})
                    if len(matches) >= max_results:
                        break
        except OSError:
            continue
    return matches

def http_request_core(url, method='GET', headers=None, body=None):
    # Unlike web_fetch, private/localhost URLs are allowed here on purpose:
    # the point of this tool is testing services the agents themselves run.
    p = urllib.parse.urlparse(url)
    if p.scheme not in ('http', 'https'):
        return {'error': 'Only http/https URLs are allowed'}
    hdrs = {'User-Agent': 'Mozilla/5.0'}
    if isinstance(headers, dict):
        hdrs.update({str(k): str(v) for k, v in headers.items()})
    data = None
    if body is not None:
        data = (json.dumps(body) if isinstance(body, (dict, list)) else str(body)).encode()
        hdrs.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, method=str(method or 'GET').upper(), headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {'status': resp.status,
                    'headers': dict(list(resp.headers.items())[:20]),
                    'body': resp.read(262144).decode('utf-8', errors='replace')[:50000]}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'body': e.read(262144).decode('utf-8', errors='replace')[:50000]}

def run_command_core(command, cwd=None, timeout=60, work_root=None):
    if cwd:
        work = pipe_path_safe(cwd, work_root)
    else:
        work = Path(work_root) if work_root else get_fs_root()
    if not work.is_dir():
        return {'error': f'cwd is not a directory: {work}'}
    try:
        timeout = max(1, min(int(timeout or 60), 120))
    except (TypeError, ValueError):
        timeout = 60
    try:
        r = subprocess.run(['bash', '-c', command], cwd=str(work),
                           capture_output=True, text=True, timeout=timeout)
        return {'exit_code': r.returncode,
                'stdout': r.stdout[-20000:], 'stderr': r.stderr[-20000:]}
    except subprocess.TimeoutExpired as e:
        return {'error': f'Command timed out after {timeout}s',
                'stdout': (e.stdout or '')[-20000:], 'stderr': (e.stderr or '')[-20000:]}

# ── Browser tools (Playwright, lazy singleton per process) ────────────────────

_BROWSER = {'pw': None, 'browser': None, 'page': None, 'console': []}

def _browser_page():
    if _BROWSER['page'] is not None and not _BROWSER['page'].is_closed():
        return _BROWSER['page']
    from playwright.sync_api import sync_playwright   # ImportError → caught by exec_tool
    if _BROWSER['browser'] is None:
        _BROWSER['pw'] = sync_playwright().start()
        _BROWSER['browser'] = _BROWSER['pw'].chromium.launch(headless=True)
    page = _BROWSER['browser'].new_page(viewport={'width': 1280, 'height': 900})
    _BROWSER['console'] = []
    page.on('console', lambda m: _BROWSER['console'].append(f'[{m.type}] {m.text}'[:500]))
    page.on('pageerror', lambda e: _BROWSER['console'].append(f'[pageerror] {e}'[:500]))
    _BROWSER['page'] = page
    return page

def browser_close():
    for key, stop in (('browser', 'close'), ('pw', 'stop')):
        obj = _BROWSER.get(key)
        if obj is not None:
            try: getattr(obj, stop)()
            except Exception: pass
    _BROWSER.update({'pw': None, 'browser': None, 'page': None, 'console': []})

_SNAPSHOT_JS = """() => {
  const els = document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]');
  const out = []; let n = 0;
  for (const el of els) {
    if (n >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    n++;
    el.setAttribute('data-agent-ref', String(n));
    out.push({ref: n, tag: el.tagName.toLowerCase(), type: el.type || '',
              text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 80)});
  }
  return out;
}"""

def browser_snapshot():
    page = _browser_page()
    els = page.evaluate(_SNAPSHOT_JS)
    text = page.evaluate("() => document.body ? document.body.innerText : ''")
    return {'url': page.url, 'title': page.title(), 'text': text[:4000],
            'elements': els,
            'hint': 'Use the ref numbers with browser_click / browser_type.'}

def exec_tool(name, args, allowed=None, work_root=None):
    if allowed is not None and name not in allowed:
        return {'error': f'Tool not permitted for this agent: {name}'}
    root = Path(work_root) if work_root else get_fs_root()
    try:
        if name == 'read_file':
            p = pipe_path_safe(args.get('path', ''), work_root)
            return {'content': p.read_text()}
        elif name == 'write_file':
            p = pipe_path_safe(args.get('path', ''), work_root)
            if _db_write_guard(p):
                return {'error': 'Writing to the system database file is not allowed'}
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(args.get('content', ''))
            return {'ok': True, 'path': str(p)}
        elif name == 'edit_file':
            p = pipe_path_safe(args.get('path', ''), work_root)
            if _db_write_guard(p):
                return {'error': 'Editing the system database file is not allowed'}
            old, new = args.get('old_string', ''), args.get('new_string', '')
            if not old:
                return {'error': 'old_string is required'}
            text = p.read_text()
            count = text.count(old)
            if count == 0:
                return {'error': 'old_string not found in file'}
            if count > 1 and not args.get('replace_all'):
                return {'error': f'old_string occurs {count} times — add surrounding context to make it unique, or set replace_all=true'}
            p.write_text(text.replace(old, new) if args.get('replace_all') else text.replace(old, new, 1))
            return {'ok': True, 'path': str(p), 'replacements': count if args.get('replace_all') else 1}
        elif name == 'list_files':
            p = pipe_path_safe(args.get('path', str(root)), work_root)
            entries = [{'name': e.name, 'type': 'dir' if e.is_dir() else 'file'}
                       for e in sorted(p.iterdir())]
            return {'entries': entries}
        elif name == 'search_files':
            p = pipe_path_safe(args.get('path', str(root)), work_root)
            pattern = args.get('pattern', '')
            if not pattern:
                return {'error': 'pattern is required'}
            return {'matches': search_files_core(p, pattern)}
        elif name == 'web_search':
            results = web_search_core(args.get('query', ''))
            return {'results': results}
        elif name == 'web_fetch':
            content, err = web_fetch_core(args.get('url', ''))
            return {'content': content} if not err else {'error': err}
        elif name == 'http_request':
            return http_request_core(args.get('url', ''), args.get('method', 'GET'),
                                     args.get('headers'), args.get('body'))
        elif name == 'run_command':
            if not args.get('command'):
                return {'error': 'command is required'}
            return run_command_core(args['command'], args.get('cwd'), args.get('timeout'), work_root)
        elif name == 'browser_navigate':
            page = _browser_page()
            page.goto(args.get('url', ''), timeout=20000, wait_until='load')
            return browser_snapshot()
        elif name == 'browser_snapshot':
            return browser_snapshot()
        elif name == 'browser_click':
            page = _browser_page()
            page.click(f'[data-agent-ref="{int(args.get("ref", 0))}"]', timeout=5000)
            try: page.wait_for_load_state('load', timeout=5000)
            except Exception: pass
            return browser_snapshot()
        elif name == 'browser_type':
            page = _browser_page()
            sel = f'[data-agent-ref="{int(args.get("ref", 0))}"]'
            page.fill(sel, args.get('text', ''), timeout=5000)
            if args.get('submit'):
                page.press(sel, 'Enter', timeout=5000)
                try: page.wait_for_load_state('load', timeout=5000)
                except Exception: pass
            return browser_snapshot()
        elif name == 'browser_console':
            return {'messages': _BROWSER['console'][-30:]}
        elif name == 'browser_screenshot':
            page = _browser_page()
            p = pipe_path_safe(args.get('path') or str(root / 'screenshot.png'), work_root)
            p.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(p), full_page=bool(args.get('full_page')))
            return {'ok': True, 'path': str(p)}
        else:
            return {'error': f'Unknown tool: {name}'}
    except ImportError:
        return {'error': 'Browser tools need Playwright: pip3 install playwright && python3 -m playwright install chromium'}
    except Exception as e:
        return {'error': str(e)}

# ── Model router ──────────────────────────────────────────────────────────────

DEFAULT_ROUTER = {
    'tiers': {
        'local':    {'provider': 'ollama',    'model': ''},
        'fast':     {'provider': 'anthropic', 'model': 'claude-haiku-4-5-20251001'},
        'smart':    {'provider': 'anthropic', 'model': 'claude-sonnet-4-6'},
        'powerful': {'provider': 'anthropic', 'model': 'claude-opus-4-8'},
    }
}

def load_router(cfg):
    try:
        r = json.loads(cfg.get('model_router') or '{}')
        return r if r.get('tiers') else DEFAULT_ROUTER
    except Exception:
        return DEFAULT_ROUTER

DEFAULT_OLLAMA_ENDPOINT = 'http://192.168.1.205:11434,http://192.168.1.251:11434,http://192.168.1.240:11434,http://localhost:11434'
_ollama_host_cache = {'url': None, 'ts': 0.0}

def resolve_ollama_endpoint(cfg):
    """Pick the first reachable host from the (comma-separated) `endpoint` setting
    — defaults to the 205 → 251 → 240 → localhost fallback chain — caching the
    winner for 20s so every LLM call doesn't re-probe all candidates."""
    candidates = [c.strip().rstrip('/') for c in (cfg.get('endpoint') or DEFAULT_OLLAMA_ENDPOINT).split(',') if c.strip()]
    if len(candidates) == 1:
        return candidates[0]
    now = time.time()
    if _ollama_host_cache['url'] and now - _ollama_host_cache['ts'] < 20:
        return _ollama_host_cache['url']
    for url in candidates:
        try:
            urllib.request.urlopen(f'{url}/api/tags', timeout=1.5)
            _ollama_host_cache.update(url=url, ts=now)
            return url
        except Exception:
            continue
    return candidates[0]

def estimate_tier(messages):
    total_chars = sum(len(str(m.get('content', ''))) for m in messages)
    tokens = total_chars // 4
    if tokens < 2000:
        return 'local'
    elif tokens < 8000:
        return 'fast'
    return 'smart'

def resolve_llm(tier, messages, router, cfg, default_model):
    """Returns (provider, model, endpoint_or_apikey)."""
    if tier == 'auto':
        tier = estimate_tier(messages)
    tier_cfg = router.get('tiers', {}).get(tier, {})
    provider = tier_cfg.get('provider', 'ollama')
    model    = tier_cfg.get('model', '') or default_model
    if provider == 'ollama':
        endpoint = tier_cfg.get('endpoint') or resolve_ollama_endpoint(cfg)
        return 'ollama', model or default_model, endpoint
    elif provider == 'anthropic':
        return 'anthropic', model, cfg.get('anthropic_api_key', '')
    elif provider == 'openai':
        return 'openai', model, cfg.get('openai_api_key', '')
    return 'ollama', default_model, resolve_ollama_endpoint(cfg)

# ── Loop primitive (evaluator-driven) ─────────────────────────────────────────

def loop_cfg_of(step):
    """Normalized loop config for a step, or None when looping is disabled."""
    lc = step.get('loopConfig') or {}
    if not lc.get('enabled'):
        return None
    back = lc.get('backToStep')
    return {
        'backToStep':    int(back) if back is not None else step['stepIndex'],
        'maxIterations': max(1, min(20, int(lc.get('maxIterations') or lc.get('maxDepth') or 5))),
        'sentinel':      (lc.get('sentinel') or lc.get('stopCondition') or '').strip(),
        'tokenBudget':   int(lc.get('tokenBudget') or 0),
    }

def loop_exit_reason(lcfg, verdict, output, iteration, prev_hash, loop_chars):
    """First termination-stack signal that fires, or None to keep iterating."""
    if verdict != 'iterate':
        return 'evaluator_done'
    if lcfg['sentinel'] and lcfg['sentinel'].lower() in output.lower():
        return 'sentinel'
    if iteration + 1 >= lcfg['maxIterations']:
        return 'max_iterations'
    if prev_hash and hashlib.sha256(output.encode()).hexdigest() == prev_hash:
        return 'stalled'
    if lcfg['tokenBudget'] and loop_chars // 4 >= lcfg['tokenBudget']:
        return 'budget'
    return None

def job_cancel_requested(job_id):
    with db_session() as db:
        row = db.execute('SELECT status FROM jobs WHERE id=?', (job_id,)).fetchone()
    return bool(row) and row['status'] == 'cancelling'

# ── Dynamic pipeline turns ──────────────────────────────────────────────────

def insert_turn(run_id, turn_index, agent_id, agent_name, action, instructions='', reasoning=''):
    tid = str(time.time_ns())
    with db_session() as db:
        db.execute(
            'INSERT INTO pipeline_turns '
            '(id,run_id,turn_index,agent_id,agent_name,action,instructions,reasoning,status) '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            (tid, run_id, turn_index, agent_id, agent_name, action, instructions, reasoning, 'running')
        )
    return tid

def update_turn(run_id, turn_index, **kwargs):
    with db_session() as db:
        fields = ', '.join(f'{k}=?' for k in kwargs)
        db.execute(
            f'UPDATE pipeline_turns SET {fields} WHERE run_id=? AND turn_index=?',
            (*kwargs.values(), run_id, turn_index)
        )

def supersede_turns_after(run_id, root_cause_index, new_turn_index):
    with db_session() as db:
        db.execute(
            'UPDATE pipeline_turns SET superseded_by=? '
            'WHERE run_id=? AND turn_index>? AND turn_index<? AND superseded_by IS NULL',
            (new_turn_index, run_id, root_cause_index, new_turn_index)
        )

def get_live_turns(run_id):
    with db_session() as db:
        rows = rows_to_list(db.execute(
            'SELECT * FROM pipeline_turns WHERE run_id=? AND superseded_by IS NULL ORDER BY turn_index',
            (run_id,)
        ).fetchall())
    return rows

def build_orchestrator_prompt(pipeline, roster_agents, turns, workspace_diff):
    roster_lines = [
        f'- id={a["id"]} name="{a["name"]}" role="{a.get("role") or "(none)"}" '
        f'goal="{a.get("agent_goal") or "(none)"}" '
        f'expected_output="{a.get("expected_output") or "(none)"}"'
        for a in roster_agents
    ]
    roster_text = '\n'.join(roster_lines) or '(roster is empty)'

    history_lines = []
    for t in turns:
        line = f'Turn {t["turn_index"]}: action={t["action"]} agent={t.get("agent_name","")}\n'
        if t.get('instructions'):    line += f'  instructions: {t["instructions"]}\n'
        if t.get('reasoning'):       line += f'  reasoning: {t["reasoning"]}\n'
        if t.get('output'):          line += f'  output: {t["output"][:2000]}\n'
        if t.get('workspace_diff'):  line += f'  workspace diff:\n{t["workspace_diff"]}\n'
        if t.get('verify_status'):   line += f'  verify_status: {t["verify_status"]}\n'
        history_lines.append(line)
    history_text = '\n'.join(history_lines) or '(no turns yet — this is the first decision)'

    return [{'role': 'user', 'content': (
        f'You are the orchestrator for a dynamic pipeline.\n'
        f'Goal: {pipeline["goal"]}\n\n'
        f'Agent roster (the ONLY agents you may invoke):\n{roster_text}\n\n'
        f'Turn history so far:\n{history_text}\n\n'
        f'Current workspace state (uncommitted changes since the last turn):\n'
        f'{workspace_diff or "(no changes)"}\n\n'
        f'Decide what happens next. Respond ONLY with valid JSON (no markdown fences, no extra text):\n'
        '{"action":"invoke","agentId":"<id from roster>","instructions":"<specific task for that agent>",'
        '"reasoning":"<why this agent, why now>","rootCauseTurn":null}\n'
        'or {"action":"verify","reasoning":"<why verification is needed now>"}\n'
        'or {"action":"done","reasoning":"<why the goal is fully satisfied>"}\n'
        'or {"action":"fail","reasoning":"<why this cannot be completed>"}\n\n'
        'Set "rootCauseTurn" to the turn_index of an earlier turn ONLY when you have identified that turn '
        'as the actual source of a problem (not the turn that merely surfaced it) — the corrective invoke '
        'you specify will invalidate every turn after it. Otherwise leave it null or omit it.\n'
        'Be strict: keep each agent scoped to its stated role/goal/expected_output — reject scope creep '
        '(e.g. a planner writing implementation code, or a developer redesigning the plan) by routing '
        'to the right agent instead of letting one agent do everyone\'s job.'
    )}]

def parse_orchestrator_decision(raw, roster_ids):
    try:
        cleaned = raw.strip().lstrip('`').removeprefix('json').strip('`').strip()
        if not cleaned.startswith('{'):
            start, end = cleaned.rfind('{'), cleaned.rfind('}')
            if start != -1 and end > start:
                cleaned = cleaned[start:end + 1]
        decision = json.loads(cleaned)
    except Exception:
        return None, f'unparseable orchestrator response: {raw[:200]}'
    action = decision.get('action')
    if action not in ('invoke', 'verify', 'done', 'fail'):
        return None, f'invalid action {action!r} — must be invoke, verify, done, or fail'
    if action == 'invoke':
        agent_id = decision.get('agentId')
        if agent_id not in roster_ids:
            return None, f'agentId {agent_id!r} is not in the roster; valid ids are: {sorted(roster_ids)}'
        if not decision.get('instructions'):
            return None, 'invoke decisions require non-empty "instructions"'
    rc = decision.get('rootCauseTurn')
    decision['rootCauseTurn'] = rc if isinstance(rc, int) and not isinstance(rc, bool) and rc >= 0 else None
    decision.setdefault('reasoning', '')
    return decision, None

def ask_orchestrator(pipeline, roster_agents, turns, workspace_diff, router, cfg, base_ctx, pm_model, pm_tier):
    roster_ids = {a['id'] for a in roster_agents}
    msgs = build_orchestrator_prompt(pipeline, roster_agents, turns, workspace_diff)
    for _ in range(3):
        provider, model, cred = resolve_llm(pm_tier, msgs, router, cfg, pm_model)
        if provider == 'anthropic':
            raw, err = anthropic_once(cred, model, msgs)
        else:
            raw, err = ollama_once(cred, model, msgs, num_ctx=base_ctx)
        if not raw:
            msgs = msgs + [{'role': 'user', 'content':
                            f'Your previous response failed: {err or "empty response"}. '
                            f'Try again — respond ONLY with the JSON decision.'}]
            continue
        decision, val_err = parse_orchestrator_decision(raw, roster_ids)
        if decision is not None:
            return decision, None
        msgs = msgs + [{'role': 'user', 'content':
                        f'Your previous response was invalid: {val_err}. '
                        f'Try again — respond ONLY with the JSON decision.'}]
    return None, 'orchestrator failed to produce a valid decision after 3 attempts'

def run_verification(pipeline, roster_agents, work_root, run_llm_fn, turn_index):
    """Returns (status, output, tier). Tier 1 = real command, tier 2 = QA-role
    agent's independent judgment, tier 3 = no ground truth available — the
    orchestrator's own stated reasoning (already on the turn record) is the
    only justification for 'done' in that case."""
    verify_command = (pipeline.get('verify_command') or '').strip()
    if verify_command:
        result = run_command_core(verify_command, cwd=None, timeout=120, work_root=work_root)
        if 'error' in result:
            return 'failed', result['error'], 1
        passed = result['exit_code'] == 0
        output = f"exit_code={result['exit_code']}\nstdout:\n{result['stdout']}\nstderr:\n{result['stderr']}"
        return ('passed' if passed else 'failed'), output, 1

    qa_agent = next((a for a in roster_agents if any(
        kw in (a.get('role') or '').lower() for kw in ('qa', 'review', 'test')
    )), None)
    if qa_agent:
        agent_tools_cfg = json.loads(qa_agent.get('tools') or '{}')
        agent_tools = build_tools(agent_tools_cfg)
        msgs = [
            {'role': 'system', 'content': qa_agent.get('system_prompt') or ''},
            {'role': 'user', 'content': (
                f'Pipeline goal: {pipeline["goal"]}\n'
                f'Review the current workspace state against the goal. '
                f'Respond ONLY with valid JSON: {{"passed": true|false, "notes": "specific findings"}}'
            )},
        ]
        raw, err = run_llm_fn('auto', msgs, agent_tools, turn_index, agent_ctx=qa_agent.get('context_len') or 0)
        if not raw:
            return 'failed', f'QA agent unavailable: {err}', 2
        try:
            cleaned = raw.strip().lstrip('`').removeprefix('json').strip('`').strip()
            if not cleaned.startswith('{'):
                start, end = cleaned.rfind('{'), cleaned.rfind('}')
                if start != -1 and end > start:
                    cleaned = cleaned[start:end + 1]
            result = json.loads(cleaned)
        except Exception:
            return 'failed', f'QA agent gave unparseable response: {raw[:200]}', 2
        return ('passed' if result.get('passed') else 'failed'), result.get('notes', ''), 2

    return ('passed',
            'No verify_command configured and no QA-role agent in the roster — self-check tier: '
            'see this turn\'s "reasoning" for why ground-truth verification does not apply here.',
            3)

def verification_satisfied(turns):
    """True only if the most recent verify turn must exist, be the latest verify
    attempt, and have passed, and no invoke turn has landed changes since it.
    `turns` must be live (non-superseded), ordered by turn_index — i.e. exactly
    what get_live_turns() returns."""
    last_verify = None
    for t in turns:
        if t['action'] == 'verify':
            last_verify = t
    if last_verify is None or last_verify.get('verify_status') != 'passed':
        return False
    return not any(t['action'] == 'invoke' and t['turn_index'] > last_verify['turn_index'] for t in turns)

_HW_NUM_CTX = None

def detect_num_ctx(cfg):
    """Baseline Ollama context window: explicit `num_ctx` setting wins, else a
    tier picked from detected GPU VRAM (nvidia-smi runs on this host — assumes
    Ollama is local; set `num_ctx` in settings when it isn't), else 4096."""
    global _HW_NUM_CTX
    try:
        override = int(cfg.get('num_ctx') or 0)
        if override > 0:
            return override
    except (TypeError, ValueError):
        pass
    if _HW_NUM_CTX is None:
        vram_mb = 0
        try:
            out = subprocess.run(
                ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
                capture_output=True, text=True, timeout=10)
            vram_mb = max(int(l.strip()) for l in out.stdout.splitlines() if l.strip())
        except Exception:
            pass
        if   vram_mb >= 24000: _HW_NUM_CTX = 32768
        elif vram_mb >= 16000: _HW_NUM_CTX = 16384
        elif vram_mb >=  8000: _HW_NUM_CTX = 8192
        else:                  _HW_NUM_CTX = 4096
    return _HW_NUM_CTX

# ── LLM calls ─────────────────────────────────────────────────────────────────

def _tool(name, description, required, properties):
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'required': required, 'properties': properties}}}

PIPELINE_TOOLS = [
    _tool('read_file', 'Read the contents of a file.',
          ['path'], {'path': {'type': 'string'}}),
    _tool('write_file', 'Write content to a file, creating it if needed. Overwrites the whole file — prefer edit_file for small changes.',
          ['path', 'content'], {'path': {'type': 'string'}, 'content': {'type': 'string'}}),
    _tool('edit_file', 'Replace an exact string in a file. old_string must match the file exactly and occur once (or set replace_all).',
          ['path', 'old_string', 'new_string'],
          {'path': {'type': 'string'}, 'old_string': {'type': 'string'},
           'new_string': {'type': 'string'}, 'replace_all': {'type': 'boolean'}}),
    _tool('list_files', 'List files and directories at a path.',
          ['path'], {'path': {'type': 'string'}}),
    _tool('search_files', 'Search file contents recursively under a directory. Pattern is a regex (falls back to literal text). Returns file, line number, and matching line.',
          ['pattern'], {'pattern': {'type': 'string'}, 'path': {'type': 'string', 'description': 'Directory to search (default: workspace root)'}}),
    _tool('web_search', 'Search the web and return titles, URLs, and snippets.',
          ['query'], {'query': {'type': 'string'}}),
    _tool('web_fetch', 'Fetch the text content of a URL.',
          ['url'], {'url': {'type': 'string'}}),
    _tool('http_request', 'Make an HTTP request (any method, headers, body) and return status and body. Works against localhost — use it to test APIs and servers.',
          ['url'], {'url': {'type': 'string'}, 'method': {'type': 'string'},
                    'headers': {'type': 'object'}, 'body': {'type': 'string'}}),
    _tool('run_command', 'Run a bash command and return exit code, stdout, and stderr. Times out after `timeout` seconds (max 120).',
          ['command'], {'command': {'type': 'string'},
                        'cwd': {'type': 'string', 'description': 'Working directory (default: workspace root)'},
                        'timeout': {'type': 'integer'}}),
    _tool('browser_navigate', 'Open a URL in a headless browser. Returns page title, visible text, and numbered interactive elements.',
          ['url'], {'url': {'type': 'string'}}),
    _tool('browser_snapshot', 'Re-read the current browser page: title, visible text, and numbered interactive elements.',
          [], {}),
    _tool('browser_click', 'Click an element by its ref number from the latest snapshot. Returns a fresh snapshot.',
          ['ref'], {'ref': {'type': 'integer'}}),
    _tool('browser_type', 'Type text into an input by its ref number. Set submit=true to press Enter after. Returns a fresh snapshot.',
          ['ref', 'text'], {'ref': {'type': 'integer'}, 'text': {'type': 'string'}, 'submit': {'type': 'boolean'}}),
    _tool('browser_console', 'Return recent browser console messages and page errors — check after interactions to catch JS errors.',
          [], {}),
    _tool('browser_screenshot', 'Save a PNG screenshot of the current page to a file path.',
          [], {'path': {'type': 'string'}, 'full_page': {'type': 'boolean'}}),
]

TOOL_GROUPS = {
    'files':   ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'],
    'web':     ['web_search', 'web_fetch', 'http_request'],
    'shell':   ['run_command'],
    'browser': ['browser_navigate', 'browser_snapshot', 'browser_click',
                'browser_type', 'browser_console', 'browser_screenshot'],
}

def build_tools(perms):
    """Ollama-format tool defs for an agent's tools config, e.g. {'files': true, 'shell': true}."""
    names = {n for g, ns in TOOL_GROUPS.items() if (perms or {}).get(g) for n in ns}
    return [t for t in PIPELINE_TOOLS if t['function']['name'] in names]

def flush_chunks(job_id, pending):
    """Write accumulated step_chunk events to the DB in one transaction."""
    if not pending:
        return
    lines = ''.join(json.dumps(e) + '\n' for e in pending)
    with db_session() as db:
        db.execute("UPDATE jobs SET output_log = output_log || ? WHERE id = ?", (lines, job_id))
    pending.clear()

def ollama_agentic(ollama_ep, model, messages, use_tools, step_idx, job_id, num_ctx=0, work_root=None):
    """Agentic loop: call Ollama, execute tool calls, repeat until done.
    `use_tools` is the list of tool defs this agent may use (empty/None = no tools).
    Logs step_chunk, step_thinking and tool_call events. Returns (output_text, error).
    Streaming keeps the socket alive through long thinking phases, so timeout=300
    is per-chunk, not a cap on total generation time."""
    msgs = list(messages)
    all_output = []
    all_thinking = []
    tools = use_tools or []
    allowed = {t['function']['name'] for t in tools}
    nudged = False
    last_cancel_check = time.monotonic()

    for _ in range(10):
        content_parts = []
        tool_calls = []
        pending_chunks = []
        try:
            req_body = json.dumps({
                'model': model, 'messages': msgs, 'stream': True,
                **(({'options': {'num_ctx': num_ctx}}) if num_ctx else {}),
                **(({'tools': tools}) if tools else {}),
            }).encode()
            req = urllib.request.Request(
                f'{ollama_ep}/api/chat', data=req_body, method='POST',
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                for raw_line in resp:
                    now = time.monotonic()
                    if now - last_cancel_check >= 2:
                        last_cancel_check = now
                        if job_cancel_requested(job_id):
                            flush_chunks(job_id, pending_chunks)
                            ollama_unload(ollama_ep, model)
                            return None, 'cancelled'
                    line = raw_line.decode('utf-8', errors='replace').strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        msg  = chunk.get('message', {})
                        text = msg.get('content', '')
                        if text:
                            content_parts.append(text)
                            pending_chunks.append({'type': 'step_chunk', 'stepIndex': step_idx, 'chunk': text})
                        think = msg.get('thinking', '')
                        if think:
                            all_thinking.append(think)
                            pending_chunks.append({'type': 'step_thinking', 'stepIndex': step_idx, 'chunk': think})
                        if len(pending_chunks) >= 20:
                            flush_chunks(job_id, pending_chunks)
                        tcs = msg.get('tool_calls')
                        if tcs:
                            tool_calls.extend(tcs)
                    except Exception:
                        pass
        except Exception as e:
            flush_chunks(job_id, pending_chunks)
            return None, str(e)
        flush_chunks(job_id, pending_chunks)

        content = ''.join(content_parts)
        if content:
            all_output.append(content)

        if not tool_calls:
            if tools and content and not nudged:
                nudged = True
                msgs.append({'role': 'assistant', 'content': content})
                msgs.append({'role': 'user', 'content':
                    'Please now execute the plan using the available tools. '
                    'Call the tools directly — do not describe what you will do.'})
                continue
            break

        msgs.append({'role': 'assistant', 'content': content, 'tool_calls': tool_calls})
        for tc in tool_calls:
            fn   = tc.get('function', {})
            name = fn.get('name', '')
            args = fn.get('arguments', {})
            if isinstance(args, str):
                try: args = json.loads(args)
                except Exception: args = {}
            result = exec_tool(name, args, allowed=allowed, work_root=work_root)
            log_event(job_id, {'type': 'tool_call', 'stepIndex': step_idx,
                                'tool': name, 'result': result})
            msgs.append({'role': 'tool', 'content': json.dumps(result)})

    ollama_unload(ollama_ep, model)
    final = '\n\n'.join(filter(None, all_output))
    # Thinking models can exhaust the generation in the thinking channel and
    # leave content empty — the tail of the reasoning beats returning nothing.
    return final or ''.join(all_thinking), None

def ollama_unload(ollama_ep, model):
    """Tell Ollama to evict the model from VRAM immediately."""
    try:
        body = json.dumps({'model': model, 'keep_alive': 0}).encode()
        req = urllib.request.Request(
            f'{ollama_ep}/api/generate', data=body, method='POST',
            headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

def ollama_once(ollama_ep, model, messages, num_ctx=0):
    """Single-turn Ollama call (no tools), streamed so the timeout is per-chunk
    rather than a cap on total generation time — a thinking model can reason
    past 300s as long as tokens keep flowing. Returns (output, error)."""
    content, thinking = [], []
    try:
        body = {'model': model, 'messages': messages, 'stream': True, 'keep_alive': 0}
        if num_ctx:
            body['options'] = {'num_ctx': num_ctx}
        req = urllib.request.Request(
            f'{ollama_ep}/api/chat', data=json.dumps(body).encode(), method='POST',
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            for raw_line in resp:
                line = raw_line.decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line).get('message', {})
                except Exception:
                    continue
                if msg.get('content'):
                    content.append(msg['content'])
                if msg.get('thinking'):
                    thinking.append(msg['thinking'])
        # Thinking models can burn the whole generation in `thinking` and leave
        # `content` empty; the answer (if any) is at the end of the thinking text.
        return ''.join(content) or ''.join(thinking), None
    except Exception as e:
        return None, str(e)

# ── Anthropic tools format (input_schema instead of parameters) ───────────────

def to_anthropic_tools(tools):
    return [
        {'name': t['function']['name'],
         'description': t['function']['description'],
         'input_schema': t['function']['parameters']}
        for t in (tools or [])
    ]

def anthropic_agentic(api_key, model, messages, use_tools, step_idx, job_id, work_root=None):
    """Agentic loop using Anthropic /v1/messages streaming. `use_tools` is the
    list of ollama-format tool defs this agent may use. Returns (output, error)."""
    if not api_key:
        return None, 'anthropic_api_key not set in settings'

    # Split system from conversation
    system_text = None
    ant_msgs = []
    for m in messages:
        role = m.get('role')
        if role == 'system':
            system_text = m.get('content', '')
        elif role in ('user', 'assistant'):
            ant_msgs.append({'role': role, 'content': m.get('content', '') or ''})

    tools = to_anthropic_tools(use_tools)
    allowed = {t['name'] for t in tools}
    all_output = []

    for _ in range(10):
        body = {'model': model, 'max_tokens': 8192, 'messages': ant_msgs, 'stream': True}
        if system_text:
            body['system'] = system_text
        if tools:
            body['tools'] = tools

        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=json.dumps(body).encode(), method='POST',
            headers={
                'x-api-key': api_key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            }
        )

        blocks = {}     # index -> dict
        event_type = None
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                for raw in resp:
                    line = raw.decode('utf-8', errors='replace').strip()
                    if line.startswith('event:'):
                        event_type = line[6:].strip()
                    elif line.startswith('data:'):
                        data_str = line[5:].strip()
                        if not data_str or data_str == '[DONE]':
                            continue
                        try:
                            d = json.loads(data_str)
                        except Exception:
                            continue

                        if event_type == 'content_block_start':
                            idx = d.get('index', 0)
                            cb  = d.get('content_block', {})
                            if cb.get('type') == 'text':
                                blocks[idx] = {'type': 'text', 'text': ''}
                            elif cb.get('type') == 'tool_use':
                                blocks[idx] = {'type': 'tool_use', 'id': cb.get('id',''),
                                               'name': cb.get('name',''), 'parts': []}
                        elif event_type == 'content_block_delta':
                            idx   = d.get('index', 0)
                            delta = d.get('delta', {})
                            if idx in blocks:
                                if delta.get('type') == 'text_delta':
                                    txt = delta.get('text', '')
                                    blocks[idx]['text'] += txt
                                    log_event(job_id, {'type': 'step_chunk', 'stepIndex': step_idx, 'chunk': txt})
                                elif delta.get('type') == 'input_json_delta':
                                    blocks[idx]['parts'].append(delta.get('partial_json', ''))
        except Exception as e:
            return None, str(e)

        # Collect text and tool uses
        text_out = ''
        tool_uses = []
        ant_content = []
        for idx in sorted(blocks.keys()):
            b = blocks[idx]
            if b['type'] == 'text' and b.get('text'):
                text_out = b['text']
                ant_content.append({'type': 'text', 'text': text_out})
                all_output.append(text_out)
            elif b['type'] == 'tool_use':
                raw_input = ''.join(b.get('parts', []))
                try: inp = json.loads(raw_input)
                except Exception: inp = {}
                tool_uses.append({'id': b['id'], 'name': b['name'], 'input': inp})
                ant_content.append({'type': 'tool_use', 'id': b['id'], 'name': b['name'], 'input': inp})

        if not tool_uses:
            break

        ant_msgs.append({'role': 'assistant', 'content': ant_content})
        tool_results = []
        for tu in tool_uses:
            result = exec_tool(tu['name'], tu['input'], allowed=allowed, work_root=work_root)
            log_event(job_id, {'type': 'tool_call', 'stepIndex': step_idx,
                                'tool': tu['name'], 'result': result})
            tool_results.append({'type': 'tool_result', 'tool_use_id': tu['id'],
                                  'content': json.dumps(result)})
        ant_msgs.append({'role': 'user', 'content': tool_results})

    return '\n\n'.join(filter(None, all_output)), None

def anthropic_once(api_key, model, messages):
    """Non-streaming Anthropic call for PM review. Returns (output, error)."""
    if not api_key:
        return None, 'anthropic_api_key not set'
    system_text = None
    ant_msgs = []
    for m in messages:
        if m.get('role') == 'system':
            system_text = m.get('content', '')
        elif m.get('role') in ('user', 'assistant'):
            ant_msgs.append({'role': m['role'], 'content': m.get('content', '') or ''})
    body = {'model': model, 'max_tokens': 1024, 'messages': ant_msgs, 'stream': False}
    if system_text:
        body['system'] = system_text
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=json.dumps(body).encode(), method='POST',
        headers={
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        blocks = data.get('content', [])
        text = ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text')
        return text, None
    except Exception as e:
        return None, str(e)

# ── Pipeline execution ────────────────────────────────────────────────────────

def execute_job(job):
    job_id = job['id']
    pid    = job['pipeline_id']

    try:
        with db_session() as db:
            pl_row = db.execute('SELECT * FROM pipelines WHERE id=?', (pid,)).fetchone()
            if not pl_row:
                raise Exception('Pipeline not found')
            pipeline   = dict(pl_row)
            steps      = rows_to_list(db.execute(
                'SELECT * FROM pipeline_steps WHERE pipeline_id=? ORDER BY step_index', (pid,)
            ).fetchall())
            all_agents = rows_to_list(db.execute('SELECT * FROM agents').fetchall())
            cfg_rows   = rows_to_list(db.execute('SELECT key,value FROM settings').fetchall())

        cfg = {}
        for r in cfg_rows:
            try: cfg[r['key']] = json.loads(r['value'])
            except Exception: pass

        router      = load_router(cfg)
        OLLAMA_EP   = resolve_ollama_endpoint(cfg)
        max_retries = 3
        base_ctx    = detect_num_ctx(cfg)   # floor for every Ollama call this run

        # Resolve PM model + provider
        pm_tier  = 'local'
        pm_model = pipeline.get('pm_model', '')
        pm_agent = None
        if pipeline.get('pm_agent_id'):
            pm_agent = next((a for a in all_agents if a['id'] == pipeline['pm_agent_id']), None)
            if pm_agent and not pm_model:
                pm_model = pm_agent.get('model', '')
        if not pm_model:
            pm_model = next((a['model'] for a in all_agents if a.get('model')), 'llama3.1:8b')

        if pipeline.get('mode') == 'dynamic':
            execute_dynamic_job(job, pipeline, all_agents, cfg, router, base_ctx, pm_model, pm_tier)
            return

        def parse_step(s):
            return {
                **s,
                'qualityCriteria': json.loads(s.get('quality_criteria') or '[]'),
                'handoverFields':  json.loads(s.get('handover_fields') or '[]'),
                'passFullOutput':  bool(s.get('pass_full_output', 0)),
                'agentInput':      s.get('agent_input') or '',
                'stepIndex':       s['step_index'],
                'agentId':         s.get('agent_id'),
                'agentName':       s.get('agent_name', ''),
                'modelTier':       s.get('model_tier', 'local') or 'local',
                'loopConfig':      json.loads(s.get('loop_config') or '{}'),
            }

        steps = [parse_step(s) for s in steps]
        if not steps:
            log_event(job_id, {'type': 'error', 'message': 'No steps defined'})
            finish_job(job_id, 'failed', 'No steps defined')
            return

        # User feedback loop: a revision job carries the user's feedback plus a
        # pointer to the run it revises. Triage picks which steps the feedback
        # targets; steps before the first target reuse their previous output,
        # the rest re-run with their previous output as a minimal-edit baseline,
        # and the PM reviews against the feedback (and against unrelated drift).
        user_fb     = (job.get('feedback') or '').strip()
        prev_run_id = job.get('feedback_of_run')
        fb_hist     = []   # user feedback texts, oldest first (walked up the run chain)
        prev_outputs = {}  # step_index -> {stepName, output, pmNotes} from the revised run
        if user_fb and prev_run_id:
            try:
                with db_session() as db:
                    srs = rows_to_list(db.execute(
                        'SELECT * FROM pipeline_step_runs WHERE run_id=? ORDER BY iteration, step_index',
                        (prev_run_id,)
                    ).fetchall())
                    for sr in srs:   # later iterations overwrite earlier ones
                        if sr.get('output'):
                            prev_outputs[sr['step_index']] = {
                                'stepName': sr['step_name'], 'output': sr['output'],
                                'pmNotes': sr.get('pm_notes') or '',
                            }
                    rid, seen = prev_run_id, set()
                    while rid and rid not in seen:
                        seen.add(rid)
                        r = db.execute('SELECT * FROM pipeline_runs WHERE id=?', (rid,)).fetchone()
                        if not r:
                            break
                        r = dict(r)
                        if r.get('user_feedback'):
                            fb_hist.append(r['user_feedback'])
                        rid = r.get('parent_run_id')
                    fb_hist.reverse()
            except Exception:
                pass
        if user_fb:
            fb_hist.append(user_fb)

        loop_steps = [s for s in steps if loop_cfg_of(s)]
        if len(loop_steps) > 1:
            msg = 'Only one loop-enabled step per pipeline is supported'
            log_event(job_id, {'type': 'error', 'message': msg})
            finish_job(job_id, 'failed', msg)
            return
        anchor = loop_steps[0] if loop_steps else None
        lcfg = loop_cfg_of(anchor) if anchor else None
        if lcfg:
            lcfg['backToStep'] = max(0, min(lcfg['backToStep'], anchor['stepIndex']))

        run_id = str(time.time_ns())
        ts = datetime.datetime.now().isoformat()
        with db_session() as db:
            try:
                db.execute(
                    'INSERT INTO pipeline_runs (id,pipeline_id,status,started_at,user_feedback,parent_run_id) VALUES (?,?,?,?,?,?)',
                    (run_id, pid, 'running', ts, user_fb, prev_run_id)
                )
            except sqlite3.OperationalError:
                # Pre-migration schema (server not restarted yet)
                db.execute(
                    'INSERT INTO pipeline_runs (id,pipeline_id,status,started_at) VALUES (?,?,?,?)',
                    (run_id, pid, 'running', ts)
                )
            for s in steps:
                db.execute(
                    'INSERT INTO pipeline_step_runs '
                    '(id,run_id,step_id,step_index,step_name,agent_name,status) VALUES (?,?,?,?,?,?,?)',
                    (str(time.time_ns()), run_id, s['id'], s['stepIndex'],
                     s['name'], s['agentName'], 'pending')
                )

        log_event(job_id, {'type': 'run_start', 'runId': run_id, 'totalSteps': len(steps)})
        if user_fb:
            log_event(job_id, {'type': 'feedback_run_start', 'runId': run_id,
                               'feedback': user_fb, 'revision': len(fb_hist)})

        def set_run_status(status, error=None):
            with db_session() as db:
                db.execute(
                    'UPDATE pipeline_runs SET status=?,finished_at=?,error=? WHERE id=?',
                    (status, datetime.datetime.now().isoformat(), error, run_id)
                )

        cur_iter = {s['stepIndex']: 0 for s in steps}   # step_index -> active iteration

        def set_step_run(step_idx, **kwargs):
            with db_session() as db:
                fields = ', '.join(f'{k}=?' for k in kwargs)
                db.execute(
                    f'UPDATE pipeline_step_runs SET {fields} WHERE run_id=? AND step_index=? AND iteration=?',
                    (*kwargs.values(), run_id, step_idx, cur_iter[step_idx])
                )

        def run_llm(tier, msgs, use_tools, step_idx, agent_ctx=0):
            provider, model, cred = resolve_llm(tier, msgs, router, cfg, pm_model)
            if provider == 'anthropic':
                return anthropic_agentic(cred, model, msgs, use_tools, step_idx, job_id, work_root=work_root)
            # Hardware floor, but an agent configured higher gets what it asked for
            return ollama_agentic(cred, model, msgs, use_tools, step_idx, job_id,
                                  num_ctx=max(base_ctx, agent_ctx or 0), work_root=work_root)

        def run_pm(msgs):
            provider, model, cred = resolve_llm(pm_tier, msgs, router, cfg, pm_model)
            if provider == 'anthropic':
                return anthropic_once(cred, model, msgs)
            pm_ctx = (pm_agent or {}).get('context_len') or 0
            return ollama_once(cred, model, msgs, num_ctx=max(base_ctx, pm_ctx))

        # Feedback triage: ask the PM model which steps the feedback actually
        # targets, so a revision re-runs only from the first affected step.
        # Steps before it reuse their previous output verbatim (status 'reused').
        # On any triage failure fb_targets stays empty → full re-run, old behavior.
        fb_targets = set()   # step_index of steps the feedback directly targets
        fb_skip    = set()   # step_index of steps to reuse without re-running
        if user_fb and prev_outputs:
            step_lines = []
            for s in steps:
                po = prev_outputs.get(s['stepIndex'])
                snippet = ' '.join(po['output'][:500].split()) + '…' if po else '(no output)'
                step_lines.append(f'Step {s["stepIndex"] + 1}: "{s["name"]}" — task: {s["task"]}\n'
                                  f'  Previous output (truncated): {snippet}')
            triage_msgs = [{'role': 'user', 'content': (
                f'A pipeline run is being revised after user feedback.\n'
                f'Pipeline goal: {pipeline["goal"]}\n\n'
                'Steps and their previous outputs:\n' + '\n'.join(step_lines) + '\n\n'
                f'User feedback:\n"{user_fb}"\n\n'
                'Which steps does this feedback require changes to? Steps before the first '
                'affected one will be reused verbatim; steps after it re-run to stay consistent.\n'
                'Respond ONLY with valid JSON (no markdown fences, no extra text): '
                '{"revise_steps":[step numbers]} — the 1-based numbers of the directly '
                'affected steps. If unsure about a step, include it.'
            )}]
            for _triage_attempt in (1, 2):   # one retry — local PMs often flub JSON once
                triage_raw, _ = run_pm(triage_msgs)
                if not triage_raw:
                    continue
                try:
                    cleaned = triage_raw.strip().lstrip('`').removeprefix('json').strip('`').strip()
                    if not cleaned.startswith('{'):
                        start, end = cleaned.rfind('{'), cleaned.rfind('}')
                        if start != -1 and end > start:
                            cleaned = cleaned[start:end + 1]
                    nums = json.loads(cleaned).get('revise_steps') or []
                    fb_targets = {int(n) - 1 for n in nums if 0 < int(n) <= len(steps)}
                except Exception:
                    fb_targets = set()
                if fb_targets:
                    break
            if not fb_targets:
                log_event(job_id, {'type': 'feedback_triage_failed',
                                   'message': 'Triage gave no usable target steps — every step '
                                              're-runs against its baseline (maximum churn surface).'})
            if fb_targets:
                first = min(fb_targets)
                for s in steps:   # reuse the prefix that has surviving outputs
                    idx = s['stepIndex']
                    if idx >= first or not prev_outputs.get(idx):
                        break
                    fb_skip.add(idx)
                if lcfg:   # steps inside the evaluator loop range must stay re-runnable
                    fb_skip -= {s['stepIndex'] for s in steps
                                if lcfg['backToStep'] <= s['stepIndex'] <= anchor['stepIndex']}
                log_event(job_id, {'type': 'feedback_triage',
                                   'targets': sorted(fb_targets), 'reused': sorted(fb_skip)})

        work_root  = str(pipeline.get('work_dir') or get_fs_root())

        def step_uses_fs(s):
            a = next((x for x in all_agents if x['id'] == s.get('agentId')), None)
            t = json.loads(a.get('tools') or '{}') if a else {}
            return bool(t.get('files') or t.get('shell'))

        # Snapshot the workspace per file-writing step (disable via settings key
        # `workspace_git`). The pre-run commit both creates the repo on first use
        # and pins the previous run's state as the revision baseline.
        git_ok = (cfg.get('workspace_git', True)
                  and any(step_uses_fs(s) for s in steps)
                  and git_workspace_ready(work_root))
        if git_ok and git_snapshot(work_root, f'pre-run {run_id}'):
            log_event(job_id, {'type': 'workspace_snapshot', 'label': f'pre-run {run_id}'})

        # Char budgets for revision baselines and PM excerpts, scaled to what the
        # tier's model can hold — hosted models get the full picture, local ones
        # a window that fits their context.
        def tier_cap(tier, hosted, local):
            t = 'smart' if tier == 'auto' else tier
            provider = router.get('tiers', {}).get(t, {}).get('provider', 'ollama')
            return hosted if provider in ('anthropic', 'openai') else local

        pm_cap = tier_cap(pm_tier, 40_000, 4_000)

        handover   = {}    # step_index -> {stepName, agentName, output, pmNotes} (replaced on re-run)
        loop_hist  = []    # [{iteration, score, feedback, output}] for the anchor step
        loop_chars = 0     # rough cost meter across loop iterations
        prev_hash  = None  # anchor output hash from the previous iteration
        i = 0

        while i < len(steps):
            if job_cancel_requested(job_id):
                set_run_status('cancelled')
                log_event(job_id, {'type': 'run_cancelled', 'reason': 'Cancelled by user'})
                finish_job(job_id, 'cancelled')
                return

            step        = steps[i]
            step_idx    = step['stepIndex']
            base_cap    = tier_cap(step['modelTier'], 120_000, 24_000)

            # Revision run: feedback doesn't reach this step — reuse its previous
            # output instead of regenerating (regeneration is what causes drift).
            if step_idx in fb_skip:
                po = prev_outputs[step_idx]
                set_step_run(step_idx, status='reused', output=po['output'],
                             pm_notes=po['pmNotes'],
                             finished_at=datetime.datetime.now().isoformat())
                handover[step_idx] = {
                    'stepName': step['name'], 'agentName': step['agentName'],
                    'output': po['output'], 'pmNotes': po['pmNotes'],
                }
                log_event(job_id, {'type': 'step_reused', 'stepIndex': step_idx,
                                   'stepName': step['name']})
                i += 1
                continue

            is_anchor   = bool(anchor) and step_idx == anchor['stepIndex']
            iteration   = cur_iter[step_idx]
            retry_count = 0
            qa_hist     = []   # [{attempt, reason, output}] for PM-rejected attempts of this step
            looped_back = False

            while True:
                step_ts = datetime.datetime.now().isoformat()
                set_step_run(step_idx, status='running', started_at=step_ts, retry_count=retry_count)
                log_event(job_id, {'type': 'step_start', 'stepIndex': step_idx,
                                   'stepName': step['name'], 'agentName': step['agentName'],
                                   'retryCount': retry_count, 'modelTier': step['modelTier'],
                                   'iteration': iteration})

                agent = next((a for a in all_agents if a['id'] == step.get('agentId')), None)
                agent_tools_cfg = json.loads(agent.get('tools') or '{}') if agent else {}
                agent_tools = build_tools(agent_tools_cfg)
                has_tools = bool(agent_tools)

                sys_parts = []
                if agent and agent.get('system_prompt'):
                    sys_parts.append(agent['system_prompt'])
                total_steps = len(steps)
                sys_parts.append(
                    f'Pipeline goal: {pipeline["goal"]}\n'
                    f'You are step {step_idx+1} of {total_steps}: "{step["name"]}".'
                )
                if i + 1 < total_steps:
                    upcoming = steps[i + 1:]
                    next_names = ', '.join(f'"{s["name"]}"' for s in upcoming[:3])
                    sys_parts.append(
                        f'After you, the pipeline continues with: {next_names}. '
                        f'Your output must be complete and specific enough for those steps to build on.'
                    )
                else:
                    sys_parts.append('You are the FINAL step. Your output must fully resolve the pipeline goal.')
                if step['qualityCriteria']:
                    qc_text = '\n'.join(f'  - {c}' for c in step['qualityCriteria'])
                    sys_parts.append(
                        f'You will be reviewed against these quality criteria — address ALL of them:\n{qc_text}'
                    )
                if has_tools:
                    tool_names = ', '.join(t['function']['name'] for t in agent_tools)
                    tool_lines = [
                        f'You have access to tools: {tool_names}. '
                        f'USE tools to actually complete the task. '
                        f'Respond with a summary only AFTER all tool calls are done.'
                    ]
                    if agent_tools_cfg.get('files') or agent_tools_cfg.get('shell'):
                        tool_lines.append(
                            f'WORKSPACE ROOT: {work_root} — every file path MUST start with this prefix; '
                            f'commands run there by default.')
                        if user_fb:
                            tool_lines.append(
                                'REVISION RUN: the previous run\'s files already exist under the '
                                'workspace root. Read them first and edit them in place with minimal '
                                'changes — do NOT recreate, regenerate, or rewrite files the feedback '
                                'does not require you to touch.')
                    if agent_tools_cfg.get('browser'):
                        tool_lines.append(
                            'Browser tools drive a real headless Chromium: browser_navigate first, then use '
                            'the numbered element refs from the snapshot with browser_click / browser_type. '
                            'Check browser_console for JS errors when testing a web page.')
                    sys_parts.append('\n'.join(tool_lines))

                user_parts = [f'Your task: {step["task"]}']
                if step.get('agentInput'):
                    user_parts.append(f'\n## Additional input:\n{step["agentInput"]}')
                # User feedback loop: this run revises a previous run the user reviewed.
                # The previous output is the baseline — minimal edits, not regeneration.
                # Steps the feedback doesn't target only reconcile with upstream changes.
                if user_fb:
                    fb_targeted = (not fb_targets) or step_idx in fb_targets
                    user_parts.append(f'\n## User feedback loop — revision {len(fb_hist)}')
                    user_parts.append('The user reviewed the previous full run of this pipeline and requested changes.')
                    if len(fb_hist) > 1:
                        user_parts.append('## Standing requirements from earlier feedback rounds (oldest first):')
                        for n, fb in enumerate(fb_hist[:-1], 1):
                            user_parts.append(f'- Revision {n}: {fb}')
                        user_parts.append('These remain binding: your output must STILL satisfy every one '
                                          'of them. Do not undo an earlier fix while addressing the latest feedback.')
                    user_parts.append(f'## Latest user feedback:\n{user_fb}')
                    po = prev_outputs.get(step_idx)
                    if po:
                        user_parts.append(f'\n## Your output in the previous run — this is your baseline:\n{po["output"][:base_cap]}')
                    if fb_targeted:
                        if po:
                            user_parts.append(
                                '\nReproduce your baseline with only the minimal edits required to '
                                'address the latest feedback. Do not rewrite, restructure, or change '
                                'anything the feedback does not ask for.')
                        else:
                            user_parts.append('\nRevise your work to address the user feedback. '
                                              'Keep what already worked; do not restart from scratch.')
                    elif po:
                        user_parts.append(
                            '\nThe feedback does NOT target your step. Reproduce your baseline, '
                            'adjusting only what is needed to stay consistent with the updated '
                            'output from earlier steps. Do not otherwise change, rewrite, or '
                            'restructure it, and do not try to address the feedback yourself.')
                    else:
                        user_parts.append(
                            '\nThe feedback does NOT target your step — it is shown for context only. '
                            'Do your task normally; do not try to address the feedback yourself.')
                # Iteration context: history of evaluator feedback + last full output.
                # This is what makes iteration N better than N-1 instead of a re-roll.
                if lcfg and iteration > 0 and lcfg['backToStep'] <= step_idx <= anchor['stepIndex']:
                    user_parts.append(f'\n## Loop iteration {iteration + 1} of {lcfg["maxIterations"]}')
                    user_parts.append('## Evaluator feedback so far (oldest first):')
                    for h in loop_hist:
                        score = f' (score {h["score"]})' if h.get('score') is not None else ''
                        user_parts.append(f'- Iteration {h["iteration"] + 1}{score}: {h["feedback"]}')
                    user_parts.append(f'\n## Previous iteration output:\n{loop_hist[-1]["output"]}')
                    user_parts.append('\nImprove on the previous iteration. Address the feedback directly; '
                                      'do not restart from scratch or repeat what already satisfied the evaluator.')
                if handover:
                    user_parts.append('\n## Output from previous steps:')
                    for idx in sorted(handover):
                        h = handover[idx]
                        user_parts.append(f'\n### Step {idx+1}: {h["stepName"]} ({h["agentName"]})')
                        if h.get('output'):
                            user_parts.append(h['output'])
                        if h.get('pmNotes'):
                            user_parts.append(f'[PM note: {h["pmNotes"]}]')
                # Retry context: history of PM rejections + last full output.
                # Same principle as the loop above — fix the flagged problems, don't re-roll blind.
                if qa_hist:
                    user_parts.append(f'\n## Attempt {retry_count + 1} of {max_retries} — previous attempts were rejected')
                    user_parts.append('## PM feedback so far (oldest first):')
                    for h in qa_hist:
                        user_parts.append(f'- Attempt {h["attempt"]}: {h["reason"]}')
                    user_parts.append(f'\n## Previous attempt output:\n{qa_hist[-1]["output"]}')
                    user_parts.append('\nFix the problems the PM identified; do not restart from scratch '
                                      'or repeat the same mistakes.')

                messages = []
                if sys_parts:
                    messages.append({'role': 'system', 'content': '\n\n'.join(sys_parts)})
                messages.append({'role': 'user', 'content': '\n'.join(user_parts)})

                output, err = run_llm(step['modelTier'], messages, agent_tools, step_idx,
                                      agent_ctx=(agent or {}).get('context_len') or 0)

                if err == 'cancelled' or (err and job_cancel_requested(job_id)):
                    set_step_run(step_idx, status='failed', finished_at=datetime.datetime.now().isoformat())
                    set_run_status('cancelled')
                    log_event(job_id, {'type': 'run_cancelled', 'reason': 'Cancelled by user'})
                    finish_job(job_id, 'cancelled')
                    return
                if err:
                    set_step_run(step_idx, status='failed', finished_at=datetime.datetime.now().isoformat())
                    set_run_status('failed', error=f'Step {step_idx+1} error: {err}')
                    log_event(job_id, {'type': 'run_failed',
                                       'reason': f'Step {step_idx+1} ({step["name"]}) error: {err}'})
                    finish_job(job_id, 'failed', f'Step {step_idx+1} error: {err}')
                    return

                set_step_run(step_idx, output=output)
                done_evt = {'type': 'step_done', 'stepIndex': step_idx}
                if user_fb and prev_outputs.get(step_idx):
                    # Rough churn meter vs the revised run: 0 = identical, 1 = rewritten
                    done_evt['diffRatio'] = round(1 - difflib.SequenceMatcher(
                        None, prev_outputs[step_idx]['output'], output).quick_ratio(), 3)
                log_event(job_id, done_evt)

                # PM review
                log_event(job_id, {'type': 'pm_start', 'stepIndex': step_idx})
                qc_list = '\n'.join(f'  - {c}' for c in step['qualityCriteria']) or '  (none specified — use your judgement)'
                _total  = len(steps)
                _next   = steps[i + 1] if i + 1 < _total else None
                _position_line = (
                    f'Reviewing step {step_idx+1} of {_total}: "{step["name"]}" (agent: {step["agentName"]})'
                )
                _next_line = (
                    f'Next step is "{_next["name"]}" — task: {_next["task"]}\n'
                    f'This output MUST be complete and actionable enough for that step to succeed.'
                    if _next else
                    'This is the FINAL step. The output must fully resolve the pipeline goal.'
                )
                if is_anchor:
                    _loop_line = (
                        f'This step is a refinement loop: iteration {iteration + 1} of at most '
                        f'{lcfg["maxIterations"]}. Prior evaluator scores: '
                        f'{[h.get("score") for h in loop_hist] or "none"}.\n\n'
                    )
                    _verdict_spec = (
                        'Respond ONLY with valid JSON (no markdown fences, no extra text). Exactly one of:\n'
                        '{"verdict":"done","score":0-10,"notes_for_next":"summary for the next step"}'
                        ' — output fully satisfies ALL criteria and the loop goal; stop iterating.\n'
                        '{"verdict":"iterate","score":0-10,"feedback":"concrete, specific improvements'
                        ' for the next iteration"} — sound work, but another iteration moves it closer to the goal.\n'
                        '{"verdict":"fail","reason":"specific problem the agent must fix on retry"}'
                        ' — vague, incomplete, off-task, or broken.\n'
                        'Score honestly: 8+ should normally be "done". Do not say "iterate" without'
                        ' feedback the agent can act on.'
                    )
                else:
                    _loop_line = ''
                    _verdict_spec = (
                        'Respond ONLY with valid JSON (no markdown fences, no extra text):\n'
                        'If criteria met: {"verdict":"pass","notes_for_next":"specific actionable note'
                        ' for the next step (or final result summary if last)"}\n'
                        'If not met: {"verdict":"fail","reason":"specific problem the agent must fix on retry"}'
                    )
                _fb_line = _hist_line = _churn_line = ''
                if user_fb and len(fb_hist) > 1:
                    _items = '\n'.join(f'  {n}. {fb}' for n, fb in enumerate(fb_hist[:-1], 1))
                    _hist_line = (
                        f'Standing requirements from earlier feedback rounds — ALL must still hold:\n'
                        f'{_items}\n'
                        f'Reject the output if it regresses ANY of them, even while fixing the latest feedback.\n\n'
                    )
                if user_fb and git_ok and (agent_tools_cfg.get('files') or agent_tools_cfg.get('shell')):
                    _churn = git_churn_stat(work_root)
                    if _churn:
                        log_event(job_id, {'type': 'file_churn', 'stepIndex': step_idx, 'stat': _churn})
                        _churn_line = (
                            f'Files this step changed in the workspace (diff --stat vs the previous run):\n'
                            f'{_churn}\n'
                            f'Reject wholesale rewrites of files the feedback did not ask to change.\n\n'
                        )
                if user_fb:
                    _po = prev_outputs.get(step_idx)
                    _prev_snip = (
                        f'Output of this step in the previous run:\n'
                        f'{_po["output"][:pm_cap]}{"..." if len(_po["output"]) > pm_cap else ""}\n\n'
                        if _po else ''
                    )
                    if (not fb_targets) or step_idx in fb_targets:
                        _fb_line = (
                            f'This is a REVISION run: the user reviewed the previous run and gave this feedback:\n'
                            f'"{user_fb}"\n'
                            f'{_prev_snip}'
                            f'The output MUST address that feedback, and MUST NOT make substantive changes '
                            f'the feedback did not ask for. Reject it in either case — feedback ignored, '
                            f'or unrelated rewriting.\n\n'
                        )
                    else:
                        _fb_line = (
                            f'This is a REVISION run driven by user feedback on ANOTHER step:\n'
                            f'"{user_fb}"\n'
                            f'{_prev_snip}'
                            f'That feedback does not target this step, so this output should stay close to '
                            f'the previous one, changed only where updated upstream outputs require it. '
                            f'Reject it if it rewrites or drifts beyond that.\n\n'
                        )
                pm_msgs = [{'role': 'user', 'content': (
                    f'You are the strict Pipeline Manager for: "{pipeline["goal"]}"\n'
                    f'{_position_line}\n'
                    f'Task assigned to agent: {step["task"]}\n\n'
                    f'{_next_line}\n\n'
                    f'{_fb_line}'
                    f'{_hist_line}'
                    f'{_churn_line}'
                    f'{_loop_line}'
                    f'Agent output:\n{output[:pm_cap]}{"..." if len(output) > pm_cap else ""}\n\n'
                    f'Quality criteria:\n{qc_list}\n\n'
                    f'INSTRUCTIONS: Be strict. Reject anything vague, incomplete, off-task, or that '
                    f'would leave the next step without the information it needs. '
                    f'Only pass if ALL criteria are genuinely satisfied.\n\n'
                    f'{_verdict_spec}'
                )}]

                pm_raw, pm_err = run_pm(pm_msgs)
                if not pm_raw:
                    # PM call failed or returned nothing — don't block the pipeline, treat as pass with warning
                    pm_result = {'verdict': 'pass',
                                 'notes_for_next': f'[PM unavailable: {pm_err or "empty response"}]'}
                else:
                    try:
                        cleaned = pm_raw.strip().lstrip('`').removeprefix('json').strip('`').strip()
                        # Verdict JSON may be wrapped in prose (e.g. leftover thinking text) —
                        # parse the last {...} block, where the final answer lands.
                        if not cleaned.startswith('{'):
                            start, end = cleaned.rfind('{'), cleaned.rfind('}')
                            if start != -1 and end > start:
                                cleaned = cleaned[start:end + 1]
                        pm_result = json.loads(cleaned)
                    except Exception:
                        pm_result = {'verdict': 'fail', 'reason': f'PM gave unparseable response — retrying step. Raw: {pm_raw[:200]}'}

                pm_notes = pm_result.get('notes_for_next', '')
                verdict  = pm_result.get('verdict', 'pass')
                reason   = pm_result.get('reason', '')

                set_step_run(step_idx, pm_notes=pm_notes, qa_verdict=verdict, qa_reason=reason)
                log_event(job_id, {'type': 'pm_verdict', 'stepIndex': step_idx,
                                   'verdict': verdict, 'reason': reason, 'pmNotes': pm_notes,
                                   'feedback': pm_result.get('feedback', ''),
                                   'score': pm_result.get('score')})

                if verdict in ('pass', 'done', 'iterate'):
                    set_step_run(step_idx, status='done', finished_at=datetime.datetime.now().isoformat())
                    handover[step_idx] = {
                        'stepName': step['name'], 'agentName': step['agentName'],
                        'output': output, 'pmNotes': pm_notes,
                    }
                    if git_ok and (agent_tools_cfg.get('files') or agent_tools_cfg.get('shell')):
                        if git_snapshot(work_root, f'run {run_id} step {step_idx+1}: {step["name"]}'):
                            log_event(job_id, {'type': 'workspace_snapshot',
                                               'label': f'step {step_idx+1}: {step["name"]}'})

                    if is_anchor:
                        loop_chars += len(output)
                        score = pm_result.get('score')
                        exit_reason = loop_exit_reason(lcfg, verdict, output, iteration, prev_hash, loop_chars)
                        if exit_reason:
                            log_event(job_id, {'type': 'loop_done', 'stepIndex': step_idx,
                                               'iteration': iteration, 'reason': exit_reason,
                                               'score': score})
                        else:
                            feedback = pm_result.get('feedback', '') or reason
                            loop_hist.append({'iteration': iteration, 'score': score,
                                              'feedback': feedback, 'output': output[:base_cap]})
                            prev_hash = hashlib.sha256(output.encode()).hexdigest()
                            back_i = next(k for k, s in enumerate(steps)
                                          if s['stepIndex'] >= lcfg['backToStep'])
                            with db_session() as db:
                                for s in steps[back_i:i + 1]:
                                    cur_iter[s['stepIndex']] += 1
                                    db.execute(
                                        'INSERT INTO pipeline_step_runs '
                                        '(id,run_id,step_id,step_index,step_name,agent_name,status,iteration) '
                                        'VALUES (?,?,?,?,?,?,?,?)',
                                        (str(time.time_ns()), run_id, s['id'], s['stepIndex'],
                                         s['name'], s['agentName'], 'pending', cur_iter[s['stepIndex']])
                                    )
                                    handover.pop(s['stepIndex'], None)
                            log_event(job_id, {'type': 'loop_iteration', 'stepIndex': step_idx,
                                               'iteration': cur_iter[step_idx],
                                               'maxIterations': lcfg['maxIterations'],
                                               'score': score, 'feedback': feedback})
                            i = back_i
                            looped_back = True
                    break
                else:
                    retry_count += 1
                    if retry_count >= max_retries:
                        if pipeline.get('pause_on_fail', 1):
                            set_step_run(step_idx, status='paused',
                                         finished_at=datetime.datetime.now().isoformat())
                            set_run_status('paused')
                            log_event(job_id, {'type': 'run_paused',
                                               'stepIndex': step_idx, 'reason': reason})
                            finish_job(job_id, 'paused')
                            return
                        else:
                            set_step_run(step_idx, status='failed',
                                         finished_at=datetime.datetime.now().isoformat())
                            log_event(job_id, {'type': 'step_skipped',
                                               'stepIndex': step_idx, 'reason': reason})
                            handover[step_idx] = {
                                'stepName': step['name'], 'agentName': step['agentName'],
                                'output': output, 'pmNotes': f'[FAILED] {reason}',
                            }
                            break
                    else:
                        # PM may put its critique in feedback/notes instead of reason — take any of them
                        qa_hist.append({
                            'attempt': retry_count,
                            'reason': reason or pm_result.get('feedback', '') or pm_notes
                                      or 'PM rejected the output without a specific reason.',
                            'output': output[:base_cap],
                        })
                        log_event(job_id, {'type': 'step_retry', 'stepIndex': step_idx,
                                           'retryCount': retry_count, 'reason': reason})

            if not looped_back:
                i += 1

        if git_ok and git_snapshot(work_root, f'run {run_id} complete'):
            log_event(job_id, {'type': 'workspace_snapshot', 'label': f'run {run_id} complete'})

        # Feedback gate: park the run so the user can review it and either approve
        # or send feedback (which enqueues a revision job looping back to the start).
        if pipeline.get('feedback_loop', 1):
            set_run_status('awaiting_feedback')
            log_event(job_id, {'type': 'run_awaiting_feedback', 'runId': run_id})
        else:
            set_run_status('done')
        log_event(job_id, {'type': 'run_done', 'runId': run_id})
        finish_job(job_id, 'done')

    except Exception as e:
        try: log_event(job_id, {'type': 'error', 'message': str(e)})
        except Exception: pass
        try: finish_job(job_id, 'failed', str(e))
        except Exception: pass
        try: set_run_status('failed', error=str(e))
        except Exception: pass

def execute_dynamic_job(job, pipeline, all_agents, cfg, router, base_ctx, pm_model, pm_tier):
    job_id = job['id']
    pid = pipeline['id']
    roster_ids = json.loads(pipeline.get('roster') or '[]')
    roster_agents = [a for a in all_agents if a['id'] in roster_ids]
    if not roster_agents:
        log_event(job_id, {'type': 'error', 'message': 'Dynamic pipeline has no agents in its roster'})
        finish_job(job_id, 'failed', 'Empty roster')
        return

    try:
        work_root = pipeline.get('work_dir') or str(get_fs_root())
        Path(work_root).mkdir(parents=True, exist_ok=True)
        git_ok = git_workspace_ready(work_root)

        run_id = str(time.time_ns())
        with db_session() as db:
            db.execute(
                'INSERT INTO pipeline_runs (id,pipeline_id,status,started_at) VALUES (?,?,?,?)',
                (run_id, pid, 'running', datetime.datetime.now().isoformat())
            )
        log_event(job_id, {'type': 'run_start', 'runId': run_id, 'mode': 'dynamic'})

        def run_llm(tier, msgs, use_tools, turn_idx, agent_ctx=0):
            provider, model, cred = resolve_llm(tier, msgs, router, cfg, pm_model)
            if provider == 'anthropic':
                return anthropic_agentic(cred, model, msgs, use_tools, turn_idx, job_id, work_root=work_root)
            return ollama_agentic(cred, model, msgs, use_tools, turn_idx, job_id,
                                  num_ctx=max(base_ctx, agent_ctx or 0), work_root=work_root)

        def set_run_status(status, error=None):
            with db_session() as db:
                db.execute('UPDATE pipeline_runs SET status=?,finished_at=?,error=? WHERE id=?',
                           (status, datetime.datetime.now().isoformat(), error, run_id))

        max_turns = pipeline.get('max_turns') or 20
        last_invoke_hash, last_invoke_agent = None, None
        turn_index = 0

        while turn_index < max_turns:
            if job_cancel_requested(job_id):
                set_run_status('cancelled')
                log_event(job_id, {'type': 'run_cancelled', 'reason': 'Cancelled by user'})
                finish_job(job_id, 'cancelled')
                return

            workspace_diff = git_churn_stat(work_root) if git_ok else ''
            live_turns = get_live_turns(run_id)
            decision, err = ask_orchestrator(pipeline, roster_agents, live_turns, workspace_diff,
                                             router, cfg, base_ctx, pm_model, pm_tier)
            if err:
                set_run_status('failed', error=err)
                log_event(job_id, {'type': 'run_failed', 'reason': err})
                finish_job(job_id, 'failed', err)
                return

            if decision.get('rootCauseTurn') is not None:
                root_idx = decision['rootCauseTurn']
                supersede_turns_after(run_id, root_idx, turn_index)
                log_event(job_id, {'type': 'turn_superseded', 'rootCauseTurn': root_idx, 'byTurn': turn_index})
                live_turns = get_live_turns(run_id)

            action = decision['action']

            if action == 'done':
                if verification_satisfied(live_turns):
                    set_run_status('done')
                    log_event(job_id, {'type': 'run_done', 'runId': run_id})
                    finish_job(job_id, 'done')
                    return
                decision = {'action': 'verify', 'reasoning':
                           'Forced: cannot finish without a passing verification since the last change.',
                           'rootCauseTurn': None}
                action = 'verify'
                log_event(job_id, {'type': 'verification_override', 'turnIndex': turn_index})

            agent = None
            if action == 'invoke':
                agent = next((a for a in roster_agents if a['id'] == decision.get('agentId')), None)

            insert_turn(run_id, turn_index, agent['id'] if agent else None,
                       agent['name'] if agent else '', action,
                       decision.get('instructions', ''), decision.get('reasoning', ''))
            log_event(job_id, {'type': 'turn_start', 'turnIndex': turn_index, 'action': action,
                               'agentName': agent['name'] if agent else '',
                               'reasoning': decision.get('reasoning', '')})

            if action == 'fail':
                update_turn(run_id, turn_index, status='done', finished_at=datetime.datetime.now().isoformat())
                reason = decision.get('reasoning', 'Orchestrator gave up')
                set_run_status('failed', error=reason)
                log_event(job_id, {'type': 'run_failed', 'reason': reason})
                finish_job(job_id, 'failed', reason)
                return

            elif action == 'invoke':
                sys_parts = []
                if agent.get('system_prompt'):
                    sys_parts.append(agent['system_prompt'])
                sys_parts.append(
                    f'Your role: {agent.get("role") or "(unspecified)"}\n'
                    f'Your goal: {agent.get("agent_goal") or "(unspecified)"}\n'
                    f'Expected output shape: {agent.get("expected_output") or "(unspecified)"}\n'
                    f"Stay inside this role — do not do another agent's job."
                )
                sys_parts.append(f'Pipeline goal: {pipeline["goal"]}')
                agent_tools_cfg = json.loads(agent.get('tools') or '{}')
                agent_tools = build_tools(agent_tools_cfg)
                if agent_tools and (agent_tools_cfg.get('files') or agent_tools_cfg.get('shell')):
                    sys_parts.append(f'WORKSPACE ROOT: {work_root} — every file path MUST start with this prefix.')

                user_parts = [f'Your task this turn: {decision.get("instructions", "")}']
                if workspace_diff:
                    user_parts.append(f'\nCurrent workspace changes (uncommitted, real state — not a summary):\n{workspace_diff}')

                messages = [{'role': 'system', 'content': '\n\n'.join(sys_parts)},
                           {'role': 'user', 'content': '\n'.join(user_parts)}]

                if git_ok:
                    git_snapshot(work_root, f'pre-turn {turn_index}')
                output, agent_err = run_llm('auto', messages, agent_tools, turn_index,
                                            agent_ctx=agent.get('context_len') or 0)

                if agent_err == 'cancelled' or (agent_err and job_cancel_requested(job_id)):
                    set_run_status('cancelled')
                    log_event(job_id, {'type': 'run_cancelled', 'reason': 'Cancelled by user'})
                    finish_job(job_id, 'cancelled')
                    return

                diff_after = git_churn_stat(work_root) if git_ok else ''
                if agent_err:
                    update_turn(run_id, turn_index, status='failed', output=agent_err,
                               workspace_diff=diff_after, finished_at=datetime.datetime.now().isoformat())
                    log_event(job_id, {'type': 'turn_done', 'turnIndex': turn_index,
                                       'status': 'failed', 'error': agent_err})
                else:
                    update_turn(run_id, turn_index, status='done', output=output,
                               workspace_diff=diff_after, finished_at=datetime.datetime.now().isoformat())
                    log_event(job_id, {'type': 'turn_done', 'turnIndex': turn_index, 'status': 'done'})

                    stall_hash = hashlib.sha256(f'{agent["id"]}:{output}'.encode()).hexdigest()
                    if last_invoke_agent == agent['id'] and last_invoke_hash == stall_hash:
                        set_run_status('failed', error='stalled')
                        log_event(job_id, {'type': 'run_failed', 'reason': 'stalled'})
                        finish_job(job_id, 'failed', 'stalled')
                        return
                    last_invoke_hash, last_invoke_agent = stall_hash, agent['id']

            elif action == 'verify':
                status, output, tier = run_verification(pipeline, roster_agents, work_root, run_llm, turn_index)
                update_turn(run_id, turn_index, status='done', output=output, verify_status=status,
                           finished_at=datetime.datetime.now().isoformat())
                log_event(job_id, {'type': 'verification_result', 'turnIndex': turn_index,
                                   'status': status, 'tier': tier})

            turn_index += 1

        set_run_status('failed', error='max_turns')
        log_event(job_id, {'type': 'run_failed', 'reason': 'max_turns'})
        finish_job(job_id, 'failed', 'max_turns exceeded')

    except Exception as e:
        try: log_event(job_id, {'type': 'error', 'message': str(e)})
        except Exception: pass
        try: finish_job(job_id, 'failed', str(e))
        except Exception: pass
        try: set_run_status('failed', error=str(e))
        except Exception: pass

# ── Main loop ─────────────────────────────────────────────────────────────────

def handle_signal(sig, frame):
    global RUNNING
    print('\nWorker shutting down…')
    RUNNING = False

def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT,  handle_signal)
    print(f'Atlantis OS Worker — watching {DB_FILE}')
    with db_session() as db:
        db.execute("UPDATE jobs SET status='failed', error='Worker restarted while job was running' WHERE status='running'")
        db.execute("UPDATE jobs SET status='cancelled', error='Worker restarted while job was cancelling' WHERE status='cancelling'")
        db.execute("UPDATE jobs SET status='cancelled', error='Orphaned loop child (parent gone at restart)' "
                   "WHERE status='queued' AND parent_job_id IS NOT NULL")
    while RUNNING:
        job = claim_job()
        if job:
            print(f'[{datetime.datetime.now().strftime("%H:%M:%S")}] Running job {job["id"]} (pipeline {job["pipeline_id"]})')
            try:
                execute_job(job)
            finally:
                browser_close()   # don't leak the headless browser between jobs
        else:
            time.sleep(2)
    print('Worker stopped.')

if __name__ == '__main__':
    main()
