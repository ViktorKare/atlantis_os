#!/usr/bin/env python3
"""Atlantis OS — process supervisor. Run with: python3 launcher.py
Control mode: python3 launcher.py --start | --stop | --restart
"""
import json, os, shutil, signal, socket, subprocess, sys, time
from pathlib import Path

from logging_setup import setup_logging, install_crash_handler

logger = setup_logging('launcher')
install_crash_handler('launcher', logger)

ROOT_DIR     = Path(__file__).parent
DATA_DIR     = ROOT_DIR / 'data'
CONFIG_FILE  = ROOT_DIR / 'atlantis.config.json'
PID_FILE     = DATA_DIR / 'launcher.pid'
RESTART_FLAG = DATA_DIR / '.restart'
STOP_FLAG    = DATA_DIR / '.stop'
LOG_FILE     = DATA_DIR / 'launcher.log'
OLLAMA_DIR   = DATA_DIR / 'ollama'
OLLAMA_BIN   = OLLAMA_DIR / 'bin' / 'ollama'
CODE_SERVER_DIR = DATA_DIR / 'code-server'
CODE_SERVER_BIN = CODE_SERVER_DIR / 'bin' / 'code-server'
CERT_FILE       = DATA_DIR / 'certs' / 'cert.pem'
KEY_FILE        = DATA_DIR / 'certs' / 'key.pem'

_children = {}


# Only checks PID existence, not process identity — a sufficiently rare
# PID-reuse race could produce a false "already running." Accepted tradeoff:
# a portable identity check isn't available in stdlib across all three OSes.
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


def code_server_cmd():
    bin_path = str(CODE_SERVER_BIN) if CODE_SERVER_BIN.exists() else shutil.which('code-server')
    if not bin_path:
        return None
    cmd = [bin_path, '--bind-addr', '0.0.0.0:5001', '--auth', 'none']
    if CERT_FILE.exists() and KEY_FILE.exists():
        cmd += ['--cert', str(CERT_FILE), '--cert-key', str(KEY_FILE)]
    return cmd


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
        env['OLLAMA_ORIGINS'] = '*'
        _children['ollama'] = subprocess.Popen(
            [str(OLLAMA_BIN), 'serve'], stdout=log, stderr=log, env=env)
    if sys.platform != 'win32':
        cmd = code_server_cmd()
        if cmd and not port_open('127.0.0.1', 5001):
            _children['code_server'] = subprocess.Popen(cmd, stdout=log, stderr=log)


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
                env['OLLAMA_ORIGINS'] = '*'
                _children[name] = subprocess.Popen(
                    [str(OLLAMA_BIN), 'serve'], stdout=log, stderr=log, env=env)
            elif name == 'code_server':
                cmd = code_server_cmd()
                if cmd:
                    _children[name] = subprocess.Popen(cmd, stdout=log, stderr=log)


def run_supervisor():
    existing = read_pid()
    if existing and is_alive(existing):
        logger.info(f'Supervisor already running (pid {existing}).')
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))
    if STOP_FLAG.exists():
        STOP_FLAG.unlink()
    if RESTART_FLAG.exists():
        RESTART_FLAG.unlink()

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
            logger.info('Stop requested.')
        else:
            logger.info('Not running.')
    elif mode == 'restart':
        if alive:
            RESTART_FLAG.touch()
            logger.info('Restart requested.')
        else:
            spawn_detached([sys.executable, str(ROOT_DIR / 'launcher.py')])
            logger.info(f'Not running — starting fresh. Open http://localhost:{config_port()}')
    elif mode == 'start':
        if alive:
            if port_open('127.0.0.1', config_port()):
                logger.info('Already running.')
            else:
                RESTART_FLAG.touch()
                logger.info(f'Supervisor was running but stopped — restarting children. Open http://localhost:{config_port()}')
        else:
            spawn_detached([sys.executable, str(ROOT_DIR / 'launcher.py')])
            logger.info(f'Started. Open http://localhost:{config_port()}')


if __name__ == '__main__':
    if '--stop' in sys.argv:
        control('stop')
    elif '--restart' in sys.argv:
        control('restart')
    elif '--start' in sys.argv:
        control('start')
    else:
        run_supervisor()
