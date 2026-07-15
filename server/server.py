#!/usr/bin/env python3
"""
Ollama UI — local server + SQLite persistence + task scheduler.
Run with: python3 server.py
"""
from __future__ import annotations
import json, os, re, sqlite3, time, datetime, threading, http.server, urllib.request, urllib.parse, subprocess, ssl, shutil, sys, platform, contextlib, concurrent.futures, socket, shlex
from pathlib import Path

BASE_DIR       = Path(__file__).parent           # server/
ROOT_DIR       = BASE_DIR.parent                  # repo root
WEB_DIR        = ROOT_DIR / 'web'
DATA_DIR       = ROOT_DIR / 'data'
CERT_FILE      = DATA_DIR / 'certs' / 'cert.pem'
KEY_FILE       = DATA_DIR / 'certs' / 'key.pem'
DB_FILE        = DATA_DIR / 'data.db'
PLANS_DIR      = ROOT_DIR / 'plans'
ZONE_DIR       = DATA_DIR / 'zone'
PROJECTS_DIR   = ZONE_DIR / 'projects'

CONFIG_FILE    = ROOT_DIR / 'atlantis.config.json'
DEFAULT_CONFIG = {'port': 5000, 'root_path': str(Path.home())}

def load_config():
    if not CONFIG_FILE.exists():
        return dict(DEFAULT_CONFIG)
    try:
        cfg = json.loads(CONFIG_FILE.read_text())
        if not isinstance(cfg, dict):
            return dict(DEFAULT_CONFIG)
        return {**DEFAULT_CONFIG, **cfg}
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_CONFIG)

def _write_config_root_path(root_path):
    """Rewrite atlantis.config.json's root_path, preserving other keys, and
    update the in-memory _config so it matches what's now on disk."""
    try:
        cfg = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else dict(DEFAULT_CONFIG)
        if not isinstance(cfg, dict):
            cfg = dict(DEFAULT_CONFIG)
    except (json.JSONDecodeError, OSError):
        cfg = dict(DEFAULT_CONFIG)
    cfg['root_path'] = root_path
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
    _config['root_path'] = root_path

_config = load_config()
PORT    = _config['port']

RESTART_FLAG = DATA_DIR / '.restart'
STOP_FLAG    = DATA_DIR / '.stop'

DEFAULT_OLLAMA_ENDPOINT = 'http://192.168.1.205:11434,http://192.168.1.251:11434,http://192.168.1.240:11434,http://localhost:11434'
_ollama_host_cache = {'url': None, 'ts': 0.0}

def resolve_ollama_endpoint(raw_endpoint=None):
    """Pick the first reachable host from a comma-separated endpoint string
    — defaults to the 205 → 251 → 240 → localhost fallback chain — caching the
    winner for 20s so every LLM call doesn't re-probe all candidates."""
    candidates = [c.strip().rstrip('/') for c in (raw_endpoint or DEFAULT_OLLAMA_ENDPOINT).split(',') if c.strip()]
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

# ── Database ───────────────────────────────────────────────────────────────────

