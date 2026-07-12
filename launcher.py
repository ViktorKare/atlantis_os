#!/usr/bin/env python3
"""Atlantis OS — process supervisor. Run with: python3 launcher.py
Control mode: python3 launcher.py --start | --stop | --restart
"""
import json, os, signal, socket, subprocess, sys, time
from pathlib import Path

ROOT_DIR     = Path(__file__).parent
DATA_DIR     = ROOT_DIR / 'data'
CONFIG_FILE  = ROOT_DIR / 'atlantis.config.json'
PID_FILE     = DATA_DIR / 'launcher.pid'
RESTART_FLAG = DATA_DIR / '.restart'
STOP_FLAG    = DATA_DIR / '.stop'
LOG_FILE     = DATA_DIR / 'launcher.log'
OLLAMA_DIR   = DATA_DIR / 'ollama'
OLLAMA_BIN   = OLLAMA_DIR / 'bin' / 'ollama'

_children = {}


def is_alive(pid):
    if sys.platform == 'win32':
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}'], capture_output=True, text=True)
        return str(pid) in out.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_pid():
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text().strip())
    except ValueError:
        return None


def config_port():
    try:
        return json.loads(CONFIG_FILE.read_text()).get('port', 5000)
    except (OSError, json.JSONDecodeError):
        return 5000


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def spawn_detached(args):
    kwargs = {}
    if sys.platform == 'win32':
        kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs['start_new_session'] = True
    return subprocess.Popen(args, **kwargs)


def start_children():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_FILE, 'a')
    _children['server'] = subprocess.Popen(
        [sys.executable, str(ROOT_DIR / 'server' / 'server.py')],
        stdout=log, stderr=log)
    _children['worker'] = subprocess.Popen(
        [sys.executable, str(ROOT_DIR / 'agent' / 'worker.py')],
        stdout=log, stderr=log)
    if sys.platform.startswith('linux') and OLLAMA_BIN.exists() and not port_open('127.0.0.1', 11434):
        env = dict(os.environ)
        env['OLLAMA_MODELS'] = str(OLLAMA_DIR / 'models')
        _children['ollama'] = subprocess.Popen(
            [str(OLLAMA_BIN), 'serve'], stdout=log, stderr=log, env=env)


def stop_children():
    for name, proc in list(_children.items()):
        if proc.poll() is None:
            proc.terminate()
    deadline = time.time() + 10
    for name, proc in list(_children.items()):
        remaining = max(0, deadline - time.time())
        try:
            proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            proc.kill()
    _children.clear()


def restart_dead_children():
    for name in list(_children):
        proc = _children[name]
        if proc.poll() is not None:
            time.sleep(3)  # mirrors systemd's RestartSec=3 backoff
            log = open(LOG_FILE, 'a')
            if name == 'server':
                _children[name] = subprocess.Popen(
                    [sys.executable, str(ROOT_DIR / 'server' / 'server.py')],
                    stdout=log, stderr=log)
            elif name == 'worker':
                _children[name] = subprocess.Popen(
                    [sys.executable, str(ROOT_DIR / 'agent' / 'worker.py')],
                    stdout=log, stderr=log)
            elif name == 'ollama':
                env = dict(os.environ)
                env['OLLAMA_MODELS'] = str(OLLAMA_DIR / 'models')
                _children[name] = subprocess.Popen(
                    [str(OLLAMA_BIN), 'serve'], stdout=log, stderr=log, env=env)


def run_supervisor():
    existing = read_pid()
    if existing and is_alive(existing):
        print(f'Supervisor already running (pid {existing}).')
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))

    def _on_term(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _on_term)
    start_children()
    suppressed = False
    try:
        while True:
            time.sleep(1)
            if STOP_FLAG.exists():
                STOP_FLAG.unlink()
                stop_children()
                suppressed = True
            if suppressed:
                if RESTART_FLAG.exists():
                    RESTART_FLAG.unlink()
                    start_children()
                    suppressed = False
                continue
            if RESTART_FLAG.exists():
                RESTART_FLAG.unlink()
                stop_children()
                start_children()
                continue
            restart_dead_children()
    except KeyboardInterrupt:
        pass
    finally:
        stop_children()
        if PID_FILE.exists():
            PID_FILE.unlink()


def control(mode):
    pid = read_pid()
    alive = pid is not None and is_alive(pid)
    if mode == 'stop':
        if alive:
            STOP_FLAG.touch()
            print('Stop requested.')
        else:
            print('Not running.')
    elif mode == 'restart':
        if alive:
            RESTART_FLAG.touch()
            print('Restart requested.')
        else:
            spawn_detached([sys.executable, str(ROOT_DIR / 'launcher.py')])
            print(f'Not running — starting fresh. Open http://localhost:{config_port()}')
    elif mode == 'start':
        if alive:
            print('Already running.')
        else:
            spawn_detached([sys.executable, str(ROOT_DIR / 'launcher.py')])
            print(f'Started. Open http://localhost:{config_port()}')


if __name__ == '__main__':
    if '--stop' in sys.argv:
        control('stop')
    elif '--restart' in sys.argv:
        control('restart')
    elif '--start' in sys.argv:
        control('start')
    else:
        run_supervisor()
