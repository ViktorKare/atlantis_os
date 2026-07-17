"""Shared logging + crash-report setup for launcher.py, server/server.py, agent/worker.py.

Each process calls setup_logging(name) once at startup to get a rotating,
leveled log file under data/logs/<name>.log (mirrored to stdout), then
install_crash_handler(name, logger) to have any uncaught exception (main
thread or otherwise) also land as its own file under data/logs/crashes/.
"""
import logging
import logging.handlers
import os
import platform
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).parent
LOG_DIR = ROOT_DIR / 'data' / 'logs'
CRASH_DIR = LOG_DIR / 'crashes'


def setup_logging(name):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', '%Y-%m-%d %H:%M:%S')

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_DIR / f'{name}.log', maxBytes=5_000_000, backupCount=3, encoding='utf-8')
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    # Windows consoles often default to a legacy codepage (e.g. cp1252) that can't
    # encode characters like → or —, which otherwise crashes the whole process on
    # the first log line that contains one. Swap in 'replace' error handling so an
    # unencodable character degrades to '?' instead of raising.
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(errors='replace')
        except (ValueError, OSError):
            pass

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    return logger


def _write_crash_file(name, exc_type, exc_value, exc_tb):
    CRASH_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now()
    path = CRASH_DIR / f'{name}-{ts.strftime("%Y%m%d-%H%M%S")}.log'
    tb_text = ''.join(traceback.format_exception(exc_type, exc_value, exc_tb))
    path.write_text(
        f'=== CRASH: {name} ===\n'
        f'Time:     {ts.isoformat()}\n'
        f'PID:      {os.getpid()}\n'
        f'Python:   {platform.python_version()}\n'
        f'Platform: {platform.platform()}\n\n'
        f'{tb_text}'
    )
    return path


def install_crash_handler(name, logger):
    def handle_exception(exc_type, exc_value, exc_tb):
        logger.critical('Uncaught exception', exc_info=(exc_type, exc_value, exc_tb))
        _write_crash_file(name, exc_type, exc_value, exc_tb)
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    def handle_thread_exception(args):
        logger.critical('Uncaught exception in thread %s', args.thread.name,
                         exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
        _write_crash_file(name, args.exc_type, args.exc_value, args.exc_traceback)

    sys.excepthook = handle_exception
    threading.excepthook = handle_thread_exception
