#!/usr/bin/env python3
"""Atlantis OS — first-time setup wizard. Run with: python3 install.py"""
import json, os, platform, shutil, socket, subprocess, sys, tarfile, tempfile, time, urllib.request, zipfile
from pathlib import Path

ROOT_DIR    = Path(__file__).parent
DATA_DIR    = ROOT_DIR / 'data'
CONFIG_FILE = ROOT_DIR / 'atlantis.config.json'

OLLAMA_MACOS_URL   = 'https://ollama.com/download/Ollama-darwin.zip'
OLLAMA_WINDOWS_URL = 'https://ollama.com/download/OllamaSetup.exe'
OLLAMA_LINUX_URL   = 'https://ollama.com/download/ollama-linux-amd64.tar.zst'

CODE_SERVER_INSTALL_URL = 'https://code-server.dev/install.sh'
CODE_SERVER_DIR         = DATA_DIR / 'code-server'
CODE_SERVER_BIN         = CODE_SERVER_DIR / 'bin' / 'code-server'

CERT_DIR  = DATA_DIR / 'certs'
CERT_FILE = CERT_DIR / 'cert.pem'
KEY_FILE  = CERT_DIR / 'key.pem'


def local_ipv4s():
    """LAN IPv4 addresses for this machine, for the cert's subjectAltName —
    mirrors server.py's local_ips() UDP-connect trick (no packets sent, just
    asks the OS which interface would be used for outbound traffic)."""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ':' not in ip:
                ips.add(ip)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    ips.discard('127.0.0.1')
    return sorted(ips)

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


def setup_https_certs(os_name):
    if CERT_FILE.exists() and KEY_FILE.exists():
        print('HTTPS cert already present — skipping.')
        return
    if os_name == 'windows':
        print('HTTPS setup skipped on Windows (no bundled openssl). Atlantis will run on plain HTTP.')
        return
    openssl_bin = shutil.which('openssl')
    if not openssl_bin:
        print('HTTPS setup skipped: openssl not found on PATH. Atlantis will run on plain HTTP.')
        return
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    san_entries = ['DNS:localhost', 'IP:127.0.0.1'] + [f'IP:{ip}' for ip in local_ipv4s()]
    try:
        subprocess.run([
            openssl_bin, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
            '-keyout', str(KEY_FILE), '-out', str(CERT_FILE),
            '-subj', '/CN=atlantis',
            '-addext', 'subjectAltName=' + ','.join(san_entries),
        ], check=True, capture_output=True)
    except Exception as e:
        print(f'HTTPS cert generation failed: {e}. Atlantis will run on plain HTTP.')
        KEY_FILE.unlink(missing_ok=True)
        CERT_FILE.unlink(missing_ok=True)
        return
    KEY_FILE.chmod(0o600)
    print(f'HTTPS cert generated, covering: {", ".join(san_entries)}')


def code_server_responds():
    try:
        with socket.create_connection(('127.0.0.1', 5001), timeout=1.5):
            return True
    except OSError:
        return False


def setup_code_server(os_name):
    if os_name == 'windows':
        print('code-server setup skipped on Windows (official support is WSL-only).')
        return
    if code_server_responds():
        print('code-server is already running — skipping install.')
        return
    if shutil.which('code-server') or CODE_SERVER_BIN.exists():
        print('code-server is already installed — skipping install.')
        return
    print('Installing code-server (no-root, standalone)...')
    CODE_SERVER_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            script_path = Path(tmp) / 'install-code-server.sh'
            # raw.githubusercontent.com (code-server.dev/install.sh redirects
            # there) 403s Python's default urllib User-Agent.
            req = urllib.request.Request(CODE_SERVER_INSTALL_URL, headers={'User-Agent': 'atlantis-installer'})
            with urllib.request.urlopen(req) as resp:
                script_path.write_bytes(resp.read())
            subprocess.run(
                ['sh', str(script_path), '--method=standalone', f'--prefix={CODE_SERVER_DIR}'],
                check=True)
    except Exception as e:
        print(f'code-server install failed: {e}. Atlantis will still install — re-run install.py later to retry.')
        return
    if CODE_SERVER_BIN.exists():
        print('code-server installed.')
    else:
        print('code-server install script finished but binary not found at the expected path — check data/code-server/ manually.')