@contextlib.contextmanager
def get_db():
    # sqlite3.Connection as a context manager only manages the transaction,
    # not the connection lifetime — close explicitly to avoid leaking fds.
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS agents (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                model        TEXT,
                system_prompt TEXT,
                temperature  REAL    DEFAULT 0.7,
                top_p        REAL    DEFAULT 0.9,
                context_len  INTEGER DEFAULT 4096
            );
            CREATE TABLE IF NOT EXISTS threads (
                id            TEXT PRIMARY KEY,
                name          TEXT,
                model         TEXT,
                agent_id      TEXT,
                system_prompt TEXT,
                updated_at    TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id            TEXT PRIMARY KEY,
                thread_id     TEXT NOT NULL,
                role          TEXT NOT NULL,
                content       TEXT,
                thinking      TEXT,
                tokens        INTEGER,
                eval_duration INTEGER,
                created_at    TEXT,
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id              TEXT PRIMARY KEY,
                name            TEXT,
                model           TEXT,
                agent_id        TEXT,
                prompt_template TEXT,
                schedule        TEXT,
                created_at      TEXT
            );
            CREATE TABLE IF NOT EXISTS task_runs (
                id         TEXT PRIMARY KEY,
                task_id    TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                output     TEXT,
                tokens     INTEGER,
                error      TEXT,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pipelines (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL DEFAULT 'New Pipeline',
                goal          TEXT NOT NULL DEFAULT '',
                pm_agent_id   TEXT,
                pm_model      TEXT NOT NULL DEFAULT '',
                schedule      TEXT NOT NULL DEFAULT '{"type":"manual"}',
                pause_on_fail INTEGER NOT NULL DEFAULT 1,
                layout        TEXT NOT NULL DEFAULT '{}',
                created_at    TEXT
            );
            CREATE TABLE IF NOT EXISTS pipeline_steps (
                id               TEXT PRIMARY KEY,
                pipeline_id      TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
                step_index       INTEGER NOT NULL,
                name             TEXT NOT NULL DEFAULT '',
                agent_id         TEXT,
                agent_name       TEXT NOT NULL DEFAULT '',
                task             TEXT NOT NULL DEFAULT '',
                handover_fields  TEXT NOT NULL DEFAULT '[]',
                quality_criteria TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS pipeline_runs (
                id          TEXT PRIMARY KEY,
                pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
                status      TEXT NOT NULL DEFAULT 'running',
                started_at  TEXT,
                finished_at TEXT,
                error       TEXT
            );
            CREATE TABLE IF NOT EXISTS pipeline_step_runs (
                id            TEXT PRIMARY KEY,
                run_id        TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                step_id       TEXT NOT NULL,
                step_index    INTEGER NOT NULL,
                step_name     TEXT NOT NULL DEFAULT '',
                agent_name    TEXT NOT NULL DEFAULT '',
                status        TEXT NOT NULL DEFAULT 'pending',
                output        TEXT,
                handover_data TEXT,
                pm_notes      TEXT,
                qa_verdict    TEXT,
                qa_reason     TEXT,
                retry_count   INTEGER DEFAULT 0,
                started_at    TEXT,
                finished_at   TEXT
            );
            CREATE TABLE IF NOT EXISTS pipeline_turns (
                id             TEXT PRIMARY KEY,
                run_id         TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                turn_index     INTEGER NOT NULL,
                agent_id       TEXT,
                agent_name     TEXT NOT NULL DEFAULT '',
                action         TEXT NOT NULL,
                instructions   TEXT,
                reasoning      TEXT,
                output         TEXT,
                workspace_diff TEXT,
                verify_status  TEXT,
                superseded_by  INTEGER,
                status         TEXT NOT NULL DEFAULT 'pending',
                started_at     TEXT,
                finished_at    TEXT
            );
            CREATE TABLE IF NOT EXISTS code_sessions (
                id          TEXT PRIMARY KEY DEFAULT 'default',
                root_path   TEXT NOT NULL DEFAULT '',
                open_files  TEXT DEFAULT '[]',
                active_file TEXT,
                updated_at  TEXT
            );
            INSERT OR IGNORE INTO code_sessions (id) VALUES ('default');
            CREATE TABLE IF NOT EXISTS code_layouts (
                name        TEXT PRIMARY KEY,
                panes_json  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS code_layout_state (
                id                     TEXT PRIMARY KEY DEFAULT 'default',
                current_layout_name    TEXT,
                panes_json             TEXT NOT NULL DEFAULT '[]',
                preferred_widths_json  TEXT NOT NULL DEFAULT '{}',
                updated_at             TEXT
            );
            INSERT OR IGNORE INTO code_layout_state (id) VALUES ('default');
            CREATE TABLE IF NOT EXISTS jobs (
                id            TEXT PRIMARY KEY,
                pipeline_id   TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'queued',
                output_log    TEXT NOT NULL DEFAULT '',
                error         TEXT,
                created_at    TEXT,
                started_at    TEXT,
                finished_at   TEXT
            );
            CREATE TABLE IF NOT EXISTS network_hosts (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                ip          TEXT NOT NULL,
                mac         TEXT,
                ollama_port INTEGER NOT NULL DEFAULT 11434,
                priority    INTEGER NOT NULL,
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT
            );
        ''')
        db.execute('UPDATE code_sessions SET root_path=? WHERE id=?', (_config['root_path'], 'default'))
        # Migrations for existing databases
        for sql in [
            'ALTER TABLE agents DROP COLUMN file_access',
            'ALTER TABLE agents DROP COLUMN web_access',
            'ALTER TABLE agents ADD COLUMN tools       TEXT',
            'ALTER TABLE threads ADD COLUMN tools      TEXT',
            'ALTER TABLE pipeline_steps ADD COLUMN pass_full_output INTEGER DEFAULT 0',
            'ALTER TABLE pipeline_steps ADD COLUMN agent_input TEXT DEFAULT ""',
            'ALTER TABLE pipeline_steps ADD COLUMN model_tier TEXT DEFAULT "local"',
            'ALTER TABLE pipeline_steps ADD COLUMN loop_config TEXT DEFAULT "{}"',
            'ALTER TABLE jobs ADD COLUMN parent_job_id TEXT',
            'ALTER TABLE jobs ADD COLUMN loop_depth INTEGER DEFAULT 0',
            'ALTER TABLE pipeline_step_runs ADD COLUMN iteration INTEGER DEFAULT 0',
            'ALTER TABLE pipelines ADD COLUMN feedback_loop INTEGER DEFAULT 1',
            'ALTER TABLE jobs ADD COLUMN feedback TEXT DEFAULT ""',
            'ALTER TABLE jobs ADD COLUMN feedback_of_run TEXT',
            'ALTER TABLE pipeline_runs ADD COLUMN user_feedback TEXT DEFAULT ""',
            'ALTER TABLE pipeline_runs ADD COLUMN parent_run_id TEXT',
            'ALTER TABLE network_hosts ADD COLUMN os       TEXT',
            'ALTER TABLE network_hosts ADD COLUMN gpu_arch TEXT',
            "ALTER TABLE network_hosts ADD COLUMN ssh_user TEXT NOT NULL DEFAULT 'viktor'",
            "ALTER TABLE network_hosts ADD COLUMN capacity TEXT NOT NULL DEFAULT 'full'",
            "ALTER TABLE agents ADD COLUMN fallback_model TEXT DEFAULT ''",
            'ALTER TABLE agents ADD COLUMN role            TEXT',
            'ALTER TABLE agents ADD COLUMN agent_goal      TEXT',
            'ALTER TABLE agents ADD COLUMN expected_output TEXT',
            "ALTER TABLE pipelines ADD COLUMN mode           TEXT NOT NULL DEFAULT 'fixed'",
            "ALTER TABLE pipelines ADD COLUMN roster         TEXT NOT NULL DEFAULT '[]'",
            'ALTER TABLE pipelines ADD COLUMN verify_command TEXT',
            'ALTER TABLE pipelines ADD COLUMN max_turns      INTEGER NOT NULL DEFAULT 20',
            'ALTER TABLE pipelines ADD COLUMN work_dir       TEXT',
        ]:
            try:
                db.execute(sql)
            except Exception:
                pass

        # One-time backfill: atlantis/self predates the capacity concept and
        # is the one host known to be meaningfully weaker than .205/.251 —
        # safe to run unconditionally every startup (idempotent).
        db.execute("UPDATE network_hosts SET capacity='limited' WHERE id='host-240'")

        # Seed default hosts on first run — matches the legacy
        # DEFAULT_OLLAMA_ENDPOINT fallback order (205 -> 251 -> 240).
        count = db.execute('SELECT COUNT(*) c FROM network_hosts').fetchone()['c']
        if count == 0:
            now = datetime.datetime.now().isoformat()
            seeds = [
                ('host-205', 'Host .205',       '192.168.1.205', 1, 'full'),
                ('host-251', 'Host .251',       '192.168.1.251', 2, 'full'),
                ('host-240', 'Atlantis / self', '192.168.1.240', 3, 'limited'),
            ]
            for hid, name, ip, priority, capacity in seeds:
                db.execute(
                    'INSERT INTO network_hosts (id,name,ip,mac,ollama_port,priority,enabled,created_at,capacity) '
                    'VALUES (?,?,?,?,?,?,?,?,?)',
                    (hid, name, ip, None, 11434, priority, 1, now, capacity)
                )

# ── DB helpers ─────────────────────────────────────────────────────────────────

def row_to_dict(row):
    return dict(row) if row else None

def rows_to_list(rows):
    return [dict(r) for r in rows]

def regenerate_ollama_endpoint_setting(db):
    """Rebuild settings.endpoint from network_hosts (enabled rows, ordered
    by priority), always appending localhost last as the final fallback.
    resolve_ollama_endpoint() consumes this value unchanged — see its
    docstring at the top of this file."""
    rows = db.execute(
        'SELECT ip, ollama_port FROM network_hosts WHERE enabled=1 ORDER BY priority'
    ).fetchall()
    candidates = [f"http://{r['ip']}:{r['ollama_port']}" for r in rows]
    candidates.append('http://localhost:11434')
    db.execute('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
               ('endpoint', json.dumps(','.join(candidates))))

HOST_OS_VALUES  = {'macos', 'linux', 'windows'}
HOST_GPU_VALUES = {'nvidia', 'apple_silicon', 'amd', 'cpu_only'}
HOST_CAPACITY_VALUES = {'full', 'limited'}

def ping_host(ip):
    try:
        result = subprocess.run(['ping', '-c', '1', ip],
                                 capture_output=True, timeout=1.5)
        return result.returncode == 0
    except Exception:
        return False

def check_ollama(ip, port):
    try:
        with urllib.request.urlopen(f'http://{ip}:{port}/api/tags', timeout=1.5) as resp:
            data = json.loads(resp.read())
            return True, len(data.get('models', []))
    except Exception:
        return False, 0

def check_host_status(ip, port):
    online = ping_host(ip)
    ollama_running, model_count = check_ollama(ip, port) if online else (False, 0)
    return {'online': online, 'ollamaRunning': ollama_running, 'modelCount': model_count}

def check_ssh_access(ip, ssh_user):
    """Real key-based auth check, not just a port-22 probe. BatchMode=yes
    makes ssh fail immediately instead of prompting for a password when key
    auth isn't set up. StrictHostKeyChecking=accept-new is a deliberate
    trust-on-first-use tradeoff for hosts on the user's own LAN — without
    it, a host never SSH'd to before would report "failed" purely because
    its key isn't in known_hosts yet, not because access is actually
    broken. The outer timeout=5 is a backstop in case ssh hangs despite
    ConnectTimeout, same defensive pattern as ping_host."""
    try:
        result = subprocess.run(
            ['ssh', '-o', 'BatchMode=yes',
             '-o', 'StrictHostKeyChecking=accept-new',
             '-o', 'ConnectTimeout=2',
             f'{ssh_user}@{ip}', 'echo', 'ok'],
            capture_output=True, timeout=5, text=True
        )
        if result.returncode == 0:
            return True, None
        return False, (result.stderr or result.stdout or 'ssh exited non-zero').strip()[:300]
    except Exception as e:
        return False, str(e)

_LOCAL_IPS_CACHE = None

def local_ips():
    """IPs (plus localhost aliases) that resolve to this machine, so a
    network_hosts entry pointing at ourselves can be probed directly
    instead of over SSH — self-SSH is rarely set up for passwordless
    BatchMode auth. UDP connect to a public IP doesn't send any packets;
    it's just a portable way to ask the OS which interface/IP would be
    used for outbound traffic, which catches the LAN IP that
    gethostbyname(gethostname()) can miss (e.g. Debian/Ubuntu's
    127.0.1.1 hosts-file quirk)."""
    global _LOCAL_IPS_CACHE
    if _LOCAL_IPS_CACHE is None:
        ips = {'127.0.0.1', 'localhost', '::1'}
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ips.add(info[4][0])
        except Exception:
            pass
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(('8.8.8.8', 80))
                ips.add(s.getsockname()[0])
        except Exception:
            pass
        _LOCAL_IPS_CACHE = ips
    return _LOCAL_IPS_CACHE

def probe_host_sysinfo(ip, ssh_user, os_, gpu_arch):
    """Remote equivalent of _models_sysinfo's local probe, run over SSH.
    Mirrors the same sysctl/proc-meminfo/nvidia-smi commands but targets
    a specific network host instead of the machine server.py runs on,
    selecting commands by the host's stored os/gpu_arch fields (there's
    no way to introspect a remote machine's platform without a command
    round-trip first, so the DB fields are trusted). Returns
    {'ram_gb', 'vram_gb', 'live'}; live=False on any failure or when
    os is unsupported (windows, or NULL) — same BatchMode/StrictHostKeyChecking/
    ConnectTimeout flags as check_ssh_access, so a host that fails the
    Hosts-tab SSH check will also correctly report live=False here.
    RAM and VRAM are probed as two independent ssh calls on Linux+nvidia
    hosts (rather than one semicolon-chained command) so a failed
    nvidia-smi — missing binary, wrong GPU, driver issue — degrades to a
    real RAM number with vram_gb=0 instead of discarding a successful RAM
    read just because the last command in a shell chain failed."""
    if os_ == 'macos':
        ram_cmd = 'sysctl -n hw.memsize'
    elif os_ == 'linux':
        ram_cmd = 'cat /proc/meminfo | grep MemTotal'
    else:
        return {'ram_gb': 0.0, 'vram_gb': 0.0, 'live': False}
    ssh_base = ['ssh', '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-o', 'ConnectTimeout=2', f'{ssh_user}@{ip}']
    try:
        result = subprocess.run(ssh_base + [ram_cmd], capture_output=True, timeout=6, text=True)
        if result.returncode != 0:
            return {'ram_gb': 0.0, 'vram_gb': 0.0, 'live': False}
        line = result.stdout.strip()
        if not line:
            return {'ram_gb': 0.0, 'vram_gb': 0.0, 'live': False}
        if os_ == 'macos':
            ram_gb = int(line) / 1e9
            vram_gb = ram_gb if gpu_arch == 'apple_silicon' else 0.0
        else:
            ram_gb = int(line.split()[1]) * 1024 / 1e9
            vram_gb = 0.0
            if gpu_arch == 'nvidia':
                try:
                    vram_result = subprocess.run(
                        ssh_base + ['nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits'],
                        capture_output=True, timeout=6, text=True
                    )
                    if vram_result.returncode == 0 and vram_result.stdout.strip():
                        vram_gb = sum(float(x) for x in vram_result.stdout.split()) * 1024**2 / 1e9
                except Exception:
                    pass
        return {'ram_gb': round(ram_gb, 1), 'vram_gb': round(vram_gb, 1), 'live': True}
    except Exception:
        return {'ram_gb': 0.0, 'vram_gb': 0.0, 'live': False}

def send_wol_packet(mac):
    mac_bytes = bytes.fromhex(mac.replace(':', '').replace('-', ''))
    if len(mac_bytes) != 6:
        raise ValueError('MAC address must be 6 bytes')
    packet = b'\xff' * 6 + mac_bytes * 16
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.sendto(packet, ('255.255.255.255', 9))
    finally:
        sock.close()

_MAC_RE = re.compile(r'([0-9a-f]{2}:){5}[0-9a-f]{2}')

def _mac_fetch_cmd(ip, os_):
    """Shell one-liner that finds the MAC of whichever interface owns `ip`
    (not just "first non-loopback"), since that's the NIC Wake-on-LAN needs
    to target. `ip` is shlex-quoted before embedding because for the remote
    path this string is shipped to a remote shell over ssh to interpret."""
    q = shlex.quote(ip)
    if os_ == 'macos':
        return (f'ifconfig | awk -v ip={q} '
                '\'/^[^ \\t]/{ether=""} /ether /{ether=$2} '
                '$1=="inet" && $2==ip{print ether}\'')
    if os_ == 'linux':
        return (f'ip -o addr show | awk -v ip={q} '
                '\'{n=split($4,a,"/"); if($3=="inet" && a[1]==ip) print $2}\' '
                '| xargs -r -I{} cat /sys/class/net/{}/address')
    return None

def fetch_mac(ip, ssh_user, os_):
    """Best-effort MAC discovery for a network_hosts row, run locally
    (no ssh) if `ip` is this machine, otherwise over ssh — same
    BatchMode/StrictHostKeyChecking/ConnectTimeout flags as check_ssh_access,
    so a host that can't be reached/authorized just yields None instead of
    raising. Result is validated against a strict MAC regex before being
    trusted, since garbage/empty command output must never get saved."""
    cmd = _mac_fetch_cmd(ip, os_)
    if not cmd:
        return None
    try:
        if ip in local_ips():
            result = subprocess.run(['sh', '-c', cmd], capture_output=True, timeout=5, text=True)
        else:
            result = subprocess.run(
                ['ssh', '-o', 'BatchMode=yes',
                 '-o', 'StrictHostKeyChecking=accept-new',
                 '-o', 'ConnectTimeout=2',
                 f'{ssh_user}@{ip}', cmd],
                capture_output=True, timeout=6, text=True)
        mac = result.stdout.strip().lower()
        if result.returncode == 0 and _MAC_RE.fullmatch(mac):
            return mac
    except Exception:
        pass
    return None

# ── Schedule logic ─────────────────────────────────────────────────────────────

def is_due(schedule: dict, now: datetime.datetime, last_run: datetime.datetime | None) -> bool:
    t = schedule.get('type', 'manual')
    if t == 'manual':
        return False
    try:
        sh, sm = map(int, schedule.get('time', '09:00').split(':'))
    except Exception:
        return False
    if now.hour != sh or now.minute != sm:
        return False

    if t == 'daily':
        return not (last_run and last_run.date() == now.date())

    if t == 'weekly':
        js_day = (now.weekday() + 1) % 7
        if js_day != schedule.get('day', 1):
            return False
        if last_run and last_run.isocalendar()[:2] == now.isocalendar()[:2]:
            return False
        return True

    if t == 'monthly':
        if now.day != schedule.get('monthDay', 1):
            return False
        return not (last_run and last_run.month == now.month and last_run.year == now.year)

    if t == 'custom':
        return _cron_matches(schedule.get('cron', ''), now, last_run)

    return False


def _cron_field(field: str, value: int) -> bool:
    if field == '*':
        return True
    if field.startswith('*/'):
        try:
            return value % int(field[2:]) == 0
        except Exception:
            return False
    try:
        return int(field) == value
    except Exception:
        return False


def _cron_matches(expr: str, now: datetime.datetime, last_run: datetime.datetime | None) -> bool:
    parts = expr.strip().split()
    if len(parts) != 5:
        return False
    min_f, hour_f, dom_f, mon_f, dow_f = parts
    js_dow = (now.weekday() + 1) % 7
    if not (_cron_field(min_f, now.minute) and _cron_field(hour_f, now.hour)
            and _cron_field(dom_f, now.day) and _cron_field(mon_f, now.month)
            and _cron_field(dow_f, js_dow)):
        return False
    return not (last_run and last_run.replace(second=0, microsecond=0) == now.replace(second=0, microsecond=0))


# ── Ollama ─────────────────────────────────────────────────────────────────────

def resolve_template(template: str, now: datetime.datetime) -> str:
    return (template
            .replace('{{date}}',     now.strftime('%Y-%m-%d'))
            .replace('{{time}}',     now.strftime('%H:%M'))
            .replace('{{datetime}}', now.strftime('%Y-%m-%d %H:%M')))


def ollama_chat(model: str, messages: list, timeout: int = 300) -> dict:
    payload = json.dumps({'model': model, 'messages': messages, 'stream': False}).encode()
    req = urllib.request.Request(
        f'{resolve_ollama_endpoint()}/api/chat',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        return {
            'output': data.get('message', {}).get('content', ''),
            'tokens': data.get('eval_count', 0),
            'error':  None,
        }
    except Exception as e:
        return {'output': '', 'tokens': 0, 'error': str(e)}


# ── Scheduler ──────────────────────────────────────────────────────────────────

def scheduler_loop():
    print('[scheduler] Started')
    while True:
        now = datetime.datetime.now()
        time.sleep(60 - now.second + 0.5)
        now = datetime.datetime.now()
        try:
          _scheduler_tick(now)
        except Exception as e:
            print(f'[scheduler] tick error (will retry next minute): {e}')

def _scheduler_tick(now):
    with get_db() as db:
        tasks = rows_to_list(db.execute('SELECT * FROM tasks').fetchall())

    for task in tasks:
        schedule = json.loads(task.get('schedule') or '{}')
        with get_db() as db:
            last_row = db.execute(
                'SELECT started_at FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1',
                (task['id'],)
            ).fetchone()
        last_run = None
        if last_row:
            try:
                last_run = datetime.datetime.fromisoformat(last_row['started_at'])
            except Exception:
                pass

        if not is_due(schedule, now, last_run):
            continue

        name = task.get('name', task.get('id', '?'))
        print(f'[scheduler] Running: {name}')

        prompt = resolve_template(task.get('prompt_template', ''), now)
        model  = task.get('model', '')
        msgs   = []

        with get_db() as db:
            raw = db.execute("SELECT value FROM settings WHERE key='agentPrePrompt'").fetchone()
        agent_pre = (json.loads(raw['value']) if raw else '').strip()

        if task.get('agent_id'):
            with get_db() as db:
                agent = row_to_dict(db.execute(
                    'SELECT * FROM agents WHERE id=?', (task['agent_id'],)
                ).fetchone())
            sys_parts = [p for p in [agent_pre, (agent or {}).get('system_prompt', '').strip()] if p]
            if sys_parts:
                msgs.append({'role': 'system', 'content': '\n\n'.join(sys_parts)})
            if agent and not model:
                model = agent.get('model', '')
        elif agent_pre:
            msgs.append({'role': 'system', 'content': agent_pre})

        msgs.append({'role': 'user', 'content': prompt})
        result = ollama_chat(model, msgs)
        status = 'error' if result['error'] else 'ok'
        print(f'[scheduler] {name} → {status}')

        run_id = str(time.time_ns())
        with get_db() as db:
            db.execute(
                'INSERT INTO task_runs (id,task_id,started_at,finished_at,output,tokens,error) VALUES (?,?,?,?,?,?,?)',
                (run_id, task['id'], now.isoformat(), datetime.datetime.now().isoformat(),
                 result['output'], result['tokens'], result['error'])
            )
            # Keep last 50 runs per task
            db.execute('''
                DELETE FROM task_runs WHERE task_id=? AND id NOT IN (
                    SELECT id FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 50
                )
            ''', (task['id'], task['id']))


# ── HTTP handler ───────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self):
        p = self.path.split('?')[0]
        if   p == '/api/settings':          self._get_settings()
        elif p == '/api/agents':            self._get_agents()
        elif p == '/api/hosts':             self._get_hosts()
        elif p == '/api/threads':           self._get_threads()
        elif p.startswith('/api/threads/') and p.endswith('/messages'):
            self._get_messages(p.split('/')[3])
        elif p == '/api/tasks':             self._get_tasks()
        elif p.startswith('/api/tasks/') and p.endswith('/runs'):
            self._get_runs(p.split('/')[3])
        elif p.startswith('/api/activity'):  self._get_activity()
        elif p == '/api/brain/status':      self._get_brain_status()
        elif p == '/api/export':            self._export()
        elif p == '/api/plans':             self._get_plans()
        elif p.startswith('/api/plans/'):   self._get_plan(p)
        elif p.startswith('/api/project/files'):
            self._project_files_get(p)
        elif p == '/api/web/search':        self._web_search()
        elif p == '/api/web/fetch':         self._web_fetch()
        elif p == '/api/models/local':      self._models_local()
        elif p == '/api/models/sysinfo':    self._models_sysinfo()
        elif p == '/api/models/search':     self._models_search()
        elif p == '/api/models/tags':       self._models_tags()
        elif p == '/api/pipelines':          self._get_pipelines()
        elif p.startswith('/api/pipelines/') and p.endswith('/steps'):
            self._get_pipeline_steps(p.split('/')[3])
        elif p.startswith('/api/pipelines/') and p.endswith('/runs'):
            self._get_pipeline_runs(p.split('/')[3])
        elif p == '/api/pipeline-runs/recent':
            self._get_recent_pipeline_runs()
        elif p.startswith('/api/pipeline-runs/'):
            self._get_pipeline_run(p.split('/')[3])
        elif p.startswith('/api/pipelines/'):
            self._get_pipeline(p.split('/')[3])
        elif p == '/api/jobs':              self._list_jobs()
        elif p.startswith('/api/jobs/') and p.endswith('/stream'):
            self._stream_job_sse(p.split('/')[3])
        elif p.startswith('/api/jobs/'):
            self._get_job(p.split('/')[3])
        elif p == '/api/debug/status':      self._get_debug_status()
        elif p == '/api/fs':                self._fs_list()
        elif p == '/api/fs/read':           self._fs_read()
        elif p == '/api/code-session':      self._get_code_session()
        elif p == '/api/code-layouts':      self._get_code_layouts()
        elif p == '/api/code-layout-state': self._get_code_layout_state()
        else:
            super().do_GET()

    def do_POST(self):
        p = self.path.split('?')[0]
        body = self._read_body()
        if   p == '/api/settings':          self._post_settings(body)
        elif p == '/api/agents':            self._post_agent(body)
        elif p == '/api/hosts':             self._post_host(body)
        elif p == '/api/hosts/reorder':     self._reorder_hosts(body)
        elif p == '/api/hosts/check':       self._check_hosts()
        elif p.startswith('/api/hosts/') and p.endswith('/wake'):
            self._wake_host(p.split('/')[3])
        elif p.startswith('/api/hosts/') and p.endswith('/check-ssh'):
            self._check_ssh(p.split('/')[3])
        elif p == '/api/threads':           self._post_thread(body)
        elif p.startswith('/api/threads/') and p.endswith('/messages'):
            self._post_messages(p.split('/')[3], body)
        elif p == '/api/tasks':             self._post_task(body)
        elif p.startswith('/api/tasks/') and p.endswith('/runs'):
            self._post_run(p.split('/')[3], body)
        elif p == '/api/import':            self._import(body)
        elif p.startswith('/api/plans/'):   self._post_plan(p, body)
        elif p.startswith('/api/project/files/'):
            self._project_files_post(p, body)
        elif p == '/api/pipelines':          self._post_pipeline(body)
        elif p.startswith('/api/pipelines/') and p.endswith('/steps'):
            self._post_pipeline_step(p.split('/')[3], body)
        elif p.startswith('/api/pipelines/') and p.endswith('/run'):
            self._enqueue_pipeline_run(p.split('/')[3])
        elif p.startswith('/api/pipeline-runs/') and p.endswith('/feedback'):
            self._post_run_feedback(p.split('/')[3], body)
        elif p.startswith('/api/pipeline-runs/') and p.endswith('/approve'):
            self._approve_run(p.split('/')[3])
        elif p.startswith('/api/jobs/') and p.endswith('/cancel'):
            self._cancel_job(p.split('/')[3])
        elif p == '/api/models/pull':       self._models_pull(body)
        elif p == '/api/fs/write':          self._fs_write(body)
        elif p == '/api/fs/mkdir':          self._fs_mkdir(body)
        elif p == '/api/fs/rename':         self._fs_rename(body)
        elif p == '/api/code-layouts':      self._post_code_layout(body)
        elif p == '/api/tools/exec':        self._tools_exec(body)
        elif p == '/api/code/ghost-text':    self._code_ghost_text(body)
        elif p == '/api/debug/restart':     self._restart_worker()
        elif p == '/api/system/update':     self._post_system_update(body)
        elif p == '/api/system/restart':    self._post_system_restart()
        elif p == '/api/system/stop':       self._post_system_stop()
        else:
            self.send_error(404)

    def do_PUT(self):
        p = self.path.split('?')[0]
        body = self._read_body()
        if p.startswith('/api/agents/'):
            self._put_agent(p.split('/')[3], body)
        elif p.startswith('/api/hosts/'):
            self._put_host(p.split('/')[3], body)
        elif p.startswith('/api/threads/') and not p.endswith('/messages'):
            self._put_thread(p.split('/')[3], body)
        elif p.startswith('/api/tasks/') and not p.endswith('/runs'):
            self._put_task(p.split('/')[3], body)
        elif p.startswith('/api/pipelines/') and '/steps/' in p:
            parts = p.split('/')   # ['','api','pipelines',pid,'steps',sid]
            self._put_pipeline_step(parts[3], parts[5], body)
        elif p.startswith('/api/pipelines/'):
            self._put_pipeline(p.split('/')[3], body)
        elif p == '/api/code-session':      self._put_code_session(body)
        elif p == '/api/code-layout-state': self._put_code_layout_state(body)
        else:
            self.send_error(404)

    def do_DELETE(self):
        p = self.path.split('?')[0]
        if   p == '/api/data':              self._clear_data()
        elif p.startswith('/api/code-layouts/'):
            self._delete_code_layout(urllib.parse.unquote(p.split('/')[3]))
        elif p.startswith('/api/agents/'):  self._delete_agent(p.split('/')[3])
        elif p.startswith('/api/hosts/'):   self._delete_host(p.split('/')[3])
        elif p.startswith('/api/threads/') and p.endswith('/messages'):
            self._delete_messages(p.split('/')[3])
        elif p.startswith('/api/threads/'): self._delete_thread(p.split('/')[3])
        elif p.startswith('/api/tasks/'):   self._delete_task(p.split('/')[3])
        elif p.startswith('/api/plans/'):   self._delete_plan(p)
        elif p.startswith('/api/pipelines/') and '/steps/' in p:
            parts = p.split('/')
            self._delete_pipeline_step(parts[3], parts[5])
        elif p.startswith('/api/pipelines/') and p.endswith('/runs'):
            self._delete_all_pipeline_runs(p.split('/')[3])
        elif p.startswith('/api/pipeline-runs/'):
            self._delete_pipeline_run(p.split('/')[3])
        elif p.startswith('/api/pipelines/'): self._delete_pipeline(p.split('/')[3])
        elif p == '/api/jobs':
            qs = urllib.parse.parse_qs(self.path.split('?', 1)[1]) if '?' in self.path else {}
            pid = (qs.get('pipeline_id') or [None])[0]
            if pid: self._delete_all_jobs(pid)
            else:   self.send_error(400)
        elif p.startswith('/api/jobs/'):    self._delete_job(p.split('/')[3])
        elif p == '/api/models':            self._models_delete()
        elif p == '/api/fs':                self._fs_delete()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    # ── Settings ────────────────────────────────────────────────────────────

    def _get_settings(self):
        with get_db() as db:
            rows = db.execute('SELECT key, value FROM settings').fetchall()
        out = {}
        for r in rows:
            try:
                out[r['key']] = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                out[r['key']] = r['value']
        self._json(out)

    def _post_settings(self, body):
        with get_db() as db:
            for k, v in body.items():
                db.execute('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
                           (k, json.dumps(v)))
        self._json({'ok': True})

    # ── Agents ──────────────────────────────────────────────────────────────

    def _get_agents(self):
        with get_db() as db:
            rows = rows_to_list(db.execute('SELECT * FROM agents').fetchall())
        self._json([self._agent_out(r) for r in rows])

    def _post_agent(self, body):
        tools = json.dumps(body.get('tools') or {})
        with get_db() as db:
            db.execute(
                'INSERT INTO agents (id,name,model,system_prompt,temperature,top_p,context_len,tools,fallback_model,role,agent_goal,expected_output) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (body['id'], body['name'], body.get('model',''), body.get('systemPrompt',''),
                 body.get('temperature',0.7), body.get('topP',0.9), body.get('contextLen',4096), tools,
                 body.get('fallbackModel',''), body.get('role',''), body.get('agentGoal',''),
                 body.get('expectedOutput',''))
            )
        self._json({'ok': True})

    def _put_agent(self, id, body):
        tools = json.dumps(body.get('tools') or {})
        with get_db() as db:
            db.execute(
                'UPDATE agents SET name=?,model=?,system_prompt=?,temperature=?,top_p=?,context_len=?,tools=?,fallback_model=?,role=?,agent_goal=?,expected_output=? WHERE id=?',
                (body.get('name',''), body.get('model',''), body.get('systemPrompt',''),
                 body.get('temperature',0.7), body.get('topP',0.9), body.get('contextLen',4096), tools,
                 body.get('fallbackModel',''), body.get('role',''), body.get('agentGoal',''),
                 body.get('expectedOutput',''), id)
            )
        self._json({'ok': True})

    def _delete_agent(self, id):
        with get_db() as db:
            db.execute('DELETE FROM agents WHERE id=?', (id,))
        self._json({'ok': True})

    def _agent_out(self, row):
        tools = {}
        try:
            tools = json.loads(row['tools'] or '{}')
        except Exception:
            pass
        return {
            'id': row['id'], 'name': row['name'], 'model': row['model'],
            'systemPrompt': row['system_prompt'], 'temperature': row['temperature'],
            'topP': row['top_p'], 'contextLen': row['context_len'],
            'tools': tools, 'fallbackModel': row['fallback_model'] or '',
            'role': row['role'] or '', 'agentGoal': row['agent_goal'] or '',
            'expectedOutput': row['expected_output'] or '',
        }

    # ── Network hosts ──────────────────────────────────────────────────────

    def _host_out(self, row):
        return {
            'id': row['id'], 'name': row['name'], 'ip': row['ip'],
            'mac': row['mac'], 'ollamaPort': row['ollama_port'],
            'priority': row['priority'], 'enabled': bool(row['enabled']),
            'os': row['os'], 'gpuArch': row['gpu_arch'], 'sshUser': row['ssh_user'],
            'capacity': row['capacity'],
        }

    def _get_hosts(self):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT * FROM network_hosts ORDER BY priority'
            ).fetchall())
        self._json([self._host_out(r) for r in rows])

    def _post_host(self, body):
        name = (body.get('name') or '').strip()
        ip   = (body.get('ip') or '').strip()
        os_  = (body.get('os') or '').strip() or None
        gpu  = (body.get('gpuArch') or '').strip() or None
        cap  = (body.get('capacity') or 'full').strip()
        if not name or not ip or not body.get('id'):
            return self.send_error(400)
        if ip.startswith('-') or (body.get('sshUser') or '').strip().startswith('-'):
            return self.send_error(400)
        if os_ and os_ not in HOST_OS_VALUES:
            return self.send_error(400)
        if gpu and gpu not in HOST_GPU_VALUES:
            return self.send_error(400)
        if cap not in HOST_CAPACITY_VALUES:
            return self.send_error(400)
        with get_db() as db:
            max_row = db.execute('SELECT MAX(priority) m FROM network_hosts').fetchone()
            priority = (max_row['m'] or 0) + 1
            now = datetime.datetime.now().isoformat()
            db.execute(
                'INSERT INTO network_hosts (id,name,ip,mac,ollama_port,priority,enabled,created_at,os,gpu_arch,ssh_user,capacity) '
                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (body['id'], name, ip, (body.get('mac') or '').strip() or None,
                 int(body.get('ollamaPort') or 11434), priority, 1, now,
                 os_, gpu, (body.get('sshUser') or 'viktor').strip(), cap)
            )
            regenerate_ollama_endpoint_setting(db)
        self._json({'ok': True})

    def _put_host(self, id, body):
        name = (body.get('name') or '').strip()
        ip   = (body.get('ip') or '').strip()
        os_  = (body.get('os') or '').strip() or None
        gpu  = (body.get('gpuArch') or '').strip() or None
        cap  = (body.get('capacity') or 'full').strip()
        if not name or not ip:
            return self.send_error(400)
        if ip.startswith('-') or (body.get('sshUser') or '').strip().startswith('-'):
            return self.send_error(400)
        if os_ and os_ not in HOST_OS_VALUES:
            return self.send_error(400)
        if gpu and gpu not in HOST_GPU_VALUES:
            return self.send_error(400)
        if cap not in HOST_CAPACITY_VALUES:
            return self.send_error(400)
        with get_db() as db:
            db.execute(
                'UPDATE network_hosts SET name=?, ip=?, mac=?, ollama_port=?, enabled=?, os=?, gpu_arch=?, ssh_user=?, capacity=? WHERE id=?',
                (name, ip, (body.get('mac') or '').strip() or None,
                 int(body.get('ollamaPort') or 11434),
                 1 if body.get('enabled', True) else 0,
                 os_, gpu, (body.get('sshUser') or 'viktor').strip(), cap, id)
            )
            regenerate_ollama_endpoint_setting(db)
        self._json({'ok': True})

    def _delete_host(self, id):
        with get_db() as db:
            db.execute('DELETE FROM network_hosts WHERE id=?', (id,))
            regenerate_ollama_endpoint_setting(db)
        self._json({'ok': True})

    def _reorder_hosts(self, body):
        order = body.get('order') or []
        with get_db() as db:
            for i, hid in enumerate(order, start=1):
                db.execute('UPDATE network_hosts SET priority=? WHERE id=?', (i, hid))
            regenerate_ollama_endpoint_setting(db)
        self._json({'ok': True})

    def _check_hosts(self):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT id, ip, ollama_port, mac, ssh_user, os FROM network_hosts'
            ).fetchall())
        results = {}
        if rows:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(rows)) as pool:
                futures = {pool.submit(check_host_status, r['ip'], r['ollama_port']): r['id']
                           for r in rows}
                for fut in concurrent.futures.as_completed(futures):
                    results[futures[fut]] = fut.result()

        # MAC auto-fill: only attempt for hosts still missing one, and only
        # over ssh if the ping check above already found them online — skips
        # wasted ssh handshakes against hosts that are down.
        to_fetch = [r for r in rows if not r['mac'] and
                    (r['ip'] in local_ips() or results.get(r['id'], {}).get('online'))]
        if to_fetch:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(to_fetch)) as pool:
                futures = {pool.submit(fetch_mac, r['ip'], r['ssh_user'], r['os']): r['id']
                           for r in to_fetch}
                fetched = {futures[fut]: fut.result() for fut in concurrent.futures.as_completed(futures)}
            found = {hid: mac for hid, mac in fetched.items() if mac}
            if found:
                with get_db() as db:
                    for hid, mac in found.items():
                        db.execute('UPDATE network_hosts SET mac=? WHERE id=?', (mac, hid))
                for hid, mac in found.items():
                    results.setdefault(hid, {})['mac'] = mac
        self._json(results)

    def _wake_host(self, id):
        with get_db() as db:
            row = db.execute('SELECT mac FROM network_hosts WHERE id=?', (id,)).fetchone()
        if not row or not row['mac']:
            return self._json({'ok': False, 'error': 'No MAC address saved for this host'}, 400)
        try:
            send_wol_packet(row['mac'])
        except Exception as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        self._json({'ok': True})

    def _check_ssh(self, id):
        with get_db() as db:
            row = db.execute('SELECT ip, ssh_user, os, mac FROM network_hosts WHERE id=?', (id,)).fetchone()
        if not row:
            return self.send_error(404)
        ok, error = check_ssh_access(row['ip'], row['ssh_user'])
        mac = None
        if ok and not row['mac']:
            mac = fetch_mac(row['ip'], row['ssh_user'], row['os'])
            if mac:
                with get_db() as db:
                    db.execute('UPDATE network_hosts SET mac=? WHERE id=?', (mac, id))
        self._json({'ok': ok, 'error': error, 'mac': mac})

    # ── Threads ─────────────────────────────────────────────────────────────

    def _get_threads(self):
        with get_db() as db:
            threads = rows_to_list(db.execute(
                'SELECT * FROM threads ORDER BY updated_at DESC'
            ).fetchall())
            for t in threads:
                t['messages'] = rows_to_list(db.execute(
                    'SELECT * FROM messages WHERE thread_id=? ORDER BY created_at', (t['id'],)
                ).fetchall())
        self._json([self._thread_out(t) for t in threads])

    def _post_thread(self, body):
        now = datetime.datetime.now().isoformat()
        with get_db() as db:
            db.execute(
                'INSERT INTO threads (id,name,model,agent_id,system_prompt,updated_at) VALUES (?,?,?,?,?,?)',
                (body['id'], body.get('name','New chat'), body.get('model',''),
                 body.get('agentId'), body.get('systemPrompt',''), now)
            )
        self._json({'ok': True})

    def _put_thread(self, id, body):
        now   = datetime.datetime.now().isoformat()
        tools = json.dumps(body.get('tools') or {})
        with get_db() as db:
            db.execute(
                'UPDATE threads SET name=?,model=?,agent_id=?,system_prompt=?,tools=?,updated_at=? WHERE id=?',
                (body.get('name',''), body.get('model',''), body.get('agentId'),
                 body.get('systemPrompt',''), tools, now, id)
            )
        self._json({'ok': True})

    def _delete_thread(self, id):
        with get_db() as db:
            db.execute('DELETE FROM threads WHERE id=?', (id,))
        self._json({'ok': True})

    def _thread_out(self, t):
        tools = {}
        try:
            tools = json.loads(t.get('tools') or '{}')
        except Exception:
            pass
        return {
            'id': t['id'], 'name': t['name'], 'model': t['model'],
            'agentId': t['agent_id'], 'systemPrompt': t['system_prompt'],
            'tools': tools,
            'messages': [self._msg_out(m) for m in t.get('messages', [])],
        }

    # ── Messages ─────────────────────────────────────────────────────────────

    def _get_messages(self, thread_id):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT * FROM messages WHERE thread_id=? ORDER BY created_at', (thread_id,)
            ).fetchall())
        self._json([self._msg_out(r) for r in rows])

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

    def _delete_messages(self, thread_id):
        with get_db() as db:
            db.execute('DELETE FROM messages WHERE thread_id=?', (thread_id,))
            db.execute('UPDATE threads SET name=?,updated_at=? WHERE id=?',
                       ('New chat', datetime.datetime.now().isoformat(), thread_id))
        self._json({'ok': True})

    def _msg_out(self, m):
        meta = None
        if m.get('tokens'):
            meta = {'eval_count': m['tokens'], 'eval_duration': m.get('eval_duration')}
        return {
            'id': m['id'], 'role': m['role'], 'content': m['content'],
            'thinking': m.get('thinking'), 'meta': meta,
        }

    # ── Tasks ────────────────────────────────────────────────────────────────

    def _get_tasks(self):
        with get_db() as db:
            rows = rows_to_list(db.execute('SELECT * FROM tasks ORDER BY created_at DESC').fetchall())
        self._json([self._task_out(r) for r in rows])

    def _post_task(self, body):
        with get_db() as db:
            db.execute(
                'INSERT INTO tasks (id,name,model,agent_id,prompt_template,schedule,created_at) VALUES (?,?,?,?,?,?,?)',
                (body['id'], body.get('name',''), body.get('model',''), body.get('agentId'),
                 body.get('promptTemplate',''), json.dumps(body.get('schedule',{})),
                 datetime.datetime.now().isoformat())
            )
        self._json({'ok': True})

    def _put_task(self, id, body):
        with get_db() as db:
            db.execute(
                'UPDATE tasks SET name=?,model=?,agent_id=?,prompt_template=?,schedule=? WHERE id=?',
                (body.get('name',''), body.get('model',''), body.get('agentId'),
                 body.get('promptTemplate',''), json.dumps(body.get('schedule',{})), id)
            )
        self._json({'ok': True})

    def _delete_task(self, id):
        with get_db() as db:
            db.execute('DELETE FROM tasks WHERE id=?', (id,))
        self._json({'ok': True})

    def _task_out(self, row):
        return {
            'id': row['id'], 'name': row['name'], 'model': row['model'],
            'agentId': row['agent_id'], 'promptTemplate': row['prompt_template'],
            'schedule': json.loads(row['schedule'] or '{}'),
        }

    # ── Task runs ─────────────────────────────────────────────────────────────

    def _get_runs(self, task_id):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 50', (task_id,)
            ).fetchall())
        self._json([self._run_out(r) for r in rows])

    def _post_run(self, task_id, body):
        with get_db() as db:
            db.execute(
                'INSERT INTO task_runs (id,task_id,started_at,finished_at,output,tokens,error) VALUES (?,?,?,?,?,?,?)',
                (body.get('id', str(time.time_ns())), task_id,
                 body.get('startedAt'), body.get('finishedAt'),
                 body.get('output',''), body.get('tokenCount',0), body.get('error'))
            )
            db.execute('''
                DELETE FROM task_runs WHERE task_id=? AND id NOT IN (
                    SELECT id FROM task_runs WHERE task_id=? ORDER BY started_at DESC LIMIT 50
                )
            ''', (task_id, task_id))
        self._json({'ok': True})

    def _run_out(self, row):
        return {
            'id': row['id'], 'startedAt': row['started_at'], 'finishedAt': row['finished_at'],
            'output': row['output'], 'tokenCount': row['tokens'], 'error': row['error'],
        }

    # ── Activity feed ────────────────────────────────────────────────────────

    def _get_activity(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        params = dict(p.split('=') for p in qs.split('&') if '=' in p)
        days   = int(params.get('days', 7))
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
        with get_db() as db:
            rows = rows_to_list(db.execute('''
                SELECT tr.id, tr.task_id, tr.started_at, tr.finished_at,
                       tr.output, tr.tokens, tr.error, t.name AS task_name
                FROM task_runs tr
                JOIN tasks t ON t.id = tr.task_id
                WHERE tr.started_at >= ?
                ORDER BY tr.started_at DESC
                LIMIT 100
            ''', (cutoff,)).fetchall())
        self._json([{
            'id': r['id'], 'taskId': r['task_id'], 'taskName': r['task_name'],
            'startedAt': r['started_at'], 'finishedAt': r['finished_at'],
            'output': r['output'], 'tokens': r['tokens'], 'error': r['error'],
        } for r in rows])

    # ── Brain status ─────────────────────────────────────────────────────────

    def _get_brain_status(self):
        plans = sorted(p.name for p in PLANS_DIR.glob('*.md')) if PLANS_DIR.exists() else []
        with get_db() as db:
            agents = [self._agent_out(r) for r in db.execute('SELECT * FROM agents ORDER BY name').fetchall()]
            tasks  = [self._task_out(r)  for r in db.execute('SELECT * FROM tasks  ORDER BY name').fetchall()]
            thread_count = db.execute("SELECT COUNT(*) FROM threads WHERE name != '__brain__'").fetchone()[0]
            msg_count    = db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
            run_count    = db.execute('SELECT COUNT(*) FROM task_runs').fetchone()[0]
        project_files = self._dir_listing(PROJECTS_DIR)
        self._json({
            'agents': agents, 'tasks': tasks, 'plans': plans,
            'threadCount': thread_count, 'messageCount': msg_count, 'runCount': run_count,
            'projectFiles': project_files,
        })

    # ── Export / Import / Clear ──────────────────────────────────────────────

    def _export(self):
        with get_db() as db:
            settings = {r['key']: json.loads(r['value'])
                        for r in db.execute('SELECT * FROM settings').fetchall()}
            agents   = [self._agent_out(r) for r in db.execute('SELECT * FROM agents').fetchall()]
            threads_raw = rows_to_list(db.execute('SELECT * FROM threads ORDER BY updated_at DESC').fetchall())
            threads = []
            for t in threads_raw:
                t['messages'] = rows_to_list(db.execute(
                    'SELECT * FROM messages WHERE thread_id=? ORDER BY created_at', (t['id'],)
                ).fetchall())
                threads.append(self._thread_out(t))
            tasks_raw = rows_to_list(db.execute('SELECT * FROM tasks').fetchall())
            tasks = []
            for t in tasks_raw:
                runs = rows_to_list(db.execute(
                    'SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC', (t['id'],)
                ).fetchall())
                d = self._task_out(t)
                d['runs'] = [self._run_out(r) for r in runs]
                tasks.append(d)
        self._json({'settings': settings, 'agents': agents, 'threads': threads, 'tasks': tasks})

    def _import(self, body):
        with get_db() as db:
            if 'settings' in body:
                for k, v in body['settings'].items():
                    db.execute('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
                               (k, json.dumps(v)))
            if 'agents' in body:
                for a in body['agents']:
                    db.execute('INSERT OR REPLACE INTO agents (id,name,model,system_prompt,temperature,top_p,context_len) VALUES (?,?,?,?,?,?,?)',
                               (a['id'], a['name'], a.get('model',''), a.get('systemPrompt',''),
                                a.get('temperature',0.7), a.get('topP',0.9), a.get('contextLen',4096)))
            if 'threads' in body:
                for t in body['threads']:
                    db.execute('INSERT OR REPLACE INTO threads (id,name,model,agent_id,system_prompt,updated_at) VALUES (?,?,?,?,?,?)',
                               (t['id'], t.get('name',''), t.get('model',''), t.get('agentId'),
                                t.get('systemPrompt',''), datetime.datetime.now().isoformat()))
                    for m in t.get('messages', []):
                        db.execute('INSERT OR REPLACE INTO messages (id,thread_id,role,content,thinking,tokens,created_at) VALUES (?,?,?,?,?,?,?)',
                                   (m.get('id', str(time.time_ns())), t['id'], m['role'],
                                    m.get('content',''), m.get('thinking'),
                                    (m.get('meta') or {}).get('eval_count'), datetime.datetime.now().isoformat()))
            if 'tasks' in body:
                for t in body['tasks']:
                    db.execute('INSERT OR REPLACE INTO tasks (id,name,model,agent_id,prompt_template,schedule,created_at) VALUES (?,?,?,?,?,?,?)',
                               (t['id'], t.get('name',''), t.get('model',''), t.get('agentId'),
                                t.get('promptTemplate',''), json.dumps(t.get('schedule',{})),
                                datetime.datetime.now().isoformat()))
                    for r in t.get('runs', []):
                        db.execute('INSERT OR REPLACE INTO task_runs (id,task_id,started_at,finished_at,output,tokens,error) VALUES (?,?,?,?,?,?,?)',
                                   (r.get('id', str(time.time_ns())), t['id'],
                                    r.get('startedAt'), r.get('finishedAt'),
                                    r.get('output',''), r.get('tokenCount',0), r.get('error')))
        self._json({'ok': True})

    def _clear_data(self):
        with get_db() as db:
            db.executescript('DELETE FROM messages; DELETE FROM threads; DELETE FROM task_runs; DELETE FROM tasks; DELETE FROM agents; DELETE FROM settings;')
        self._json({'ok': True})

    # ── Plans ─────────────────────────────────────────────────────────────────

    def _get_plans(self):
        PLANS_DIR.mkdir(exist_ok=True)
        self._json(sorted(p.name for p in PLANS_DIR.glob('*.md') if not p.name.startswith('.')))

    def _get_plan(self, path):
        name = self._safe_plan_name(path)
        if not name: return self.send_error(400)
        f = PLANS_DIR / name
        if not f.exists(): return self.send_error(404)
        body = f.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _post_plan(self, path, body):
        name = self._safe_plan_name(path)
        if not name: return self.send_error(400)
        PLANS_DIR.mkdir(exist_ok=True)
        (PLANS_DIR / name).write_bytes(body if isinstance(body, bytes) else body.encode())
        self._json({'ok': True})

    def _delete_plan(self, path):
        name = self._safe_plan_name(path)
        if not name: return self.send_error(400)
        f = PLANS_DIR / name
        if f.exists(): f.unlink()
        self._json({'ok': True})

    def _safe_plan_name(self, path):
        raw = path[len('/api/plans/'):]
        raw = urllib.parse.unquote(raw)
        name = Path(raw).name
        return name if name and not name.startswith('.') else None

    # ── Project file access ─────────────────────────────────────────────────

    def _resolve_project_path(self, rel):
        """Return resolved Path if safe (within projects dir), else None."""
        resolved = (PROJECTS_DIR / rel).resolve()
        try:
            resolved.relative_to(PROJECTS_DIR.resolve())
            return resolved
        except ValueError:
            return None

    def _dir_listing(self, base):
        """Recursively list files under base, returning relative paths."""
        base = Path(base)
        if not base.exists():
            return []
        return sorted(
            str(p.relative_to(base))
            for p in base.rglob('*')
            if p.is_file() and not p.name.startswith('.')
        )

    def _serve_file(self, path):
        path = Path(path)
        if not path.exists():
            return self.send_error(404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _write_file(self, path, body):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body if isinstance(body, bytes) else body.encode())
        self._json({'ok': True})

    def _project_files_get(self, url_path):
        # /api/project/files             → list
        # /api/project/files/<rel>       → read
        after = urllib.parse.unquote(url_path[len('/api/project/files'):])
        if not after or after == '/':
            self._json(self._dir_listing(PROJECTS_DIR))
        else:
            rel = after.lstrip('/')
            resolved = self._resolve_project_path(rel)
            if not resolved:
                return self.send_error(400)
            self._serve_file(resolved)

    def _project_files_post(self, url_path, body):
        rel = urllib.parse.unquote(url_path[len('/api/project/files/'):])
        resolved = self._resolve_project_path(rel)
        if not resolved:
            return self.send_error(400)
        self._write_file(resolved, body)

    # ── Pipelines ─────────────────────────────────────────────────────────────

    def _pl_out(self, row):
        return {
            'id': row['id'], 'name': row['name'], 'goal': row['goal'],
            'pmAgentId': row['pm_agent_id'], 'pmModel': row['pm_model'],
            'schedule': json.loads(row['schedule'] or '{"type":"manual"}'),
            'pauseOnFail': bool(row['pause_on_fail']),
            'feedbackLoop': bool(row['feedback_loop']) if 'feedback_loop' in row.keys() else True,
            'layout': json.loads(row['layout'] or '{}'),
            'createdAt': row['created_at'],
            'mode': row['mode'] if 'mode' in row.keys() else 'fixed',
            'roster': json.loads(row['roster'] or '[]') if 'roster' in row.keys() else [],
            'verifyCommand': (row['verify_command'] or '') if 'verify_command' in row.keys() else '',
            'maxTurns': row['max_turns'] if 'max_turns' in row.keys() else 20,
            'workDir': (row['work_dir'] or '') if 'work_dir' in row.keys() else '',
        }

    def _pl_step_out(self, row):
        return {
            'id': row['id'], 'pipelineId': row['pipeline_id'],
            'stepIndex': row['step_index'], 'name': row['name'],
            'agentId': row['agent_id'], 'agentName': row['agent_name'],
            'task': row['task'],
            'handoverFields': json.loads(row['handover_fields'] or '[]'),
            'qualityCriteria': json.loads(row['quality_criteria'] or '[]'),
            'passFullOutput': bool(row['pass_full_output']),
            'agentInput': row['agent_input'] or '',
            'modelTier': row['model_tier'] if 'model_tier' in row.keys() else 'local',
            'loopConfig': json.loads(row['loop_config'] if 'loop_config' in row.keys() else '{}' or '{}'),
        }

    def _pl_step_run_out(self, row):
        return {
            'id': row['id'], 'runId': row['run_id'],
            'stepId': row['step_id'], 'stepIndex': row['step_index'],
            'stepName': row['step_name'], 'agentName': row['agent_name'],
            'status': row['status'], 'output': row['output'],
            'handoverData': json.loads(row['handover_data'] or 'null'),
            'pmNotes': row['pm_notes'], 'qaVerdict': row['qa_verdict'],
            'qaReason': row['qa_reason'], 'retryCount': row['retry_count'],
            'startedAt': row['started_at'], 'finishedAt': row['finished_at'],
            'iteration': row['iteration'] if 'iteration' in row.keys() else 0,
        }

    def _pl_run_out(self, row):
        return {
            'id': row['id'], 'pipelineId': row['pipeline_id'],
            'status': row['status'], 'startedAt': row['started_at'],
            'finishedAt': row['finished_at'], 'error': row['error'],
            'userFeedback': row['user_feedback'] if 'user_feedback' in row.keys() else '',
            'parentRunId': row['parent_run_id'] if 'parent_run_id' in row.keys() else None,
        }

    def _pl_turn_out(self, row):
        return {
            'id': row['id'], 'turnIndex': row['turn_index'],
            'agentId': row['agent_id'], 'agentName': row['agent_name'] or '',
            'action': row['action'], 'instructions': row['instructions'] or '',
            'reasoning': row['reasoning'] or '', 'output': row['output'] or '',
            'workspaceDiff': row['workspace_diff'] or '',
            'verifyStatus': row['verify_status'],
            'supersededBy': row['superseded_by'],
            'status': row['status'],
            'startedAt': row['started_at'], 'finishedAt': row['finished_at'],
        }

    def _get_recent_pipeline_runs(self):
        with get_db() as db:
            rows = rows_to_list(db.execute('''
                SELECT r.*, p.name as pipeline_name
                FROM pipeline_runs r
                LEFT JOIN pipelines p ON p.id = r.pipeline_id
                ORDER BY r.started_at DESC LIMIT 10
            ''').fetchall())
        out = []
        for r in rows:
            o = self._pl_run_out(r)
            o['pipelineName'] = r['pipeline_name']
            out.append(o)
        self._json(out)

    # ── Job queue ─────────────────────────────────────────────────────────────

    def _enqueue_pipeline_run(self, pid):
        job_id = str(time.time_ns())
        ts = datetime.datetime.now().isoformat()
        with get_db() as db:
            row = db.execute('SELECT id FROM pipelines WHERE id=?', (pid,)).fetchone()
            if not row:
                return self._json({'error': 'Pipeline not found'}, 404)
            db.execute(
                'INSERT INTO jobs (id,pipeline_id,status,output_log,created_at) VALUES (?,?,?,?,?)',
                (job_id, pid, 'queued', '', ts)
            )
        self._json({'jobId': job_id, 'status': 'queued'})

    def _post_run_feedback(self, run_id, body):
        """User feedback on a finished run → enqueue a revision job. The worker
        re-runs the whole pipeline from the start block with this feedback and
        the previous run's outputs injected into every agent + the PM."""
        fb = (body.get('feedback') or '').strip()
        if not fb:
            return self._json({'error': 'feedback text required'}, 400)
        job_id = str(time.time_ns())
        ts = datetime.datetime.now().isoformat()
        with get_db() as db:
            run = db.execute('SELECT * FROM pipeline_runs WHERE id=?', (run_id,)).fetchone()
            if not run:
                return self._json({'error': 'Run not found'}, 404)
            if run['status'] in ('running', 'pending'):
                return self._json({'error': 'Run is still in progress'}, 400)
            active = db.execute(
                "SELECT COUNT(*) FROM jobs WHERE pipeline_id=? AND status IN ('queued','running','cancelling')",
                (run['pipeline_id'],)
            ).fetchone()[0]
            if active:
                return self._json({'error': 'Pipeline already has an active run'}, 400)
            db.execute(
                'INSERT INTO jobs (id,pipeline_id,status,output_log,created_at,feedback,feedback_of_run) VALUES (?,?,?,?,?,?,?)',
                (job_id, run['pipeline_id'], 'queued', '', ts, fb, run_id)
            )
            db.execute("UPDATE pipeline_runs SET status='done' WHERE id=? AND status='awaiting_feedback'",
                       (run_id,))
        self._json({'jobId': job_id, 'status': 'queued'})

    def _approve_run(self, run_id):
        with get_db() as db:
            row = db.execute('SELECT id FROM pipeline_runs WHERE id=?', (run_id,)).fetchone()
            if not row:
                return self._json({'error': 'Run not found'}, 404)
            db.execute("UPDATE pipeline_runs SET status='done' WHERE id=? AND status='awaiting_feedback'",
                       (run_id,))
        self._json({'ok': True})

    def _get_debug_status(self):
        worker = {}
        try:
            r = subprocess.run(
                ['systemctl', '--user', 'show', 'atlantis-worker',
                 '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp'],
                capture_output=True, text=True, timeout=5
            )
            for line in r.stdout.strip().splitlines():
                if '=' in line:
                    k, _, v = line.partition('=')
                    worker[k] = v.strip()
        except Exception as e:
            worker['error'] = str(e)
        with get_db() as db:
            jobs = rows_to_list(db.execute('''
                SELECT j.id, j.pipeline_id, j.status, j.error,
                       j.created_at, j.started_at, j.finished_at, j.loop_depth,
                       p.name as pipeline_name
                FROM jobs j
                LEFT JOIN pipelines p ON p.id = j.pipeline_id
                ORDER BY j.created_at DESC LIMIT 30
            ''').fetchall())
        wal_path = Path(str(DB_FILE) + '-wal')
        self._json({
            'worker': worker,
            'jobs': jobs,
            'db': {
                'size_bytes': DB_FILE.stat().st_size if DB_FILE.exists() else 0,
                'wal_bytes':  wal_path.stat().st_size if wal_path.exists() else 0,
            }
        })

    def _restart_worker(self):
        try:
            subprocess.run(['systemctl', '--user', 'restart', 'atlantis-worker'],
                          capture_output=True, text=True, timeout=10)
            self._json({'ok': True})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    UPDATE_REQUIRED_PATHS = ('web/index.html', 'server/server.py', 'agent/worker.py')

    def _post_system_update(self, raw):
        import tempfile, zipfile, shutil
        tmp_dir = Path(tempfile.mkdtemp(prefix='atlantis_update_'))
        try:
            zip_path = tmp_dir / 'update.zip'
            zip_path.write_bytes(raw)
            extract_dir = tmp_dir / 'extract'
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(extract_dir)
            except zipfile.BadZipFile:
                return self._json({'error': 'Not a valid zip file'}, 400)
            candidates = list(extract_dir.rglob('server/server.py'))
            if not candidates:
                return self._json({'error': 'Invalid update: server/server.py not found in zip'}, 400)
            src_root = candidates[0].parent.parent
            for rel in self.UPDATE_REQUIRED_PATHS:
                if not (src_root / rel).exists():
                    return self._json({'error': f'Invalid update: missing {rel}'}, 400)
            # Stage all three copies before touching anything live, so a
            # mid-copy failure (e.g. disk full) never leaves a directory
            # deleted with no replacement ready.
            staged = []
            for name in ('web', 'server', 'agent'):
                staging = ROOT_DIR / f'{name}.new'
                if staging.exists():
                    shutil.rmtree(staging)
                shutil.copytree(src_root / name, staging)
                staged.append(name)
            for name in staged:
                dest = ROOT_DIR / name
                staging = ROOT_DIR / f'{name}.new'
                if dest.exists():
                    shutil.rmtree(dest)
                staging.rename(dest)
            RESTART_FLAG.touch()
            self._json({'ok': True})
        except Exception as e:
            self._json({'error': f'Update failed: {e}'}, 500)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            for name in ('web', 'server', 'agent'):
                staging = ROOT_DIR / f'{name}.new'
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)

    def _post_system_restart(self):
        RESTART_FLAG.touch()
        self._json({'ok': True})

    def _post_system_stop(self):
        STOP_FLAG.touch()
        self._json({'ok': True})

    def _list_jobs(self):
        qs = urllib.parse.parse_qs(self.path.split('?', 1)[1]) if '?' in self.path else {}
        pid = (qs.get('pipeline_id') or [None])[0]
        with get_db() as db:
            if pid:
                rows = rows_to_list(db.execute(
                    'SELECT id,pipeline_id,status,error,parent_job_id,loop_depth,created_at,started_at,finished_at FROM jobs WHERE pipeline_id=? ORDER BY created_at DESC LIMIT 100', (pid,)
                ).fetchall())
            else:
                rows = rows_to_list(db.execute(
                    'SELECT id,pipeline_id,status,error,parent_job_id,loop_depth,created_at,started_at,finished_at FROM jobs ORDER BY created_at DESC LIMIT 50'
                ).fetchall())
        self._json(rows)

    def _get_job(self, job_id):
        with get_db() as db:
            row = db.execute('SELECT id,pipeline_id,status,error,parent_job_id,loop_depth,created_at,started_at,finished_at FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            return self._json({'error': 'Not found'}, 404)
        self._json(dict(row))

    def _cancel_job(self, job_id):
        with get_db() as db:
            row = db.execute('SELECT status FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                return self._json({'error': 'Not found'}, 404)
            status = row['status']
            if status == 'queued':
                db.execute("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?",
                           (datetime.datetime.now().isoformat(), job_id))
            elif status == 'running':
                # Worker polls for this between steps and flips it to 'cancelled'
                db.execute("UPDATE jobs SET status='cancelling' WHERE id=?", (job_id,))
            # Legacy: take any queued loop children down with the parent
            db.execute("UPDATE jobs SET status='cancelled' WHERE parent_job_id=? AND status='queued'",
                       (job_id,))
        self._json({'ok': True, 'status': 'cancelled' if status == 'queued' else 'cancelling'})

    def _job_subtree_ids(self, db, job_id):
        ids = set()
        frontier = [job_id]
        while frontier:
            ids.update(frontier)
            placeholders = ','.join('?' * len(frontier))
            frontier = [r['id'] for r in db.execute(
                f'SELECT id FROM jobs WHERE parent_job_id IN ({placeholders})', frontier
            ).fetchall()]
        return ids

    def _delete_job(self, job_id):
        with get_db() as db:
            row = db.execute('SELECT id FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                return self._json({'error': 'Not found'}, 404)
            ids = self._job_subtree_ids(db, job_id)
            placeholders = ','.join('?' * len(ids))
            active = db.execute(
                f"SELECT COUNT(*) FROM jobs WHERE id IN ({placeholders}) AND status IN ('queued','running','cancelling')",
                tuple(ids)
            ).fetchone()[0]
            if active:
                return self._json({'error': 'Cannot delete an active run'}, 400)
            db.execute(f'DELETE FROM jobs WHERE id IN ({placeholders})', tuple(ids))
        self._json({'ok': True})

    def _delete_all_jobs(self, pid):
        with get_db() as db:
            db.execute(
                "DELETE FROM jobs WHERE pipeline_id=? AND status NOT IN ('queued','running','cancelling')",
                (pid,)
            )
        self._json({'ok': True})

    def _stream_job_sse(self, job_id):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self._cors()
        self.end_headers()
        sent = 0
        while True:
            try:
                with get_db() as db:
                    row = db.execute('SELECT status, output_log FROM jobs WHERE id=?', (job_id,)).fetchone()
                if not row:
                    self.wfile.write(b'data: {"type":"error","message":"Job not found"}\n\n')
                    self.wfile.flush()
                    return
                log = row['output_log'] or ''
                new_data = log[sent:]
                if new_data:
                    last_nl = new_data.rfind('\n')
                    if last_nl >= 0:
                        to_emit = new_data[:last_nl + 1]
                        for line in to_emit.split('\n'):
                            line = line.strip()
                            if line:
                                self.wfile.write(f'data: {line}\n\n'.encode())
                        self.wfile.flush()
                        sent += last_nl + 1
                if row['status'] in ('done', 'failed', 'paused', 'cancelled') and sent >= len(log):
                    return
            except Exception:
                return
            time.sleep(0.4)

    # ── Pipelines ─────────────────────────────────────────────────────────────

    def _get_pipelines(self):
        with get_db() as db:
            rows = rows_to_list(db.execute('SELECT * FROM pipelines ORDER BY created_at DESC').fetchall())
        self._json([self._pl_out(r) for r in rows])

    def _post_pipeline(self, body):
        pid = str(time.time_ns())
        now = datetime.datetime.now().isoformat()
        with get_db() as db:
            db.execute(
                'INSERT INTO pipelines (id,name,goal,pm_agent_id,pm_model,schedule,pause_on_fail,feedback_loop,layout,created_at,mode,roster,verify_command,max_turns,work_dir) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (pid, body.get('name','New Pipeline'), body.get('goal',''),
                 body.get('pmAgentId'), body.get('pmModel',''),
                 json.dumps(body.get('schedule',{'type':'manual'})),
                 1 if body.get('pauseOnFail', True) else 0,
                 1 if body.get('feedbackLoop', True) else 0,
                 json.dumps(body.get('layout',{})), now,
                 body.get('mode', 'fixed'),
                 json.dumps(body.get('roster', [])),
                 body.get('verifyCommand', ''),
                 body.get('maxTurns', 20),
                 body.get('workDir', ''))
            )
            if body.get('mode', 'fixed') == 'fixed':
                # Default start block, so the feedback gate always has a step to loop back to.
                # Dynamic pipelines have no pipeline_steps at all.
                db.execute(
                    'INSERT INTO pipeline_steps (id,pipeline_id,step_index,name,agent_id,agent_name,task,handover_fields,quality_criteria,pass_full_output,agent_input,model_tier,loop_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (str(time.time_ns()), pid, 0, 'Start', None, '', '', '[]', '[]', 0, '', 'local', '{}')
                )
        self._json({'ok': True, 'id': pid})

    def _get_pipeline(self, pid):
        with get_db() as db:
            row = db.execute('SELECT * FROM pipelines WHERE id=?', (pid,)).fetchone()
            if not row:
                return self.send_error(404)
            steps = rows_to_list(db.execute(
                'SELECT * FROM pipeline_steps WHERE pipeline_id=? ORDER BY step_index', (pid,)
            ).fetchall())
        out = self._pl_out(row)
        out['steps'] = [self._pl_step_out(s) for s in steps]
        self._json(out)

    def _put_pipeline(self, pid, body):
        with get_db() as db:
            db.execute('''UPDATE pipelines SET name=?,goal=?,pm_agent_id=?,pm_model=?,
                          schedule=?,pause_on_fail=?,feedback_loop=?,layout=?,
                          mode=?,roster=?,verify_command=?,max_turns=?,work_dir=? WHERE id=?''',
                       (body.get('name'), body.get('goal',''),
                        body.get('pmAgentId'), body.get('pmModel',''),
                        json.dumps(body.get('schedule',{'type':'manual'})),
                        1 if body.get('pauseOnFail', True) else 0,
                        1 if body.get('feedbackLoop', True) else 0,
                        json.dumps(body.get('layout',{})),
                        body.get('mode', 'fixed'),
                        json.dumps(body.get('roster', [])),
                        body.get('verifyCommand', ''),
                        body.get('maxTurns', 20),
                        body.get('workDir', ''), pid))
        self._json({'ok': True})

    def _delete_pipeline(self, pid):
        with get_db() as db:
            db.execute('DELETE FROM pipelines WHERE id=?', (pid,))
        self._json({'ok': True})

    def _get_pipeline_steps(self, pid):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT * FROM pipeline_steps WHERE pipeline_id=? ORDER BY step_index', (pid,)
            ).fetchall())
        self._json([self._pl_step_out(r) for r in rows])

    def _post_pipeline_step(self, pid, body):
        sid = str(time.time_ns())
        with get_db() as db:
            max_idx = db.execute(
                'SELECT COALESCE(MAX(step_index),-1) FROM pipeline_steps WHERE pipeline_id=?', (pid,)
            ).fetchone()[0]
            db.execute(
                'INSERT INTO pipeline_steps (id,pipeline_id,step_index,name,agent_id,agent_name,task,handover_fields,quality_criteria,pass_full_output,agent_input,model_tier,loop_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (sid, pid, max_idx + 1, body.get('name','New Step'),
                 body.get('agentId'), body.get('agentName',''),
                 body.get('task',''), json.dumps(body.get('handoverFields',[])),
                 json.dumps(body.get('qualityCriteria',[])),
                 1 if body.get('passFullOutput') else 0,
                 body.get('agentInput',''),
                 body.get('modelTier', 'local'),
                 json.dumps(body.get('loopConfig', {})))
            )
        self._json({'ok': True, 'id': sid})

    def _put_pipeline_step(self, pid, sid, body):
        with get_db() as db:
            db.execute('''UPDATE pipeline_steps SET name=?,agent_id=?,agent_name=?,task=?,
                          handover_fields=?,quality_criteria=?,pass_full_output=?,agent_input=?,
                          model_tier=?,loop_config=?,step_index=?
                          WHERE id=? AND pipeline_id=?''',
                       (body.get('name',''), body.get('agentId'), body.get('agentName',''),
                        body.get('task',''), json.dumps(body.get('handoverFields',[])),
                        json.dumps(body.get('qualityCriteria',[])),
                        1 if body.get('passFullOutput') else 0,
                        body.get('agentInput',''),
                        body.get('modelTier', 'local'),
                        json.dumps(body.get('loopConfig', {})),
                        body.get('stepIndex', 0), sid, pid))
        self._json({'ok': True})

    def _delete_pipeline_step(self, pid, sid):
        with get_db() as db:
            db.execute('DELETE FROM pipeline_steps WHERE id=? AND pipeline_id=?', (sid, pid))
            # Re-index remaining steps
            remaining = rows_to_list(db.execute(
                'SELECT id FROM pipeline_steps WHERE pipeline_id=? ORDER BY step_index', (pid,)
            ).fetchall())
            for i, r in enumerate(remaining):
                db.execute('UPDATE pipeline_steps SET step_index=? WHERE id=?', (i, r['id']))
        self._json({'ok': True})

    def _get_pipeline_runs(self, pid):
        with get_db() as db:
            rows = rows_to_list(db.execute(
                'SELECT * FROM pipeline_runs WHERE pipeline_id=? ORDER BY started_at DESC LIMIT 50', (pid,)
            ).fetchall())
        self._json([self._pl_run_out(r) for r in rows])

    def _get_pipeline_run(self, run_id):
        with get_db() as db:
            row = db.execute('SELECT * FROM pipeline_runs WHERE id=?', (run_id,)).fetchone()
            if not row:
                return self.send_error(404)
            step_runs = rows_to_list(db.execute(
                'SELECT * FROM pipeline_step_runs WHERE run_id=? ORDER BY iteration, step_index', (run_id,)
            ).fetchall())
            turns = rows_to_list(db.execute(
                'SELECT * FROM pipeline_turns WHERE run_id=? ORDER BY turn_index', (run_id,)
            ).fetchall())
        out = self._pl_run_out(row)
        out['stepRuns'] = [self._pl_step_run_out(s) for s in step_runs]
        out['turns'] = [self._pl_turn_out(t) for t in turns]
        self._json(out)

    def _delete_pipeline_run(self, run_id):
        # No worker reconciliation exists for this table (unlike jobs), so runs can be
        # stuck at status='running' forever after a crash/restart. Deletion must not
        # be blocked on status or that junk becomes permanently unremovable.
        with get_db() as db:
            row = db.execute('SELECT id FROM pipeline_runs WHERE id=?', (run_id,)).fetchone()
            if not row:
                return self._json({'error': 'Not found'}, 404)
            db.execute('DELETE FROM pipeline_runs WHERE id=?', (run_id,))
        self._json({'ok': True})

    def _delete_all_pipeline_runs(self, pid):
        with get_db() as db:
            db.execute('DELETE FROM pipeline_runs WHERE pipeline_id=?', (pid,))
        self._json({'ok': True})

    def _run_pipeline_sse(self, pid):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self._cors()
        self.end_headers()

        def emit(obj):
            try:
                line = 'data: ' + json.dumps(obj) + '\n\n'
                self.wfile.write(line.encode())
                self.wfile.flush()
            except Exception:
                pass

        now = datetime.datetime.now().isoformat
        run_id = str(time.time_ns())

        try:
            with get_db() as db:
                pl_row = db.execute('SELECT * FROM pipelines WHERE id=?', (pid,)).fetchone()
                if not pl_row:
                    emit({'type': 'error', 'message': 'Pipeline not found'})
                    return
                pipeline = self._pl_out(pl_row)
                steps = [self._pl_step_out(r) for r in rows_to_list(db.execute(
                    'SELECT * FROM pipeline_steps WHERE pipeline_id=? ORDER BY step_index', (pid,)
                ).fetchall())]
                all_agents = rows_to_list(db.execute('SELECT * FROM agents').fetchall())
                cfg_rows = rows_to_list(db.execute('SELECT key,value FROM settings').fetchall())
                cfg = {}
                for r in cfg_rows:
                    try: cfg[r['key']] = json.loads(r['value'])
                    except Exception: pass

            if not steps:
                emit({'type': 'error', 'message': 'No steps defined'})
                return

            pm_model = pipeline['pmModel']
            if pipeline['pmAgentId']:
                pm_agent = next((a for a in all_agents if a['id'] == pipeline['pmAgentId']), None)
                if pm_agent and not pm_model:
                    pm_model = pm_agent.get('model', '')
            if not pm_model:
                pm_model = cfg.get('endpoint', 'http://localhost:11434') and (
                    next(iter([a['model'] for a in all_agents if a.get('model')]), 'llama3.1:8b')
                )

            OLLAMA_EP = resolve_ollama_endpoint(cfg.get('endpoint'))
            max_retries = 3

            # Create run record
            ts = datetime.datetime.now().isoformat()
            with get_db() as db:
                db.execute('INSERT INTO pipeline_runs (id,pipeline_id,status,started_at) VALUES (?,?,?,?)',
                           (run_id, pid, 'running', ts))
                for s in steps:
                    db.execute(
                        'INSERT INTO pipeline_step_runs (id,run_id,step_id,step_index,step_name,agent_name,status) VALUES (?,?,?,?,?,?,?)',
                        (str(time.time_ns()), run_id, s['id'], s['stepIndex'], s['name'], s['agentName'], 'pending')
                    )

            emit({'type': 'run_start', 'runId': run_id, 'totalSteps': len(steps)})

            def set_run_status(status, error=None):
                with get_db() as db:
                    db.execute('UPDATE pipeline_runs SET status=?,finished_at=?,error=? WHERE id=?',
                               (status, datetime.datetime.now().isoformat(), error, run_id))

            def set_step_run(step_idx, **kwargs):
                with get_db() as db:
                    fields = ', '.join(f'{k}=?' for k in kwargs)
                    db.execute(f'UPDATE pipeline_step_runs SET {fields} WHERE run_id=? AND step_index=?',
                               (*kwargs.values(), run_id, step_idx))

            PIPELINE_TOOLS = [
                {'type': 'function', 'function': {
                    'name': 'read_file',
                    'description': 'Read the contents of a file.',
                    'parameters': {'type': 'object', 'required': ['path'],
                        'properties': {'path': {'type': 'string', 'description': 'Absolute or relative file path'}}},
                }},
                {'type': 'function', 'function': {
                    'name': 'write_file',
                    'description': 'Write content to a file, creating it if needed.',
                    'parameters': {'type': 'object', 'required': ['path', 'content'],
                        'properties': {
                            'path':    {'type': 'string', 'description': 'File path to write'},
                            'content': {'type': 'string', 'description': 'Content to write'},
                        }},
                }},
                {'type': 'function', 'function': {
                    'name': 'list_files',
                    'description': 'List files and directories at a path.',
                    'parameters': {'type': 'object', 'required': ['path'],
                        'properties': {'path': {'type': 'string', 'description': 'Directory path'}}},
                }},
                {'type': 'function', 'function': {
                    'name': 'web_search',
                    'description': 'Search the web and return titles, URLs, and snippets.',
                    'parameters': {'type': 'object', 'required': ['query'],
                        'properties': {'query': {'type': 'string', 'description': 'Search query'}}},
                }},
                {'type': 'function', 'function': {
                    'name': 'web_fetch',
                    'description': 'Fetch the text content of a URL.',
                    'parameters': {'type': 'object', 'required': ['url'],
                        'properties': {'url': {'type': 'string', 'description': 'URL to fetch'}}},
                }},
            ]

            def ollama_agentic(model, messages, agent_tools, step_idx, on_chunk):
                """Agentic loop: stream Ollama, execute tool calls, continue until done."""
                msgs = list(messages)
                all_output = []
                tools = PIPELINE_TOOLS if agent_tools else []
                nudged = False

                for _ in range(10):
                    content_parts = []
                    tool_calls = []
                    try:
                        req_body = json.dumps({
                            'model': model, 'messages': msgs, 'stream': True,
                            **(({'tools': tools}) if tools else {}),
                        }).encode()
                        req = urllib.request.Request(f'{OLLAMA_EP}/api/chat',
                                                    data=req_body, method='POST',
                                                    headers={'Content-Type': 'application/json'})
                        with urllib.request.urlopen(req, timeout=10800) as resp:
                            for raw_line in resp:
                                line = raw_line.decode('utf-8', errors='replace').strip()
                                if not line:
                                    continue
                                try:
                                    chunk = json.loads(line)
                                    msg = chunk.get('message', {})
                                    text = msg.get('content', '')
                                    if text:
                                        content_parts.append(text)
                                        on_chunk(text)
                                    tcs = msg.get('tool_calls')
                                    if tcs:
                                        tool_calls.extend(tcs)
                                except Exception:
                                    pass
                    except Exception as e:
                        return None, str(e)

                    content = ''.join(content_parts)
                    if content:
                        all_output.append(content)

                    if not tool_calls:
                        if tools and content and not nudged:
                            nudged = True
                            msgs.append({'role': 'assistant', 'content': content})
                            msgs.append({'role': 'user', 'content': 'Please now execute the plan using the available tools. Call the tools directly — do not describe what you will do.'})
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
                        result = self._exec_pipeline_tool(name, args)
                        emit({'type': 'tool_call', 'stepIndex': step_idx,
                              'tool': name, 'result': result})
                        msgs.append({'role': 'tool', 'content': json.dumps(result)})

                return '\n\n'.join(filter(None, all_output)), None

            def ollama_once(model, messages):
                """Non-streaming Ollama call, return (output, error)."""
                try:
                    req_body = json.dumps({'model': model, 'messages': messages, 'stream': False}).encode()
                    req = urllib.request.Request(f'{OLLAMA_EP}/api/chat',
                                                data=req_body, method='POST',
                                                headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=10800) as resp:
                        data = json.loads(resp.read())
                    return data.get('message', {}).get('content', ''), None
                except Exception as e:
                    return None, str(e)

            # Track handover chain
            handover_chain = []  # list of {stepIndex, stepName, agentName, output, handoverData, pmNotes}

            for step_idx, step in enumerate(steps):
                retry_count = 0
                qa_feedback = None

                while True:
                    step_ts = datetime.datetime.now().isoformat()
                    set_step_run(step_idx, status='running', started_at=step_ts, retry_count=retry_count)
                    emit({'type': 'step_start', 'stepIndex': step_idx,
                          'stepName': step['name'], 'agentName': step['agentName'],
                          'retryCount': retry_count})

                    # Build agent messages
                    agent = next((a for a in all_agents if a['id'] == step.get('agentId')), None)
                    agent_tools_cfg = json.loads(agent.get('tools') or '{}') if agent else {}
                    has_tools = agent_tools_cfg.get('files') or agent_tools_cfg.get('web')
                    sys_parts = []
                    if agent and agent.get('system_prompt'):
                        sys_parts.append(agent['system_prompt'])
                    sys_parts.append(f'Pipeline goal: {pipeline["goal"]}')
                    if has_tools:
                        work_root = str(self._fs_root())
                        sys_parts.append(
                            f'You have access to tools: read_file, write_file, list_files, web_search, web_fetch. '
                            f'WORKSPACE ROOT: {work_root} — every file path you use MUST start with this exact prefix. '
                            f'EXAMPLE: to create a file called index.html inside a folder called mysite, '
                            f'use the path: {work_root}/mysite/index.html — never use /projects/..., ~/..., or relative paths. '
                            f'USE the tools to actually complete the task — do not just describe what you would do. '
                            f'Only respond with a final summary AFTER all tool calls are done.'
                        )

                    user_parts = [f'Your task: {step["task"]}']
                    if step.get('agentInput'):
                        user_parts.append(f'\n## Additional input:\n{step["agentInput"]}')
                    if handover_chain:
                        user_parts.append('\n## Output from previous steps:')
                        for h in handover_chain:
                            user_parts.append(f'\n### Step {h["stepIndex"]+1}: {h["stepName"]} ({h["agentName"]})')
                            if h.get('output'):
                                user_parts.append(h['output'])
                            if h.get('pmNotes'):
                                user_parts.append(f'[PM note: {h["pmNotes"]}]')
                    if qa_feedback:
                        user_parts.append(f'\n## Previous attempt feedback:\n{qa_feedback}\nPlease address these issues.')

                    messages = []
                    if sys_parts:
                        messages.append({'role': 'system', 'content': '\n\n'.join(sys_parts)})
                    messages.append({'role': 'user', 'content': '\n'.join(user_parts)})

                    model = (agent['model'] if agent and agent.get('model') else pm_model) or pm_model

                    agent_tools = agent and (
                        json.loads(agent.get('tools') or '{}').get('files') or
                        json.loads(agent.get('tools') or '{}').get('web')
                    )
                    output, err = ollama_agentic(
                        model, messages, agent_tools, step_idx,
                        lambda text, si=step_idx: emit({'type': 'step_chunk', 'stepIndex': si, 'chunk': text})
                    )

                    if err:
                        set_step_run(step_idx, status='failed', finished_at=datetime.datetime.now().isoformat())
                        set_run_status('failed', error=f'Step {step_idx+1} error: {err}')
                        emit({'type': 'run_failed', 'reason': f'Step {step_idx+1} ({step["name"]}) error: {err}'})
                        return

                    set_step_run(step_idx, output=output)
                    emit({'type': 'step_done', 'stepIndex': step_idx})

                    # ── PM review ────────────────────────────────────────────
                    emit({'type': 'pm_start', 'stepIndex': step_idx})
                    qc_list = '\n'.join(f'  - {c}' for c in step['qualityCriteria']) or '  (none)'
                    pm_msgs = [{'role': 'user', 'content': (
                        f'You are the Pipeline Manager overseeing: {pipeline["goal"]}\n\n'
                        f'Step {step_idx+1} "{step["name"]}" just completed.\n'
                        f'Agent: {step["agentName"]}\nTask: {step["task"]}\n\n'
                        f'Output:\n{output[:4000]}{"..." if len(output)>4000 else ""}\n\n'
                        f'Quality criteria:\n{qc_list}\n\n'
                        'Respond ONLY with valid JSON (no markdown fences):\n'
                        '{"verdict":"pass","notes_for_next":"brief note for the next step"}\n'
                        'OR if criteria not met:\n'
                        '{"verdict":"fail","reason":"specific issue"}'
                    )}]

                    pm_raw, _ = ollama_once(pm_model, pm_msgs)
                    pm_result = {'verdict': 'pass', 'notes_for_next': ''}
                    if pm_raw:
                        try:
                            cleaned = pm_raw.strip().lstrip('`').removeprefix('json').strip('`').strip()
                            pm_result = json.loads(cleaned)
                        except Exception:
                            pass

                    pm_notes = pm_result.get('notes_for_next', '')
                    verdict  = pm_result.get('verdict', 'pass')
                    reason   = pm_result.get('reason', '')

                    set_step_run(step_idx, pm_notes=pm_notes, qa_verdict=verdict, qa_reason=reason)
                    emit({'type': 'pm_verdict', 'stepIndex': step_idx,
                          'verdict': verdict, 'reason': reason, 'pmNotes': pm_notes})

                    if verdict == 'pass':
                        set_step_run(step_idx, status='done', finished_at=datetime.datetime.now().isoformat())
                        handover_chain.append({
                            'stepIndex': step_idx, 'stepName': step['name'],
                            'agentName': step['agentName'],
                            'output': output, 'pmNotes': pm_notes,
                        })
                        break
                    else:
                        retry_count += 1
                        if retry_count >= max_retries:
                            if pipeline.get('pauseOnFail', True):
                                set_step_run(step_idx, status='paused',
                                             finished_at=datetime.datetime.now().isoformat())
                                set_run_status('paused')
                                emit({'type': 'run_paused', 'stepIndex': step_idx, 'reason': reason})
                                return
                            else:
                                # continue_on_fail: log and move on
                                set_step_run(step_idx, status='failed',
                                             finished_at=datetime.datetime.now().isoformat())
                                emit({'type': 'step_skipped', 'stepIndex': step_idx, 'reason': reason})
                                handover_chain.append({
                                    'stepIndex': step_idx, 'stepName': step['name'],
                                    'agentName': step['agentName'], 'output': output,
                                    'pmNotes': f'[FAILED] {reason}',
                                })
                                break
                        else:
                            qa_feedback = reason
                            emit({'type': 'step_retry', 'stepIndex': step_idx,
                                  'retryCount': retry_count, 'reason': reason})

            set_run_status('done')
            emit({'type': 'run_done', 'runId': run_id})

        except Exception as e:
            emit({'type': 'error', 'message': str(e)})
            try:
                set_run_status('failed', error=str(e))
            except Exception:
                pass

    # ── Web access ───────────────────────────────────────────────────────────

    _PRIVATE_PREFIXES = (
        'localhost', '127.', '0.0.0.0', '::1',
        '10.', '192.168.',
        '172.16.', '172.17.', '172.18.', '172.19.',
        '172.20.', '172.21.', '172.22.', '172.23.',
        '172.24.', '172.25.', '172.26.', '172.27.',
        '172.28.', '172.29.', '172.30.', '172.31.',
    )

    def _safe_url(self, url):
        """Return error string if URL is unsafe, else None."""
        try:
            p = urllib.parse.urlparse(url)
        except Exception:
            return 'Invalid URL'
        if p.scheme not in ('http', 'https'):
            return 'Only http/https URLs are allowed'
        host = (p.hostname or '').lower()
        if any(host == pfx.rstrip('.') or host.startswith(pfx) for pfx in self._PRIVATE_PREFIXES):
            return 'Private/internal URLs are blocked'
        return None

    @staticmethod
    def _strip_html(html):
        html = re.sub(r'<(script|style|nav|footer|header|aside)[^>]*>.*?</\1>',
                      '', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', html)
        text = (text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                    .replace('&nbsp;', ' ').replace('&#39;', "'").replace('&quot;', '"'))
        return re.sub(r'[ \t]+', ' ', re.sub(r'\n\s*\n+', '\n\n', text)).strip()

    def _web_search_core(self, query):
        url = 'https://html.duckduckgo.com/html/?q=' + urllib.parse.quote(query)
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'identity',
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read(256 * 1024).decode('utf-8', errors='replace')
        results = []
        title_pat   = re.compile(r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL)
        snippet_pat = re.compile(r'class="result__snippet"[^>]*>(.*?)</(?:a|span|div)>', re.DOTALL)
        titles   = title_pat.findall(html)
        snippets = snippet_pat.findall(html)
        for i, (href, raw_title) in enumerate(titles[:8]):
            m = re.search(r'[?&]uddg=([^&"]+)', href)
            real_url = urllib.parse.unquote(m.group(1)) if m else href
            title   = re.sub(r'<[^>]+>', '', raw_title).strip()
            snippet = re.sub(r'<[^>]+>', '', snippets[i]).strip() if i < len(snippets) else ''
            if real_url and title:
                results.append({'title': title, 'url': real_url, 'snippet': snippet})
        return results

    def _web_fetch_core(self, url):
        err = self._safe_url(url)
        if err:
            return None, err
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read(131072)
            ct  = resp.headers.get('Content-Type', '')
        text = self._strip_html(raw.decode('utf-8', errors='replace')) \
               if 'html' in ct else raw.decode('utf-8', errors='replace')
        return text[:50000], None

    def _pipe_path_safe(self, raw, work_root=None):
        """Resolve a path for pipeline tool use.
        If the path is absolute but not under the home directory, treat it as relative to work_root."""
        if work_root is None:
            work_root = str(self._fs_root())
        home = str(Path.home().resolve())
        raw = str(raw).strip()
        p = Path(raw)
        if p.is_absolute():
            resolved = p.resolve()
            if not str(resolved).startswith(home):
                # Model generated a wrong absolute path — strip leading / and anchor to work_root
                resolved = (Path(work_root) / raw.lstrip('/')).resolve()
        else:
            resolved = (Path(work_root) / raw).resolve()
        if not str(resolved).startswith(home):
            raise PermissionError(f'Path outside home directory is not allowed: {resolved}')
        return resolved

    def _tools_exec(self, body):
        """Execute one agent tool server-side for the chat UI. Shares the
        implementation (and path sandbox) with the pipeline worker."""
        sys.path.insert(0, str(ROOT_DIR / 'agent'))
        import worker as agent_tools
        name = (body or {}).get('name', '')
        args = (body or {}).get('args') or {}
        allowed = set((body or {}).get('allowed') or []) or None
        self._json(agent_tools.exec_tool(name, args, allowed=allowed))

    def _code_ghost_text(self, body):
        prefix = body.get('prefix', '')
        suffix = body.get('suffix', '')
        path   = body.get('path', '')
        try:
            with get_db() as db:
                rows = db.execute('SELECT key, value FROM settings').fetchall()
            cfg = {}
            for r in rows:
                try:
                    cfg[r['key']] = json.loads(r['value'])
                except Exception:
                    cfg[r['key']] = r['value']
            sys.path.insert(0, str(ROOT_DIR / 'agent'))
            import worker as agent_tools
            tier   = cfg.get('codeGhostTextTier') or 'local'
            router = agent_tools.load_router(cfg)
            provider, model, endpoint_or_key = agent_tools.resolve_llm(tier, [], router, cfg, cfg.get('endpoint', ''))
            lang = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
            prompt = (
                f'Complete the following {lang} code. Output ONLY the code that continues '
                f'at <CURSOR>, with no explanation and no markdown fences.\n\n'
                f'{prefix}<CURSOR>{suffix}'
            )
            messages = [{'role': 'user', 'content': prompt}]
            if provider == 'ollama':
                output, err = agent_tools.ollama_once(endpoint_or_key, model, messages)
            elif provider == 'anthropic':
                output, err = agent_tools.anthropic_once(endpoint_or_key, model, messages)
            else:
                output, err = None, f'Unsupported provider for ghost-text: {provider}'
            if err:
                return self._json({'completion': '', 'error': err})
            completion = (output or '').strip()
            completion = re.sub(r'^```[a-zA-Z0-9]*\n?', '', completion)
            completion = re.sub(r'\n?```$', '', completion)
            self._json({'completion': completion})
        except Exception as e:
            self._json({'completion': '', 'error': str(e)})

    def _exec_pipeline_tool(self, name, args):
        """Execute a pipeline tool call server-side, return result dict."""
        try:
            if name == 'read_file':
                p = self._pipe_path_safe(args.get('path', ''))
                return {'content': p.read_text()}
            elif name == 'write_file':
                p = self._pipe_path_safe(args.get('path', ''))
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(args.get('content', ''))
                return {'ok': True, 'path': str(p)}
            elif name == 'list_files':
                p = self._pipe_path_safe(args.get('path', str(Path.home())))
                entries = [{'name': e.name, 'type': 'dir' if e.is_dir() else 'file'}
                           for e in sorted(p.iterdir())]
                return {'entries': entries}
            elif name == 'web_search':
                results = self._web_search_core(args.get('query', ''))
                return {'results': results}
            elif name == 'web_fetch':
                content, err = self._web_fetch_core(args.get('url', ''))
                return {'content': content} if not err else {'error': err}
            else:
                return {'error': f'Unknown tool: {name}'}
        except Exception as e:
            return {'error': str(e)}

    def _web_search(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        params = urllib.parse.parse_qs(qs)
        query = params.get('q', [''])[0].strip()
        if not query:
            return self.send_error(400)
        try:
            results = self._web_search_core(query)
            self._json({'query': query, 'results': results})
        except Exception as e:
            self._json({'query': query, 'results': [], 'error': str(e)})

    def _web_fetch(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        params = urllib.parse.parse_qs(qs)
        url = params.get('url', [''])[0].strip()
        if not url:
            return self.send_error(400)
        try:
            content, err = self._web_fetch_core(url)
            if err:
                self._json({'url': url, 'content': '', 'error': err})
            else:
                self._json({'url': url, 'content': content})
        except Exception as e:
            self._json({'url': url, 'content': '', 'error': str(e)})

    # ── Models (Ollama library) ──────────────────────────────────────────────

    def _models_endpoint(self, host_id=None):
        if host_id:
            with get_db() as db:
                row = db.execute(
                    'SELECT ip, ollama_port FROM network_hosts WHERE id=?', (host_id,)
                ).fetchone()
            if row:
                return f"http://{row['ip']}:{row['ollama_port']}"
        raw = None
        try:
            with get_db() as db:
                row = db.execute("SELECT value FROM settings WHERE key='endpoint'").fetchone()
            if row and row['value']:
                ep = json.loads(row['value'])
                if isinstance(ep, str) and ep.strip():
                    raw = ep.strip()
        except Exception:
            pass
        return resolve_ollama_endpoint(raw)

    def _models_local(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        host_id = urllib.parse.parse_qs(qs).get('host_id', [''])[0].strip()
        try:
            with urllib.request.urlopen(f'{self._models_endpoint(host_id)}/api/tags', timeout=10) as resp:
                self._json(json.loads(resp.read()))
        except Exception as e:
            self._json({'models': [], 'error': str(e)}, 502)

    def _local_sysinfo(self):
        """Direct probe of the machine server.py runs on — no SSH involved."""
        ram_gb = vram_gb = 0.0
        try:
            if sys.platform == 'darwin':
                out = subprocess.run(['sysctl', '-n', 'hw.memsize'],
                                     capture_output=True, text=True, timeout=5)
                ram_gb = int(out.stdout.strip()) / 1e9
                if platform.machine() == 'arm64':
                    vram_gb = ram_gb   # Apple Silicon unified memory
            else:
                with open('/proc/meminfo') as f:
                    for line in f:
                        if line.startswith('MemTotal:'):
                            ram_gb = int(line.split()[1]) * 1024 / 1e9
                            break
        except Exception:
            pass
        if not vram_gb:
            try:
                out = subprocess.run(
                    ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
                    capture_output=True, text=True, timeout=5)
                if out.returncode == 0:
                    vram_gb = sum(float(x) for x in out.stdout.split()) * 1024**2 / 1e9
            except Exception:
                pass
        try:
            disk_free_gb = shutil.disk_usage('/').free / 1e9
        except Exception:
            disk_free_gb = 0.0
        return {'ram_gb': round(ram_gb, 1), 'vram_gb': round(vram_gb, 1),
                'disk_free_gb': round(disk_free_gb, 1), 'live': True,
                'os': None, 'gpu_arch': None}

    def _models_sysinfo(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        host_id = urllib.parse.parse_qs(qs).get('host_id', [''])[0].strip()
        if not host_id:
            # "Auto" should reflect the same reachable-host resolution chat/
            # pipelines use (settings.endpoint, kept in sync with the Hosts
            # section's enabled/priority ordering by regenerate_ollama_endpoint_setting()),
            # not always probe whatever machine server.py happens to run on.
            ip = urllib.parse.urlparse(self._models_endpoint('')).hostname
            with get_db() as db:
                row = db.execute(
                    'SELECT id FROM network_hosts WHERE ip=?', (ip,)
                ).fetchone()
            if row:
                host_id = row['id']
        if host_id:
            with get_db() as db:
                row = db.execute(
                    'SELECT ip, ssh_user, os, gpu_arch FROM network_hosts WHERE id=?',
                    (host_id,)
                ).fetchone()
            if not row:
                return self._json({'ram_gb': 0.0, 'vram_gb': 0.0, 'disk_free_gb': 0.0,
                                    'live': False, 'os': None, 'gpu_arch': None})
            if row['ip'] in local_ips():
                # This host entry is the machine server.py runs on — probe it
                # directly instead of SSHing to ourselves.
                return self._json(self._local_sysinfo())
            probe = probe_host_sysinfo(row['ip'], row['ssh_user'], row['os'], row['gpu_arch'])
            return self._json({'ram_gb': probe['ram_gb'], 'vram_gb': probe['vram_gb'],
                               'disk_free_gb': 0.0, 'live': probe['live'],
                               'os': row['os'], 'gpu_arch': row['gpu_arch']})
        self._json(self._local_sysinfo())

    def _hub_fetch(self, url):
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
            'Accept': 'text/html', 'Accept-Encoding': 'identity',
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read(2 * 1024 * 1024).decode('utf-8', errors='replace')

    def _models_search(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        params = urllib.parse.parse_qs(qs)
        q    = params.get('q', [''])[0].strip()
        page = params.get('p', ['1'])[0]
        cap  = params.get('c', [''])[0].strip()
        sort = params.get('o', [''])[0].strip()
        hub_params = {'q': q, 'p': page}
        if cap:
            hub_params['c'] = cap
        if sort == 'newest':  # only value the hub honours; default is "featured"
            hub_params['o'] = sort
        try:
            html = self._hub_fetch('https://ollama.com/search?' +
                                   urllib.parse.urlencode(hub_params))
        except Exception as e:
            return self._json({'query': q, 'models': [], 'error': str(e)}, 502)
        models = []
        for card in re.findall(r'<li x-test-model.*?</li>', html, re.DOTALL):
            name = re.search(r'x-test-search-response-title>([^<]+)<', card)
            if not name:
                continue
            desc  = re.search(r'<p class="max-w-lg break-words[^"]*">(.*?)</p>', card, re.DOTALL)
            pulls = re.search(r'x-test-pull-count>([^<]+)<', card)
            models.append({
                'name':         name.group(1).strip(),
                'description':  re.sub(r'<[^>]+>', '', desc.group(1)).strip() if desc else '',
                'sizes':        [s.strip() for s in re.findall(r'x-test-size[^>]*>([^<]+)<', card)],
                'capabilities': [c.strip() for c in re.findall(r'x-test-capability[^>]*>([^<]+)<', card)],
                'pulls':        pulls.group(1).strip() if pulls else '',
            })
        self._json({'query': q, 'page': int(page or 1), 'models': models})

    def _models_tags(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        name = urllib.parse.parse_qs(qs).get('name', [''])[0].strip()
        if not name:
            return self.send_error(400)
        try:
            html = self._hub_fetch(f'https://ollama.com/library/{urllib.parse.quote(name)}/tags')
        except Exception as e:
            return self._json({'name': name, 'tags': [], 'error': str(e)}, 502)
        tags, seen = [], set()
        pat = re.compile(r'href="/library/([^"]+:[^"]+)"(.*?)</a>', re.DOTALL)
        for tag_name, block in pat.findall(html):
            if tag_name in seen:
                continue
            seen.add(tag_name)
            size = re.search(r'([\d.]+)\s*(GB|MB)\b', block)
            ctx  = re.search(r'([\d.]+[KM]?)\s*context window', block)
            size_gb = None
            if size:
                size_gb = float(size.group(1)) / (1 if size.group(2) == 'GB' else 1000)
            tags.append({'tag': tag_name, 'size_gb': size_gb,
                         'context': ctx.group(1) if ctx else ''})
        self._json({'name': name, 'tags': tags})

    def _models_pull(self, body):
        name = (body.get('name') or '').strip()
        host_id = (body.get('hostId') or '').strip()
        if not name:
            return self.send_error(400)
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Cache-Control', 'no-cache')
        self._cors()
        self.end_headers()
        try:
            req = urllib.request.Request(
                f'{self._models_endpoint(host_id)}/api/pull',
                data=json.dumps({'model': name, 'stream': True}).encode(),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=3600) as resp:
                for raw in resp:
                    line = raw.strip()
                    if line:
                        self.wfile.write(line + b'\n')
                        self.wfile.flush()
        except Exception as e:
            try:
                self.wfile.write(json.dumps({'error': str(e)}).encode() + b'\n')
                self.wfile.flush()
            except Exception:
                pass

    def _models_delete(self):
        qs = self.path.split('?', 1)[-1] if '?' in self.path else ''
        params = urllib.parse.parse_qs(qs)
        name = params.get('name', [''])[0].strip()
        host_id = params.get('host_id', [''])[0].strip()
        if not name:
            return self.send_error(400)
        try:
            req = urllib.request.Request(
                f'{self._models_endpoint(host_id)}/api/delete',
                data=json.dumps({'model': name}).encode(),
                headers={'Content-Type': 'application/json'}, method='DELETE')
            with urllib.request.urlopen(req, timeout=30):
                pass
            self._json({'ok': True})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    # ── Helpers ──────────────────────────────────────────────────────────────

    # ── Filesystem API ──────────────────────────────────────────────────────────

    def _fs_root(self):
        with get_db() as db:
            row = db.execute('SELECT root_path FROM code_sessions WHERE id=?', ('default',)).fetchone()
        return Path(row['root_path']) if row and row['root_path'] else Path.home()

    def _fs_safe(self, rel, root=None):
        if root is None:
            root = self._fs_root()
        # Check containment on the lexical (un-resolved) path so a symlink anywhere under home
        # (e.g. ~/library pointing at a mounted drive) is allowed to point outside home; only
        # collapse '..' components (no filesystem/symlink access) before the containment check.
        candidate = Path(rel) if str(rel).startswith('/') else (root / rel)
        candidate = Path(os.path.normpath(str(candidate)))
        home = Path.home()
        try:
            candidate.relative_to(os.path.normpath(str(home)))
        except ValueError:
            raise PermissionError(f'Path outside home directory: {candidate}')
        return candidate.resolve()

    def _fs_list(self):
        qs   = dict(pair.split('=', 1) for pair in self.path.split('?', 1)[1].split('&')) if '?' in self.path else {}
        rel  = urllib.parse.unquote(qs.get('path', ''))
        try:
            p = self._fs_safe(rel)
            if not p.exists():
                return self._json({'error': 'Not found'}, 404)
            if p.is_file():
                return self._json({'type': 'file', 'path': rel})
            entries = []
            for child in sorted(p.iterdir(), key=lambda c: (c.is_file(), c.name.lower())):
                if child.name.startswith('.'):
                    continue
                entries.append({'name': child.name, 'type': 'dir' if child.is_dir() else 'file',
                                'size': child.stat().st_size if child.is_file() else None})
            self._json({'path': rel, 'entries': entries})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    def _fs_read(self):
        qs  = dict(pair.split('=', 1) for pair in self.path.split('?', 1)[1].split('&')) if '?' in self.path else {}
        rel = urllib.parse.unquote(qs.get('path', ''))
        try:
            p = self._fs_safe(rel)
            if not p.is_file():
                return self._json({'error': 'Not a file'}, 400)
            content = p.read_text(errors='replace')
            self._json({'path': rel, 'content': content})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    def _fs_write(self, body):
        rel     = body.get('path', '')
        content = body.get('content', '')
        try:
            p = self._fs_safe(rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            self._json({'ok': True, 'path': rel})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    def _fs_mkdir(self, body):
        rel = body.get('path', '')
        try:
            p = self._fs_safe(rel)
            p.mkdir(parents=True, exist_ok=True)
            self._json({'ok': True, 'path': rel})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    def _fs_rename(self, body):
        src = body.get('from', '')
        dst = body.get('to', '')
        try:
            ps = self._fs_safe(src)
            pd = self._fs_safe(dst)
            ps.rename(pd)
            self._json({'ok': True})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    def _fs_delete(self):
        qs  = dict(pair.split('=', 1) for pair in self.path.split('?', 1)[1].split('&')) if '?' in self.path else {}
        rel = urllib.parse.unquote(qs.get('path', ''))
        try:
            import shutil
            p = self._fs_safe(rel)
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
            self._json({'ok': True})
        except Exception as e:
            self._json({'error': str(e)}, 400)

    # ── Code session ────────────────────────────────────────────────────────────

    def _get_code_session(self):
        with get_db() as db:
            row = db.execute('SELECT * FROM code_sessions WHERE id=?', ('default',)).fetchone()
        s = row_to_dict(row) if row else {}
        if 'open_files' in s:
            try:
                s['open_files'] = json.loads(s['open_files'])
            except Exception:
                s['open_files'] = []
        self._json(s)

    def _put_code_session(self, body):
        now = datetime.datetime.now().isoformat()
        root_path = body.get('rootPath') or str(Path.home())
        if body.get('rootPath'):
            try:
                p = self._fs_safe(body['rootPath'])
            except Exception as e:
                return self._json({'error': str(e)}, 400)
            if not p.is_dir():
                return self._json({'error': f'Not a directory: {p}'}, 400)
            root_path = str(p)
            try:
                _write_config_root_path(root_path)
            except Exception as e:
                return self._json({'error': f'Could not persist root path: {e}'}, 500)
        with get_db() as db:
            db.execute('''
                INSERT INTO code_sessions (id, root_path, open_files, active_file, updated_at)
                VALUES ('default', ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    root_path=excluded.root_path,
                    open_files=excluded.open_files,
                    active_file=excluded.active_file,
                    updated_at=excluded.updated_at
            ''', (
                root_path,
                json.dumps(body.get('openFiles', [])),
                body.get('activeFile'),
                now,
            ))
        self._json({'ok': True})

    def _get_code_layouts(self):
        with get_db() as db:
            rows = rows_to_list(db.execute('SELECT name, panes_json FROM code_layouts ORDER BY name').fetchall())
        self._json([{'name': r['name'], 'panes': json.loads(r['panes_json'])} for r in rows])

    def _post_code_layout(self, body):
        name = (body.get('name') or '').strip()
        if not name:
            return self._json({'error': 'name required'}, 400)
        now = datetime.datetime.now().isoformat()
        with get_db() as db:
            db.execute(
                'INSERT INTO code_layouts (name, panes_json, updated_at) VALUES (?,?,?) '
                'ON CONFLICT(name) DO UPDATE SET panes_json=excluded.panes_json, updated_at=excluded.updated_at',
                (name, json.dumps(body.get('panes', [])), now)
            )
        self._json({'ok': True})

    def _delete_code_layout(self, name):
        with get_db() as db:
            db.execute('DELETE FROM code_layouts WHERE name=?', (name,))
        self._json({'ok': True})

    def _get_code_layout_state(self):
        with get_db() as db:
            row = db.execute('SELECT * FROM code_layout_state WHERE id=?', ('default',)).fetchone()
        if not row:
            return self._json({'currentLayoutName': None, 'panes': [], 'preferredWidths': {}})
        self._json({
            'currentLayoutName': row['current_layout_name'],
            'panes': json.loads(row['panes_json'] or '[]'),
            'preferredWidths': json.loads(row['preferred_widths_json'] or '{}'),
        })

    def _put_code_layout_state(self, body):
        now = datetime.datetime.now().isoformat()
        with get_db() as db:
            db.execute('''
                INSERT INTO code_layout_state (id, current_layout_name, panes_json, preferred_widths_json, updated_at)
                VALUES ('default', ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    current_layout_name=excluded.current_layout_name,
                    panes_json=excluded.panes_json,
                    preferred_widths_json=excluded.preferred_widths_json,
                    updated_at=excluded.updated_at
            ''', (
                body.get('currentLayoutName'),
                json.dumps(body.get('panes', [])),
                json.dumps(body.get('preferredWidths', {})),
                now,
            ))
        self._json({'ok': True})

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length)
        ct = self.headers.get('Content-Type', '')
        if 'json' in ct:
            return json.loads(raw) if raw else {}
        return raw  # bytes for text/plain (plans)

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        if '/api/' in self.path:
            super().log_message(fmt, *args)


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    with http.server.ThreadingHTTPServer(('', PORT), Handler) as srv:
        if CERT_FILE.exists() and KEY_FILE.exists():
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))
            srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
            print(f'Ollama UI  →  https://localhost:{PORT}')
        else:
            print(f'Ollama UI  →  http://localhost:{PORT}')
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print('\n[server] Stopped')
