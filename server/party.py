"""Party feature — self-hosted Headscale compute pooling, reachable via direct
router port-forwarding + a free DuckDNS hostname + a real Let's Encrypt
certificate obtained via DNS-01 validation. No third-party tunnel service.

Two prior designs were tried and abandoned here, in order:

1. Cloudflare Tunnel: verified directly (headscale logs + a confirmed,
   still-open cloudflared bug, github.com/cloudflare/cloudflared/issues/883)
   that cloudflared strips the Upgrade header on the POST-based upgrade
   request Tailscale's actual client protocol (TS2021/Noise) uses — this
   breaks real client connections through *any* Cloudflare Tunnel, Quick or
   named/paid.
2. Headscale's own built-in ACME (HTTP-01, autocert): required port 80
   forwarded from the router in addition to 443. Verified live that this
   user's residential ISP actively blocks inbound 80/443 (confirmed via an
   external test from outside the network — real ECONNREFUSED — while the
   router's own firewall/NAT config was independently confirmed correct,
   ruling out a local misconfiguration).

Settled design: DNS-01 challenge validation, which needs no inbound port at
all for certificate issuance — Let's Encrypt proves domain ownership via a
DNS TXT record instead of an HTTP fetch. DuckDNS supports this directly
(its `txt=` update parameter, verified to correctly answer queries at the
`_acme-challenge.<domain>` name Let's Encrypt actually looks up). Only port
443 (Tailscale/Headscale client traffic itself) needs forwarding now — no
port 80 dependency, so this design also works on the (common) case of an
ISP blocking port 80 but not other ports.

Since headscale's own ACME implementation only supports HTTP-01/TLS-ALPN-01
(both port-80/443-based, confirmed against its real v0.29.2 config docs),
getting a DNS-01 cert means running the ACME protocol ourselves. That, in
turn, needs RSA key generation and RSASSA-PKCS1-v1_5 (RS256) signing to
produce JWS-signed requests — Python's stdlib has no library for either.
Rather than add a new dependency (or shell out to `openssl`, which isn't on
PATH for a plain Windows process outside Git Bash — verified directly on
this machine), this implements RSA keygen/signing directly using `pow()`
for modular exponentiation (the actual hard part; stdlib handles it
natively and correctly) plus a minimal DER/ASN.1 encoder for the CSR and
private key export. Every primitive here (signing, thumbprint, CSR, private
key PEM export) was independently cross-checked against the `cryptography`
library during development, and the full flow was confirmed end-to-end
against Let's Encrypt's real staging environment before ever touching
production.

Pure logic module: OS/arch/mode detection, Headscale install (native binary
or Docker), DuckDNS updates (A + TXT records), the from-scratch ACME v2
DNS-01 client, the Headscale HTTP API client, Tailscale client install/join
helpers, and SSH-based host-role migration. server.py's /api/party/*
handlers are thin wrappers that call into this module and do the DB/JSON
plumbing — this file has no direct database access, everything it needs
(API keys, URLs) is passed in as plain arguments.

Run directly (not imported) for the migration receive step:
    python3 server/party.py migrate-receive --archive <path>
"""
import base64, datetime, hashlib, http.client, io, json, os, platform, re, secrets, shutil, socket, ssl
import subprocess, sys, tarfile, tempfile, time
import urllib.request, urllib.error
from pathlib import Path

BASE_DIR = Path(__file__).parent           # server/
ROOT_DIR = BASE_DIR.parent                  # repo root
DATA_DIR = ROOT_DIR / 'data'

PARTY_DIR              = DATA_DIR / 'party'
HEADSCALE_DIR           = PARTY_DIR / 'headscale'
HEADSCALE_BIN           = HEADSCALE_DIR / 'bin' / 'headscale'
HEADSCALE_CONFIG        = HEADSCALE_DIR / 'config.yaml'
HEADSCALE_STATE         = HEADSCALE_DIR / 'state'
HEADSCALE_CERTS_DIR     = HEADSCALE_DIR / 'certs'          # mounted for free in docker mode — see start_headscale_docker
HEADSCALE_CERT_PATH     = HEADSCALE_CERTS_DIR / 'cert.pem'
HEADSCALE_KEY_PATH      = HEADSCALE_CERTS_DIR / 'key.pem'
ACME_ACCOUNT_KEY_PATH   = HEADSCALE_CERTS_DIR / 'acme_account_key.json'  # reused across renewals, not regenerated each time
PARTY_HOST_FLAG         = DATA_DIR / '.party_host'
PARTY_STOP_FLAG         = DATA_DIR / '.party_stop'   # scoped teardown signal for launcher.py, set during migration
LAUNCHER_LOG            = DATA_DIR / 'launcher.log'  # where launcher.py's supervised children's stdout/stderr land

# Router forwards WAN 443 -> this internal port on this machine. Deliberately
# non-privileged (>1024) so neither native mode nor Docker needs root/
# setcap/admin just to bind it — the router (not the OS) absorbs the
# "well-known port" requirement via its own port-forward remapping. DNS-01
# cert issuance needs no forwarded port at all, so this is the only one.
HEADSCALE_PUBLIC_PORT = 8443

# Pre-1.0 project — config shape and API routes have broken across minors
# before, so this is pinned deliberately rather than always tracking latest.
HEADSCALE_VERSION     = '0.29.2'
HEADSCALE_USER        = 'atlantis-party'
HEADSCALE_CONTAINER   = 'atlantis-headscale'

ACME_DIRECTORY_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
ACME_DIRECTORY_STAGING    = 'https://acme-staging-v02.api.letsencrypt.org/directory'
CERT_RENEWAL_AFTER_DAYS   = 60  # Let's Encrypt certs are valid 90 days; renew with a comfortable margin

_SSH_FLAGS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=5']


# ── Detection ────────────────────────────────────────────────────────────────

def detect_os():
    return {'Darwin': 'macos', 'Windows': 'windows', 'Linux': 'linux'}.get(platform.system(), 'linux')


def detect_arch():
    """Maps platform.machine() to the exact arch strings Headscale's real
    release assets use (verified against their actual GitHub releases, not
    guessed). None on anything unrecognized so callers hard-stop rather than
    silently grabbing the wrong binary."""
    m = platform.machine().lower()
    if m in ('x86_64', 'amd64'):
        return 'amd64'
    if m in ('aarch64', 'arm64'):
        return 'arm64'
    if m.startswith('armv7') or m.startswith('armv6'):
        return 'arm'
    return None


