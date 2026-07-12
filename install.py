#!/usr/bin/env python3
"""Atlantis OS — first-time setup wizard. Run with: python3 install.py"""
import json, platform, shutil, socket, subprocess, sys, tarfile, tempfile, time, urllib.request, zipfile
from pathlib import Path

ROOT_DIR    = Path(__file__).parent
DATA_DIR    = ROOT_DIR / 'data'
CONFIG_FILE = ROOT_DIR / 'atlantis.config.json'

OLLAMA_MACOS_URL   = 'https://ollama.com/download/Ollama-darwin.zip'
OLLAMA_WINDOWS_URL = 'https://ollama.com/download/OllamaSetup.exe'
OLLAMA_LINUX_URL   = 'https://ollama.com/download/ollama-linux-amd64.tgz'

WELCOME_TEXT = """
Atlantis OS — a local AI workspace that runs entirely on your machine,
backed by Ollama. This wizard will ask a couple of questions, then get
everything running.
"""

CLOSING_TEXT = """
Atlantis is installed and starting now.

  Open:    http://localhost:{port}
  Start:   double-click start.sh / start.command / start.bat in this folder
  Stop:    stop.sh / stop.command / stop.bat
  Restart: restart.sh / restart.command / restart.bat

Once it's open, go to the Models tab and install a model sized for your
hardware (look for the fit badges).
"""


def detect_os():
    return {'Darwin': 'macos', 'Windows': 'windows', 'Linux': 'linux'}.get(platform.system(), 'linux')


def ask(prompt, default_yes=True):
    suffix = ' [Y/n] ' if default_yes else ' [y/N] '
    ans = input(prompt + suffix).strip().lower()
    if not ans:
        return default_yes
    return ans in ('y', 'yes')


def ollama_responds():
    try:
        with socket.create_connection(('127.0.0.1', 11434), timeout=1.5):
            return True
    except OSError:
        return False


def install_ollama_macos():
    print('Downloading Ollama for macOS...')
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = Path(tmp) / 'Ollama-darwin.zip'
        urllib.request.urlretrieve(OLLAMA_MACOS_URL, zip_path)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        apps_dir = Path.home() / 'Applications'
        apps_dir.mkdir(exist_ok=True)
        app_dest = apps_dir / 'Ollama.app'
        if app_dest.exists():
            shutil.rmtree(app_dest)
        shutil.move(str(Path(tmp) / 'Ollama.app'), str(app_dest))
        subprocess.Popen(['open', str(app_dest)])


def install_ollama_windows():
    print('Downloading Ollama for Windows...')
    with tempfile.TemporaryDirectory() as tmp:
        exe_path = Path(tmp) / 'OllamaSetup.exe'
        urllib.request.urlretrieve(OLLAMA_WINDOWS_URL, exe_path)
        subprocess.run([str(exe_path), '/SILENT'], check=True)


def install_ollama_linux_tarball():
    print('Downloading Ollama (Linux, no-root install)...')
    ollama_dir = DATA_DIR / 'ollama'
    ollama_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tgz_path = Path(tmp) / 'ollama-linux-amd64.tgz'
        urllib.request.urlretrieve(OLLAMA_LINUX_URL, tgz_path)
        with tarfile.open(tgz_path) as tf:
            tf.extractall(ollama_dir)
    bin_path = ollama_dir / 'bin' / 'ollama'
    if bin_path.exists():
        bin_path.chmod(0o755)


def setup_ollama(os_name):
    if ollama_responds():
        print('Ollama is already running — skipping install.')
        return
    if os_name == 'macos':
        if (Path('/Applications/Ollama.app').exists() or (Path.home() / 'Applications' / 'Ollama.app').exists()):
            print('Ollama.app is already installed — please open it, then continue.')
            return
        try:
            install_ollama_macos()
        except Exception as e:
            print(f'Ollama install failed: {e}. Atlantis will still install — retry from Settings later.')
            return
    elif os_name == 'windows':
        try:
            install_ollama_windows()
        except Exception as e:
            print(f'Ollama install failed: {e}. Atlantis will still install — retry from Settings later.')
            return
    else:
        try:
            install_ollama_linux_tarball()
        except Exception as e:
            print(f'Ollama install failed: {e}. Atlantis will still install — retry from Settings later.')
            return
    for _ in range(20):
        if ollama_responds():
            print('Ollama is up.')
            return
        time.sleep(1)
    print('Ollama installed but not responding yet — it will start alongside Atlantis.')


def register_autostart_macos():
    label = 'com.atlantis.launcher'
    plist_dir = Path.home() / 'Library' / 'LaunchAgents'
    plist_dir.mkdir(parents=True, exist_ok=True)
    plist_path = plist_dir / f'{label}.plist'
    plist_path.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{sys.executable}</string>
        <string>{ROOT_DIR / "launcher.py"}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>StandardOutPath</key><string>{DATA_DIR / "launcher.log"}</string>
    <key>StandardErrorPath</key><string>{DATA_DIR / "launcher.log"}</string>
</dict>
</plist>
''')
    subprocess.run(['launchctl', 'load', str(plist_path)], capture_output=True)


def register_autostart_linux():
    unit_dir = Path.home() / '.config' / 'systemd' / 'user'
    unit_dir.mkdir(parents=True, exist_ok=True)
    unit_path = unit_dir / 'atlantis-launcher.service'
    unit_path.write_text(f'''[Unit]
Description=Atlantis OS Launcher

[Service]
Type=simple
WorkingDirectory={ROOT_DIR}
ExecStart={sys.executable} {ROOT_DIR / "launcher.py"}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
''')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'atlantis-launcher.service'], capture_output=True)


def register_autostart_windows():
    cmd = [
        'schtasks', '/Create', '/SC', 'ONLOGON', '/TN', 'AtlantisLauncher',
        '/TR', f'"{sys.executable}" "{ROOT_DIR / "launcher.py"}"',
        '/RL', 'LIMITED', '/F',
    ]
    subprocess.run(cmd, check=True)


def register_autostart(os_name):
    try:
        if os_name == 'macos':
            register_autostart_macos()
        elif os_name == 'linux':
            register_autostart_linux()
        elif os_name == 'windows':
            register_autostart_windows()
    except Exception as e:
        print(f'Autostart registration failed: {e}. You can start Atlantis manually with start.sh/start.command/start.bat.')


def main():
    print(WELCOME_TEXT)
    os_name = detect_os()
    print(f'Detected OS: {os_name}')

    default_root = str(Path.home())
    root_path = input(f'Which folder should Atlantis be able to read/edit as its workspace? [{default_root}] ').strip() or default_root

    if ask('Auto-install Ollama?', default_yes=True):
        setup_ollama(os_name)

    print('\nAtlantis is installed. Start it anytime by double-clicking')
    print('start.bat/start.command/start.sh in this folder — it opens')
    print('http://localhost:5000. stop.* and restart.* work the same way.\n')

    autostart = ask('Also start automatically when you log in?', default_yes=True)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    config = {'port': 5000, 'root_path': root_path}
    CONFIG_FILE.write_text(json.dumps(config, indent=2))

    sys.path.insert(0, str(ROOT_DIR / 'server'))
    import server as server_module
    server_module.init_db()

    if autostart:
        register_autostart(os_name)

    subprocess.Popen([sys.executable, str(ROOT_DIR / 'launcher.py')],
                      start_new_session=(sys.platform != 'win32'))

    print(CLOSING_TEXT.format(port=config['port']))


if __name__ == '__main__':
    main()