def configure_ollama_origins_macos():
    """Same origin-allowlist issue as configure_ollama_origins_windows(), but
    Ollama.app is a GUI app with its own login-item autostart outside
    Atlantis's control — a shell profile env var wouldn't reach it, since GUI
    apps inherit their environment from the user's launchd session instead.
    `launchctl setenv` fixes that for the current session; the LaunchAgent
    reapplies it at every login so it survives a reboot."""
    try:
        subprocess.run(['launchctl', 'setenv', 'OLLAMA_ORIGINS', '*'], check=True, capture_output=True)
    except Exception as e:
        print(f'Could not set OLLAMA_ORIGINS for this session: {e}')
    label = 'com.atlantis.ollama-origins'
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
        <string>/bin/launchctl</string>
        <string>setenv</string>
        <string>OLLAMA_ORIGINS</string>
        <string>*</string>
    </array>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
''')
    try:
        subprocess.run(['launchctl', 'load', str(plist_path)], capture_output=True)
    except Exception:
        pass


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


def configure_ollama_origins_windows():
    """Ollama's default origin allowlist 403s any request carrying a
    browser Origin header. Atlantis's Chat tab talks to Ollama directly
    from the browser rather than proxying through server.py (see
    resolve_ollama_endpoint() in server/server.py), so without this a
    Windows host's models are visible in the Models tab (server-side
    fetch, no Origin header) but silently never win the Chat "auto" host
    race. os.environ covers the installer's own child processes (e.g.
    Ollama auto-launched right after a silent install) for this session;
    setx persists it to HKCU\\Environment for future logins."""
    os.environ['OLLAMA_ORIGINS'] = '*'
    try:
        subprocess.run(['setx', 'OLLAMA_ORIGINS', '*'], check=True, capture_output=True)
    except Exception as e:
        print(f"Could not persist OLLAMA_ORIGINS: {e}. Other machines' Chat tabs may not "
              f"see this host's models until it's set manually.")


def install_ollama_windows():
    print('Downloading Ollama for Windows...')
    with tempfile.TemporaryDirectory() as tmp:
        exe_path = Path(tmp) / 'OllamaSetup.exe'
        urllib.request.urlretrieve(OLLAMA_WINDOWS_URL, exe_path)
        subprocess.run([str(exe_path), '/SILENT'], check=True)


def install_ollama_linux_tarball():
    print('Downloading Ollama (Linux, no-root install)...')
    zstd_bin = shutil.which('zstd') or shutil.which('unzstd')
    if not zstd_bin:
        print('Ollama install failed: the "zstd" tool is required to extract the Linux release but was not found.')
        print('Install it with your package manager, e.g.:')
        print('  sudo apt install zstd      (Debian/Ubuntu)')
        print('  sudo dnf install zstd      (Fedora)')
        return
    ollama_dir = DATA_DIR / 'ollama'
    ollama_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive_path = Path(tmp) / 'ollama-linux-amd64.tar.zst'
        urllib.request.urlretrieve(OLLAMA_LINUX_URL, archive_path)
        tar_path = Path(tmp) / 'ollama-linux-amd64.tar'
        subprocess.run([zstd_bin, '-d', '-f', str(archive_path), '-o', str(tar_path)], check=True)
        with tarfile.open(tar_path) as tf:
            tf.extractall(ollama_dir)
    bin_path = ollama_dir / 'bin' / 'ollama'
    if bin_path.exists():
        bin_path.chmod(0o755)


def setup_ollama(os_name):
    if os_name == 'windows':
        configure_ollama_origins_windows()
    elif os_name == 'macos':
        configure_ollama_origins_macos()
    if ollama_responds():
        print('Ollama is already running — skipping install.')
        if os_name in ('windows', 'macos'):
            print('OLLAMA_ORIGINS is now set, but only new Ollama processes pick it up — '
                  'quit Ollama from the menu bar / tray icon and relaunch it for other '
                  "machines' Chat tabs to see this host's models.")
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
ExecStart="{sys.executable}" "{ROOT_DIR / 'launcher.py'}"
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

    if ask('Auto-generate an HTTPS cert?', default_yes=True):
        setup_https_certs(os_name)

    if ask('Auto-install code-server (in-browser code editor)?', default_yes=True):
        setup_code_server(os_name)

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