class _SafeResult:
    """Stand-in for subprocess.CompletedProcess when the call itself blew up
    (timeout, missing binary, etc.) — verified this matters directly: an
    uncaught TimeoutExpired from a plain subprocess.run() crashed the whole
    HTTP request thread (empty reply to the browser) instead of returning a
    clean {'error': ...}. Every call site below checks .returncode/.stdout/
    .stderr the same way either way, so callers don't need special-casing."""
    def __init__(self, error):
        self.returncode = -1
        self.stdout = ''
        self.stderr = error


def _safe_run(cmd, **kwargs):
    try:
        return subprocess.run(cmd, **kwargs)
    except subprocess.TimeoutExpired:
        return _SafeResult(f'Command timed out: {" ".join(cmd)}')
    except Exception as e:
        return _SafeResult(str(e))


def docker_available():
    try:
        return subprocess.run(['docker', 'version'], capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def docker_desktop_installed():
    """Distinct from docker_available(): this checks the app is on disk at
    all, so the UI can tell "never installed" apart from "installed but the
    daemon isn't up yet" (e.g. still starting, or blocked on BIOS
    virtualization) — two very different situations for the user."""
    return Path('C:/Program Files/Docker/Docker/Docker Desktop.exe').exists()


def windows_virtualization_enabled():
    """Whether the CPU's virtualization extensions (VT-x/AMD-V) are actually
    exposed by firmware — the one thing in this whole flow that no installer
    can fix, verified directly: Docker Desktop installs fine regardless, but
    its daemon never comes up until this is on and the machine is rebooted.
    None if not Windows or the check itself fails (unknown, not "disabled")."""
    if sys.platform != 'win32':
        return None
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', '(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled'],
            capture_output=True, text=True, timeout=10)
        out = result.stdout.strip().lower()
        if out in ('true', 'false'):
            return out == 'true'
        return None
    except Exception:
        return None


def pick_host_mode(os_name):
    """Headscale ships no Windows build (verified against its actual release
    assets — only linux/darwin/freebsd) — Windows hosts always go through
    Docker Desktop instead, Headscale's own officially-documented deployment
    path."""
    return 'docker' if os_name == 'windows' else 'native'


# ── Liveness checks ──────────────────────────────────────────────────────────

def headscale_responds():
    try:
        with socket.create_connection(('127.0.0.1', HEADSCALE_PUBLIC_PORT), timeout=1.5):
            return True
    except OSError:
        return False


def is_party_host():
    return PARTY_HOST_FLAG.exists()


def party_host_mode():
    """launcher.py has no DB access (by design, matching its existing
    file-flag-only control model) — the flag file's contents (not just its
    existence) is how it learns native-vs-docker without reading settings."""
    if not PARTY_HOST_FLAG.exists():
        return None
    mode = PARTY_HOST_FLAG.read_text().strip()
    return mode if mode in ('native', 'docker') else None


def write_party_host_flag(mode):
    PARTY_HOST_FLAG.parent.mkdir(parents=True, exist_ok=True)
    PARTY_HOST_FLAG.write_text(mode)


# ── Native binary install (linux/macos host role) ───────────────────────────

def install_headscale_native(os_name, arch):
    if os_name == 'windows':
        return {'error': 'Headscale has no Windows build — the host role on Windows uses Docker instead.'}
    if arch not in ('amd64', 'arm64'):
        return {'error': f'Headscale has no {arch or "unknown-arch"} build (only amd64/arm64) — use Docker mode instead.'}
    if HEADSCALE_BIN.exists():
        return {'ok': True, 'already': True}
    asset_os = 'darwin' if os_name == 'macos' else 'linux'
    url = (f'https://github.com/juanfont/headscale/releases/download/'
           f'v{HEADSCALE_VERSION}/headscale_{HEADSCALE_VERSION}_{asset_os}_{arch}')
    HEADSCALE_BIN.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'atlantis-installer'})
        with urllib.request.urlopen(req, timeout=120) as resp:
            HEADSCALE_BIN.write_bytes(resp.read())
    except Exception as e:
        return {'error': f'Headscale download failed: {e}'}
    HEADSCALE_BIN.chmod(0o755)
    return {'ok': True}


# ── Docker-mode install (windows host role, or anyone who prefers it) ───────

def install_docker_desktop_if_missing():
    """Windows only. Silent-installs Docker Desktop, same /quiet-style pattern
    install.py already uses for Ollama's Windows installer."""
    if docker_available():
        return {'ok': True, 'already': True}
    url = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
    try:
        with tempfile.TemporaryDirectory() as tmp:
            exe_path = Path(tmp) / 'DockerDesktopInstaller.exe'
            req = urllib.request.Request(url, headers={'User-Agent': 'atlantis-installer'})
            with urllib.request.urlopen(req, timeout=300) as resp:
                exe_path.write_bytes(resp.read())
            subprocess.run([str(exe_path), 'install', '--quiet', '--accept-license'], check=True, timeout=600)
    except Exception as e:
        return {'error': f'Docker Desktop install failed: {e}. Install it manually from docker.com and retry.'}
    return {'ok': True, 'restartRequired': True}


def install_headscale_docker():
    if not docker_available():
        if docker_desktop_installed():
            if windows_virtualization_enabled() is False:
                return {'error': (
                    'Docker Desktop is installed but its daemon will never start: this PC\'s CPU '
                    'virtualization (Intel VT-x / AMD-V) is disabled in BIOS/UEFI. Restart, enter '
                    'BIOS setup (commonly Del, F2, F10, or F12 during boot), enable it under '
                    'Advanced > CPU Configuration (look for "Virtualization Technology" or "SVM Mode"), '
                    'save, and reboot. No installer can do this step — it requires physical BIOS access.'
                )}
            return {'error': (
                'Docker Desktop is installed but not responding yet. If this was just installed, '
                'open it manually once, or restart Windows — a first-time install often needs a '
                'reboot for its Windows features (WSL2) to finish activating.'
            )}
        return {'error': 'Docker is not available — install/start Docker Desktop first.'}
    try:
        subprocess.run(['docker', 'pull', f'headscale/headscale:{HEADSCALE_VERSION}'], check=True, timeout=300)
    except Exception as e:
        return {'error': f'Docker image pull failed: {e}'}
    return {'ok': True}


def _docker_start_or_run(name, run_cmd):
    """Idempotent: starts an existing (stopped) container by name, or creates
    it fresh via run_cmd if it's never existed. `docker run` alone would fail
    with a name conflict on every call after the first — this is what
    launcher.py calls on every launch."""
    result = _safe_run(['docker', 'start', name], capture_output=True, text=True, timeout=15)
    if result.returncode == 0:
        return {'ok': True}
    result = _safe_run(run_cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return {'error': result.stderr.strip()}
    return {'ok': True}


def start_headscale_docker():
    HEADSCALE_STATE.mkdir(parents=True, exist_ok=True)
    HEADSCALE_CERTS_DIR.mkdir(parents=True, exist_ok=True)
    # The official image's entrypoint is already the headscale binary itself —
    # passing 'headscale' again as the first arg makes it try to run
    # "headscale headscale serve" and fail with "unknown command". Only one
    # port to publish now — DNS-01 cert issuance needs no inbound port at
    # all, so there's no ACME/HTTP-01 listener to expose alongside it.
    # HEADSCALE_CERTS_DIR needs no separate volume mount: it lives under
    # HEADSCALE_CONFIG.parent, which is already mounted at /etc/headscale.
    run_cmd = ['docker', 'run', '-d', '--name', HEADSCALE_CONTAINER,
               '--restart', 'unless-stopped',
               '-v', f'{HEADSCALE_STATE}:/var/lib/headscale',
               '-v', f'{HEADSCALE_CONFIG.parent}:/etc/headscale',
               '-p', f'0.0.0.0:{HEADSCALE_PUBLIC_PORT}:{HEADSCALE_PUBLIC_PORT}',
               f'headscale/headscale:{HEADSCALE_VERSION}', 'serve']
    return _docker_start_or_run(HEADSCALE_CONTAINER, run_cmd)


# ── Headscale lifecycle ──────────────────────────────────────────────────────

def _headscale_cli(args, mode):
    """One indirection point so everything above this line stays mode-agnostic."""
    if mode == 'docker':
        cmd = ['docker', 'exec', HEADSCALE_CONTAINER, 'headscale', *args]
    else:
        cmd = [str(HEADSCALE_BIN), '--config', str(HEADSCALE_CONFIG), *args]
    return _safe_run(cmd, capture_output=True, text=True, timeout=30)


def write_headscale_config(public_hostname, mode):
    """public_hostname is the real DuckDNS domain (e.g. name.duckdns.org) —
    this isn't cosmetic: the certificate at HEADSCALE_CERT_PATH/KEY_PATH
    (issue_certificate_dns01's output) is actually issued for this exact
    name, and clients connect to it directly (no tunnel in between).
    Certificate is supplied manually (tls_cert_path/tls_key_path) rather
    than via headscale's own built-in ACME — see this module's docstring
    for why (ISP blocks the ports HTTP-01/TLS-ALPN-01 both need)."""
    HEADSCALE_STATE.mkdir(parents=True, exist_ok=True)
    HEADSCALE_CERTS_DIR.mkdir(parents=True, exist_ok=True)
    # Docker mode: headscale runs inside the container, so these paths are the
    # *container-internal* mount points, not host paths. Native mode: headscale
    # runs directly on this OS, so they're real host filesystem paths.
    state_path = '/var/lib/headscale' if mode == 'docker' else str(HEADSCALE_STATE)
    certs_path = '/etc/headscale/certs' if mode == 'docker' else str(HEADSCALE_CERTS_DIR)
    # 0.0.0.0 in both modes now — there's a real router port-forward putting
    # public traffic on this port (no tunnel absorbing that anymore), and in
    # docker mode specifically, binding 127.0.0.1 *inside* the container only
    # accepts connections from that container's own network namespace, so
    # host-level port-forwarding could never reach it (verified directly —
    # this broke every path on every port until fixed, back when this still
    # went through Cloudflare).
    config = f'''server_url: https://{public_hostname}
listen_addr: 0.0.0.0:{HEADSCALE_PUBLIC_PORT}
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false

database:
  type: sqlite
  sqlite:
    path: {state_path}/db.sqlite

noise:
  private_key_path: {state_path}/noise_private.key

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48

derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true
  update_frequency: 24h

dns:
  magic_dns: true
  base_domain: party.internal
  nameservers:
    global:
      - 1.1.1.1
      - 8.8.8.8

# Real, trusted HTTPS — certificate obtained ourselves via ACME DNS-01
# (see issue_certificate_dns01) and supplied here directly, since this
# ISP blocks the ports headscale's own built-in ACME (HTTP-01/TLS-ALPN-01)
# would need.
tls_cert_path: {certs_path}/cert.pem
tls_key_path: {certs_path}/key.pem
'''
    HEADSCALE_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    # Explicit UTF-8: write_text()'s default encoding is the OS locale's
    # preferred one, which on Windows is cp1252, not UTF-8 — verified
    # directly that this silently mis-encoded this file's em-dashes as
    # single high-bytes, which headscale's Go YAML parser then rejected
    # outright ("invalid leading UTF-8 octet"), crash-looping the container.
    HEADSCALE_CONFIG.write_text(config, encoding='utf-8')


def ensure_default_user(mode):
    result = _headscale_cli(['users', 'list', '-o', 'json'], mode)
    if result.returncode == 0:
        try:
            users = json.loads(result.stdout or '[]')
            if any(u.get('name') == HEADSCALE_USER for u in users):
                return {'ok': True, 'already': True}
        except Exception:
            pass
    result = _headscale_cli(['users', 'create', HEADSCALE_USER], mode)
    if result.returncode != 0:
        return {'error': f'Could not create default user: {result.stderr.strip()}'}
    return {'ok': True}


def create_api_key(mode):
    """Headscale only ever prints a freshly-created API key once (it stores
    just a hash) — the caller must persist the return value to
    settings.headscaleApiKey immediately, it can never be fetched again."""
    result = _headscale_cli(['apikeys', 'create', '--expiration', '999d'], mode)
    if result.returncode != 0:
        return None, f'Could not create API key: {result.stderr.strip()}'
    key = result.stdout.strip().splitlines()[-1].strip()
    return key, None


# ── Headscale HTTP API client ────────────────────────────────────────────────
# Routes/fields below verified against the real v0.29.2 OpenAPI spec
# (gen/openapiv2/headscale/v1/headscale.swagger.json) — not guessed.

class _SNIHTTPSConnection(http.client.HTTPSConnection):
    """Dials one address (127.0.0.1 — always reachable, no router/NAT
    dependency) but presents a *different* hostname as the TLS SNI value.
    Needed because headscale's Let's Encrypt (autocert) integration picks
    and serves its certificate based on the SNI the client sends — connect
    straight to an IP with no SNI at all and it refuses the handshake
    outright ("acme/autocert: missing server name"), verified directly
    against this exact container's logs. Passing the real public hostname
    as server_hostname here also means the returned certificate gets
    properly validated against the name it was actually issued for, rather
    than needing to skip hostname verification."""
    def __init__(self, host, port, sni_hostname, context, timeout=15):
        super().__init__(host, port, timeout=timeout, context=context)
        self._sni_hostname = sni_hostname

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._sni_hostname)


def headscale_request_core(sni_hostname, api_key, path, method='GET', body=None, host='127.0.0.1', port=None):
    """Bearer-token HTTP client for Headscale's REST API — same shape as
    worker.py's anthropic_once request building, just Headscale's actual
    'Authorization: Bearer <key>' scheme instead of an x-api-key header.
    Always dials `host` (loopback by default — this is only ever called
    from the same machine that runs headscale) but sends `sni_hostname`
    (the real public DuckDNS domain) as the TLS server name, per
    _SNIHTTPSConnection's docstring."""
    if not api_key:
        return None, 'headscale API key not set in settings'
    if port is None:
        port = HEADSCALE_PUBLIC_PORT
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    conn = None
    try:
        conn = _SNIHTTPSConnection(host, port, sni_hostname, ssl.create_default_context(), timeout=15)
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status >= 400:
            return None, f'Headscale API {resp.status}: {raw.decode(errors="replace")[:300]}'
        return json.loads(raw), None
    except Exception as e:
        return None, str(e)
    finally:
        if conn:
            conn.close()


def get_user_id(sni_hostname, api_key, username=HEADSCALE_USER):
    data, err = headscale_request_core(sni_hostname, api_key, f'/api/v1/user?name={username}')
    if err:
        return None, err
    users = data.get('users', data if isinstance(data, list) else [])
    if not users:
        return None, f'Headscale user "{username}" not found'
    return users[0]['id'], None


def create_preauth_key(sni_hostname, api_key, reusable=False, ephemeral=False, expiration_minutes=60):
    user_id, err = get_user_id(sni_hostname, api_key)
    if err:
        return None, err
    expiration = (datetime.datetime.utcnow() + datetime.timedelta(minutes=expiration_minutes)).strftime('%Y-%m-%dT%H:%M:%SZ')
    body = {'user': str(user_id), 'reusable': reusable, 'ephemeral': ephemeral, 'expiration': expiration}
    data, err = headscale_request_core(sni_hostname, api_key, '/api/v1/preauthkey', 'POST', body)
    if err:
        return None, err
    return data['preAuthKey']['key'], None


def list_nodes(sni_hostname, api_key):
    data, err = headscale_request_core(sni_hostname, api_key, '/api/v1/node')
    if err:
        return None, err
    return data.get('nodes', []), None


# ── DuckDNS ───────────────────────────────────────────────────────────────────
# Free dynamic DNS, no expiry. The host's router forwards WAN 443 to this
# machine, so as long as this hostname tracks the host's current public IP,
# that's the entire "reachability" story — no tunnel process to run at all.
# Also doubles as the DNS-01 ACME challenge mechanism below: DuckDNS's txt=
# parameter, verified directly to correctly answer queries at the
# _acme-challenge.<domain> name Let's Encrypt actually looks up.

def update_duckdns(domain, token, txt=None):
    """domain is the subdomain only (e.g. 'myparty' for myparty.duckdns.org).
    DuckDNS documents the A-record update and the TXT-record update as two
    separate mechanisms, not one combined call — verified directly that
    including `ip=` alongside `txt=` in the same request silently no-ops
    the TXT write (the origin record never actually changed, confirmed by
    querying DuckDNS's own authoritative nameserver directly), so these
    must stay two distinct request shapes, never merged into one URL."""
    subdomain = domain.split('.')[0]
    if txt is not None:
        url = f'https://www.duckdns.org/update?domains={subdomain}&token={token}&txt={txt}'
    else:
        # Empty ip= means "use the request's own source IP" — DuckDNS's
        # documented, simplest dynamic-update behavior.
        url = f'https://www.duckdns.org/update?domains={subdomain}&token={token}&ip='
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            body = resp.read().decode().strip()
    except Exception as e:
        return {'error': str(e)}
    if body.startswith('OK'):
        return {'ok': True}
    return {'error': f'DuckDNS rejected the update (check domain/token): {body}'}


# ── ACME v2 client (DNS-01, pure Python — see module docstring for why) ──────
# Every primitive below (RSA sign, JWK thumbprint, CSR, private-key PEM
# export) was independently cross-checked against the `cryptography` library
# during development, and the full flow confirmed end-to-end against Let's
# Encrypt's real staging environment before ever touching production.

def _is_probable_prime(n, rounds=40):
    if n < 2:
        return False
    small_primes = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47)
    for p in small_primes:
        if n == p:
            return True
        if n % p == 0:
            return False
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits):
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _is_probable_prime(candidate):
            return candidate


def _egcd(a, b):
    if a == 0:
        return (b, 0, 1)
    g, x1, y1 = _egcd(b % a, a)
    return (g, y1 - (b // a) * x1, x1)


def _modinv(a, m):
    g, x, _ = _egcd(a, m)
    if g != 1:
        raise ValueError('modular inverse does not exist')
    return x % m


def _generate_rsa_keypair(bits=2048):
    e = 65537
    while True:
        p, q = _gen_prime(bits // 2), _gen_prime(bits // 2)
        if p == q:
            continue
        n = p * q
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue  # e must be coprime with phi, retry with fresh primes
        if n.bit_length() != bits:
            continue
        return {'n': n, 'e': e, 'd': _modinv(e, phi), 'p': p, 'q': q}


_SHA256_DIGESTINFO_PREFIX = bytes.fromhex('3031300d060960864801650304020105000420')


def _rsa_sign_rs256(message: bytes, key: dict) -> bytes:
    """RSASSA-PKCS1-v1_5 with SHA-256 — JWS alg 'RS256'."""
    n, d = key['n'], key['d']
    k = (n.bit_length() + 7) // 8
    digest_info = _SHA256_DIGESTINFO_PREFIX + hashlib.sha256(message).digest()
    ps_len = k - len(digest_info) - 3
    if ps_len < 8:
        raise ValueError('RSA key too small for a PKCS#1 v1.5 SHA-256 signature')
    em = b'\x00\x01' + b'\xff' * ps_len + b'\x00' + digest_info
    sig_int = pow(int.from_bytes(em, 'big'), d, n)
    return sig_int.to_bytes(k, 'big')


# ── Minimal DER/ASN.1 encoder (just enough for a CSR + PKCS#1 private key) ───

def _der_len(length):
    if length < 0x80:
        return bytes([length])
    enc = length.to_bytes((length.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(enc)]) + enc


def _der_tlv(tag, value):
    return bytes([tag]) + _der_len(len(value)) + value


def _der_integer(i):
    if i == 0:
        b = b'\x00'
    else:
        b = i.to_bytes((i.bit_length() + 8) // 8, 'big')
        while len(b) > 1 and b[0] == 0 and b[1] < 0x80:
            b = b[1:]
    return _der_tlv(0x02, b)


def _der_bitstring(b, unused_bits=0):
    return _der_tlv(0x03, bytes([unused_bits]) + b)


def _der_octetstring(b):
    return _der_tlv(0x04, b)


def _der_null():
    return _der_tlv(0x05, b'')


def _der_oid(dotted):
    parts = [int(p) for p in dotted.split('.')]
    out = bytearray([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        if p == 0:
            out.append(0)
            continue
        chunk = []
        while p > 0:
            chunk.insert(0, p & 0x7f)
            p >>= 7
        for i in range(len(chunk) - 1):
            chunk[i] |= 0x80
        out.extend(chunk)
    return _der_tlv(0x06, bytes(out))


def _der_sequence(*parts):
    return _der_tlv(0x30, b''.join(parts))


def _der_set(*parts):
    return _der_tlv(0x31, b''.join(parts))


def _der_context(tag, value, constructed=True):
    return _der_tlv((0xA0 if constructed else 0x80) | tag, value)


_OID_RSA_ENCRYPTION    = '1.2.840.113549.1.1.1'
_OID_SHA256_WITH_RSA   = '1.2.840.113549.1.1.11'
_OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14'
_OID_SUBJECT_ALT_NAME  = '2.5.29.17'


def _build_csr_der(domain: str, key: dict) -> bytes:
    """PKCS#10 CSR, self-signed by the domain key, with the domain as a SAN
    dNSName entry (Let's Encrypt only looks at SAN, never the CN, for domain
    identifiers on modern certs)."""
    n, e = key['n'], key['e']
    n_bytes = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    e_bytes = e.to_bytes((e.bit_length() + 7) // 8, 'big')
    spki = _der_sequence(
        _der_sequence(_der_oid(_OID_RSA_ENCRYPTION), _der_null()),
        _der_bitstring(_der_sequence(_der_integer(n), _der_integer(e))),
    )
    general_names = _der_sequence(_der_context(2, domain.encode('ascii'), constructed=False))
    san_ext = _der_sequence(_der_oid(_OID_SUBJECT_ALT_NAME), _der_octetstring(general_names))
    ext_req_attr = _der_sequence(_der_oid(_OID_EXTENSION_REQUEST), _der_set(_der_sequence(san_ext)))
    attrs = _der_context(0, ext_req_attr)
    cri = _der_sequence(_der_integer(0), _der_sequence(), spki, attrs)
    sig = _rsa_sign_rs256(cri, key)
    sig_alg = _der_sequence(_der_oid(_OID_SHA256_WITH_RSA), _der_null())
    return _der_sequence(cri, sig_alg, _der_bitstring(sig))


def _rsa_private_key_pem(key: dict) -> str:
    """PKCS#1 RSAPrivateKey DER, PEM-armored — the format headscale's
    tls_key_path expects."""
    n, e, d, p, q = key['n'], key['e'], key['d'], key['p'], key['q']
    dP, dQ, qInv = d % (p - 1), d % (q - 1), _modinv(q, p)
    der = _der_sequence(
        _der_integer(0), _der_integer(n), _der_integer(e), _der_integer(d),
        _der_integer(p), _der_integer(q), _der_integer(dP), _der_integer(dQ), _der_integer(qInv),
    )
    b64 = base64.b64encode(der).decode()
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return '-----BEGIN RSA PRIVATE KEY-----\n' + '\n'.join(lines) + '\n-----END RSA PRIVATE KEY-----\n'


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _jwk_from_key(key: dict) -> dict:
    n, e = key['n'], key['e']
    return {
        'kty': 'RSA',
        'n': _b64url(n.to_bytes((n.bit_length() + 7) // 8, 'big')),
        'e': _b64url(e.to_bytes((e.bit_length() + 7) // 8, 'big')),
    }


def _jwk_thumbprint(jwk: dict) -> str:
    """RFC 7638 — canonical JSON (lexicographic keys, no whitespace), SHA-256."""
    canonical = json.dumps({'e': jwk['e'], 'kty': jwk['kty'], 'n': jwk['n']}, separators=(',', ':'))
    return _b64url(hashlib.sha256(canonical.encode()).digest())


def _account_key():
    """Reused across renewals rather than regenerated every time — kinder to
    Let's Encrypt's account-creation rate limits and simpler (one persistent
    ACME account, not a fresh one every ~60 days)."""
    if ACME_ACCOUNT_KEY_PATH.exists():
        return json.loads(ACME_ACCOUNT_KEY_PATH.read_text(encoding='utf-8'))
    key = _generate_rsa_keypair(2048)
    ACME_ACCOUNT_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    ACME_ACCOUNT_KEY_PATH.write_text(json.dumps(key), encoding='utf-8')
    return key


class _AcmeClient:
    """Minimal ACME v2 (RFC 8555) client — just the operations DNS-01 cert
    issuance needs, nothing more."""
    def __init__(self, directory_url, account_key):
        self.key = account_key
        self.kid = None
        self._nonce = None
        req = urllib.request.Request(directory_url, headers={'User-Agent': 'atlantis-party'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            self.directory = json.loads(resp.read())

    def _get_nonce(self):
        if self._nonce:
            n, self._nonce = self._nonce, None
            return n
        req = urllib.request.Request(self.directory['newNonce'], method='HEAD',
                                      headers={'User-Agent': 'atlantis-party'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.headers['Replay-Nonce']

    def _post(self, url, payload):
        protected = {'alg': 'RS256', 'nonce': self._get_nonce(), 'url': url}
        protected['kid' if self.kid else 'jwk'] = self.kid or _jwk_from_key(self.key)
        protected_b64 = _b64url(json.dumps(protected).encode())
        payload_b64 = '' if payload is None else _b64url(json.dumps(payload).encode())
        sig = _rsa_sign_rs256(f'{protected_b64}.{payload_b64}'.encode(), self.key)
        body = json.dumps({'protected': protected_b64, 'payload': payload_b64, 'signature': _b64url(sig)})
        req = urllib.request.Request(url, data=body.encode(), method='POST',
                                      headers={'Content-Type': 'application/jose+json',
                                               'User-Agent': 'atlantis-party'})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                self._nonce = resp.headers.get('Replay-Nonce')
                raw = resp.read()
                return dict(resp.headers), (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            self._nonce = e.headers.get('Replay-Nonce')
            raw = e.read()
            raise RuntimeError(f'ACME error {e.code} at {url}: {json.loads(raw) if raw else {}}') from None

    def new_account(self, email):
        headers, _ = self._post(self.directory['newAccount'],
                                 {'termsOfServiceAgreed': True, 'contact': [f'mailto:{email}']})
        self.kid = headers['Location']

    def new_order(self, domain):
        headers, body = self._post(self.directory['newOrder'],
                                    {'identifiers': [{'type': 'dns', 'value': domain}]})
        return headers['Location'], body

    def get_authorization(self, auth_url):
        _, body = self._post(auth_url, None)
        return body

    def notify_challenge_ready(self, challenge_url):
        self._post(challenge_url, {})

    def poll(self, url, want_statuses, timeout=90):
        deadline = time.time() + timeout
        body = {}
        while time.time() < deadline:
            _, body = self._post(url, None)
            if body.get('status') in want_statuses:
                return body
            time.sleep(2)
        raise TimeoutError(f'Timed out polling {url}, last status: {body.get("status")}')

    def finalize(self, finalize_url, csr_der):
        _, body = self._post(finalize_url, {'csr': _b64url(csr_der)})
        return body

    def download_certificate(self, cert_url):
        protected = {'alg': 'RS256', 'nonce': self._get_nonce(), 'url': cert_url, 'kid': self.kid}
        protected_b64 = _b64url(json.dumps(protected).encode())
        sig = _rsa_sign_rs256(f'{protected_b64}.'.encode(), self.key)
        body = json.dumps({'protected': protected_b64, 'payload': '', 'signature': _b64url(sig)})
        req = urllib.request.Request(cert_url, data=body.encode(), method='POST',
                                      headers={'Content-Type': 'application/jose+json',
                                               'Accept': 'application/pem-certificate-chain',
                                               'User-Agent': 'atlantis-party'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read().decode()


def _wait_for_txt_propagation(domain, expected_value, timeout=90):
    """Public-resolver check before telling Let's Encrypt to validate —
    without this, the very first validation attempt often races DNS
    propagation and fails needlessly."""
    name = f'_acme-challenge.{domain}'
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = _safe_run(['nslookup', '-type=TXT', name, '1.1.1.1'],
                            capture_output=True, text=True, timeout=10)
        if expected_value in (result.stdout or ''):
            return True
        time.sleep(3)
    return False


def issue_certificate_dns01(domain, email, duckdns_token, staging=False):
    """Full ACME v2 DNS-01 flow: account, order, DNS-01 challenge via
    DuckDNS's TXT support, finalize, download. Returns {'ok': True} (with
    HEADSCALE_CERT_PATH/KEY_PATH written) or {'error': ...}. staging=True
    uses Let's Encrypt's staging directory (untrusted certs, generous rate
    limits) — only ever used during development, never for a real party."""
    try:
        account_key = _account_key()
        directory_url = ACME_DIRECTORY_STAGING if staging else ACME_DIRECTORY_PRODUCTION
        client = _AcmeClient(directory_url, account_key)
        client.new_account(email)
        order_url, order = client.new_order(domain)
        auth = client.get_authorization(order['authorizations'][0])
        dns01 = next(c for c in auth['challenges'] if c['type'] == 'dns-01')

        thumbprint = _jwk_thumbprint(_jwk_from_key(account_key))
        key_auth = f'{dns01["token"]}.{thumbprint}'
        txt_value = _b64url(hashlib.sha256(key_auth.encode()).digest())

        r = update_duckdns(domain, duckdns_token, txt=txt_value)
        if r.get('error'):
            return {'error': f'Could not publish DNS-01 TXT record: {r["error"]}'}
        # Hard stop, not best-effort: notifying Let's Encrypt before the
        # public resolver actually sees the new value is a guaranteed
        # validation failure — verified directly (a stale TXT value from an
        # earlier test was still being served when this ran without the
        # check, and Let's Encrypt correctly rejected it as "incorrect").
        if not _wait_for_txt_propagation(domain, txt_value, timeout=120):
            return {'error': (f'DNS-01 TXT record for _acme-challenge.{domain} had not propagated '
                               f'after 120s (checked via 1.1.1.1) — Let\'s Encrypt would very likely '
                               f'fail validation too. Try again shortly.')}

        client.notify_challenge_ready(dns01['url'])
        auth_result = client.poll(order['authorizations'][0], ('valid', 'invalid'))
        if auth_result['status'] != 'valid':
            return {'error': f'DNS-01 validation failed: {auth_result}'}

        domain_key = _generate_rsa_keypair(2048)
        csr_der = _build_csr_der(domain, domain_key)
        client.finalize(order['finalize'], csr_der)
        order_result = client.poll(order_url, ('valid', 'invalid'))
        if order_result['status'] != 'valid':
            return {'error': f'Order finalization failed: {order_result}'}

        cert_pem = client.download_certificate(order_result['certificate'])
        HEADSCALE_CERTS_DIR.mkdir(parents=True, exist_ok=True)
        HEADSCALE_CERT_PATH.write_text(cert_pem, encoding='utf-8')
        HEADSCALE_KEY_PATH.write_text(_rsa_private_key_pem(domain_key), encoding='utf-8')
        return {'ok': True}
    except Exception as e:
        return {'error': str(e)}


# ── Tailscale client (join side — every device, including Windows members) ──

def install_tailscale_client(os_name, arch):
    if shutil.which('tailscale'):
        return {'ok': True, 'already': True}
    if os_name == 'linux':
        try:
            with tempfile.TemporaryDirectory() as tmp:
                script_path = Path(tmp) / 'install-tailscale.sh'
                req = urllib.request.Request('https://tailscale.com/install.sh', headers={'User-Agent': 'atlantis-installer'})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    script_path.write_bytes(resp.read())
                subprocess.run(['sh', str(script_path)], check=True, timeout=300)
        except Exception as e:
            return {'error': f'Tailscale install failed: {e}'}
        return {'ok': True}
    if os_name == 'macos':
        if shutil.which('brew'):
            try:
                subprocess.run(['brew', 'install', 'tailscale'], check=True, timeout=300)
            except Exception as e:
                return {'error': f'brew install failed: {e}'}
            return {'ok': True}
        return {'error': 'Homebrew not found — install Tailscale manually from tailscale.com/download; no unattended path exists for the GUI client.'}
    if os_name == 'windows':
        # There's no stable "latest.msi" URL — verified: it 404s. Tailscale
        # publishes a JSON manifest of the actual current filenames per arch,
        # which is what the exact MSI name has to be looked up from.
        try:
            with urllib.request.urlopen('https://pkgs.tailscale.com/stable/?mode=json', timeout=30) as resp:
                manifest = json.loads(resp.read())
            msi_name = manifest['MSIs'].get(arch)
            if not msi_name:
                return {'error': f'No Tailscale MSI published for arch "{arch}"'}
            with tempfile.TemporaryDirectory() as tmp:
                msi_path = Path(tmp) / msi_name
                urllib.request.urlretrieve(f'https://pkgs.tailscale.com/stable/{msi_name}', msi_path)
                # Installing Tailscale's network driver needs admin rights.
                # Plain `msiexec /quiet` run from a non-elevated process fails
                # with exit 1603 (verified) rather than prompting — Windows
                # won't silently self-elevate, by design. Routing through
                # PowerShell's -Verb RunAs surfaces the real UAC consent
                # dialog instead, which is the actual irreducible manual step
                # here (same category as the router port-forward setup).
                ps_cmd = (
                    f'Start-Process msiexec.exe -ArgumentList '
                    f'\'/quiet\',\'/i\',\'{msi_path}\',\'TS_NOLAUNCH=1\' -Verb RunAs -Wait'
                )
                result = subprocess.run(['powershell', '-NoProfile', '-Command', ps_cmd],
                                         capture_output=True, text=True, timeout=300)
                if result.returncode != 0:
                    return {'error': f'Tailscale install failed (needs admin approval via the UAC prompt): {result.stderr.strip()}'}
        except Exception as e:
            return {'error': f'Tailscale install failed: {e}'}
        return {'ok': True}
    return {'error': f'Unsupported OS: {os_name}'}


def _tailscale_bin():
    if shutil.which('tailscale'):
        return 'tailscale'
    return 'C:\\Program Files\\Tailscale\\tailscale.exe' if sys.platform == 'win32' else 'tailscale'


def tailscale_up(login_server, authkey):
    cmd = [_tailscale_bin(), 'up', f'--login-server={login_server}', f'--authkey={authkey}', '--accept-routes']
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        # Verified cause at least once: a fresh Tailscale install's first-ever
        # connection can trip a Windows Defender Firewall prompt ("allow this
        # app..."), which silently blocks the command until a human dismisses
        # it — `tailscale up` just hangs rather than erroring. Uncaught, this
        # took the whole HTTP request thread down with it (empty reply to the
        # client) instead of surfacing a clean message.
        return {'error': ('tailscale up timed out after 60s. If this is the first time Tailscale has run on '
                           'this device, check for a Windows Defender Firewall prompt asking to allow it — '
                           'approve it and try again.')}
    except Exception as e:
        return {'error': str(e)}
    if result.returncode != 0:
        return {'error': result.stderr.strip() or result.stdout.strip()}
    return {'ok': True}


def tailscale_status_json():
    result = _safe_run([_tailscale_bin(), 'status', '--json'], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        return None, result.stderr.strip()
    try:
        return json.loads(result.stdout), None
    except Exception as e:
        return None, str(e)


# ── Migration ─────────────────────────────────────────────────────────────────
# No SCP/file-transfer helper exists anywhere else in this codebase — every
# existing SSH helper (check_ssh_access, fetch_mac, probe_host_sysinfo in
# server.py) only ever runs a remote command and captures text. Moving
# Headscale's state (private key + sqlite db) needs an actual file payload,
# so this pipes a tar archive through ssh's stdin rather than using scp
# (sidesteps the `scp -O` legacy-protocol flag mess on modern OpenSSH).
# The archive is self-generated by this same module, not an arbitrary upload,
# so extractall() here carries no more risk than the ssh command execution
# every other host helper already trusts.

def export_party_state_archive(extra_settings):
    """extra_settings carries the small metadata (headscaleApiKey,
    headscaleUrl, duckdnsDomain, duckdnsToken, acmeEmail) that must travel
    with the state files, since the target device has never held this
    settings-table state before. Unlike the abandoned Quick Tunnel design,
    headscaleUrl (the DuckDNS domain) DOES carry over unchanged — see
    _migrate_receive's docstring for why that's now possible. The certs dir
    (cert.pem/key.pem/acme_account_key.json) travels too, so the new host
    doesn't need to immediately re-issue a certificate (kinder to Let's
    Encrypt's rate limits, and the new host comes up faster)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        if HEADSCALE_STATE.exists():
            tf.add(HEADSCALE_STATE, arcname='headscale_state')
        if HEADSCALE_CERTS_DIR.exists():
            tf.add(HEADSCALE_CERTS_DIR, arcname='headscale_certs')
        meta_bytes = json.dumps(extra_settings).encode()
        info = tarfile.TarInfo(name='party_meta.json')
        info.size = len(meta_bytes)
        tf.addfile(info, io.BytesIO(meta_bytes))
    return buf.getvalue()


def push_state_over_ssh(ip, ssh_user, archive_bytes, remote_tmp_path='/tmp/atlantis_party_state.tar.gz'):
    try:
        result = subprocess.run(
            ['ssh', *_SSH_FLAGS, f'{ssh_user}@{ip}', f'cat > {remote_tmp_path}'],
            input=archive_bytes, capture_output=True, timeout=60)
        if result.returncode != 0:
            return {'error': result.stderr.decode(errors='replace').strip()}
    except Exception as e:
        return {'error': str(e)}
    return {'ok': True, 'remotePath': remote_tmp_path}


def probe_remote_arch(ip, ssh_user):
    result = _safe_run(['ssh', *_SSH_FLAGS, f'{ssh_user}@{ip}', 'uname -m'],
                        capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        return None
    m = result.stdout.strip().lower()
    if m in ('x86_64', 'amd64'):
        return 'amd64'
    if m in ('aarch64', 'arm64'):
        return 'arm64'
    return 'arm' if m.startswith('armv7') else None


def local_lan_ip():
    """UDP connect trick (no packets actually sent) to ask the OS which
    interface/IP would be used for outbound traffic — the LAN IP the router's
    port-forward rule needs to point at. Same technique server.py's
    local_ips() already uses."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except Exception:
        return None


def probe_remote_atlantis_path(ip, ssh_user):
    """Best-effort; ambiguous or empty results fall back to asking the user
    to type the path once — deliberately not a new required Host field."""
    result = _safe_run(
        ['ssh', *_SSH_FLAGS, f'{ssh_user}@{ip}', 'find ~ -maxdepth 4 -name launcher.py 2>/dev/null'],
        capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        return None
    candidates = [line.rsplit('/', 1)[0] for line in result.stdout.strip().splitlines() if line.strip()]
    return candidates[0] if len(candidates) == 1 else None


# ── CLI entry point — invoked over ssh on the migration target ──────────────

def _migrate_receive(archive_path):
    """Runs ON the target machine against its own local paths and DB — never
    assumes anything about the source machine's layout. Actually brings the
    new host fully up (not just flags + a restart-and-hope).

    Unlike the abandoned Quick Tunnel design, the public hostname (DuckDNS
    domain) DOES carry over unchanged — export_party_state_archive's meta
    includes it, and update_duckdns() re-points that same domain at this
    machine's current public IP automatically. What can't be automated: if
    the new host is a *different device* than the old one, the router's
    port-forward rule (WAN 443/80 -> old device's LAN IP) still points at the
    old device and must be manually updated to this device's LAN IP — no
    portable API exists across consumer router firmwares to script that."""
    PARTY_DIR.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path) as tf:
        tf.extractall(PARTY_DIR)

    extracted_state = PARTY_DIR / 'headscale_state'
    if extracted_state.exists():
        HEADSCALE_STATE.parent.mkdir(parents=True, exist_ok=True)
        if HEADSCALE_STATE.exists():
            shutil.rmtree(HEADSCALE_STATE)
        shutil.move(str(extracted_state), str(HEADSCALE_STATE))

    extracted_certs = PARTY_DIR / 'headscale_certs'
    if extracted_certs.exists():
        HEADSCALE_CERTS_DIR.parent.mkdir(parents=True, exist_ok=True)
        if HEADSCALE_CERTS_DIR.exists():
            shutil.rmtree(HEADSCALE_CERTS_DIR)
        shutil.move(str(extracted_certs), str(HEADSCALE_CERTS_DIR))

    meta = {}
    meta_path = PARTY_DIR / 'party_meta.json'
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        meta_path.unlink()

    headscale_url  = meta.get('headscaleUrl')
    duckdns_domain = meta.get('duckdnsDomain')
    duckdns_token  = meta.get('duckdnsToken')
    acme_email     = meta.get('acmeEmail', '')

    os_name, arch = detect_os(), detect_arch()
    mode = pick_host_mode(os_name)
    if mode == 'native':
        if not HEADSCALE_BIN.exists():
            install_headscale_native(os_name, arch)
    else:
        install_headscale_docker()

    # Certs travel with the archive (see export_party_state_archive) — only
    # re-issue here if that somehow didn't happen (e.g. an older archive).
    if not (HEADSCALE_CERT_PATH.exists() and HEADSCALE_KEY_PATH.exists()) and headscale_url and duckdns_token:
        issue_certificate_dns01(headscale_url, acme_email, duckdns_token)

    write_headscale_config(headscale_url, mode)
    write_party_host_flag(mode)

    if mode == 'docker':
        start_headscale_docker()
    else:
        # This runs as a one-shot script over ssh, not inside the supervised
        # launcher.py process — touch its restart flag so *it* spawns
        # headscale, same as every other native-mode start path.
        (DATA_DIR / '.restart').touch()

    headscale_up = False
    for _ in range(20):
        if headscale_responds():
            headscale_up = True
            break
        time.sleep(1)

    duckdns_result = {'error': 'skipped: headscale did not come up in time'}
    if headscale_up and duckdns_domain and duckdns_token:
        duckdns_result = update_duckdns(duckdns_domain, duckdns_token)

    import sqlite3
    con = sqlite3.connect(DATA_DIR / 'data.db')
    settings_to_write = {
        'partyRole': 'host',
        'partyHostMode': mode,
        'headscaleApiKey': meta.get('headscaleApiKey'),
        'headscaleUrl': headscale_url,
        'duckdnsDomain': duckdns_domain,
        'duckdnsToken': duckdns_token,
        'acmeEmail': acme_email,
    }
    for key, value in settings_to_write.items():
        if value is not None:
            con.execute('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', (key, json.dumps(value)))
    con.commit()
    con.close()

    result = {
        'ok': headscale_up and duckdns_result.get('ok', False),
        'mode': mode,
        'headscaleUrl': headscale_url,
        'localLanIp': local_lan_ip(),
        'duckdnsUpdated': duckdns_result.get('ok', False),
        'error': None if headscale_up else 'Headscale did not come up in time',
        'note': ('If this is a different physical device than the previous host, update your '
                 'router\'s port-forward rule (WAN 443/80) to point at this device\'s LAN IP, '
                 'shown above as localLanIp.'),
    }
    print(json.dumps(result))


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'migrate-receive' and '--archive' in sys.argv:
        idx = sys.argv.index('--archive')
        if idx + 1 < len(sys.argv):
            _migrate_receive(sys.argv[idx + 1])
            sys.exit(0)
    print(json.dumps({'error': 'usage: party.py migrate-receive --archive <path>'}))
    sys.exit(1)
