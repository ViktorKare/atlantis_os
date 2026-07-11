#!/usr/bin/env bash
# Install and start Atlantis OS as systemd user services.
# Run once: bash setup-services.sh
# After that: systemctl --user {start|stop|restart|status} atlantis-server atlantis-worker

set -e
UNIT_DIR="$HOME/.config/systemd/user"
PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$UNIT_DIR"
cp "$PROJ_DIR/atlantis-server.service"      "$UNIT_DIR/"
cp "$PROJ_DIR/atlantis-worker.service"      "$UNIT_DIR/"
cp "$PROJ_DIR/atlantis-code-server.service" "$UNIT_DIR/"
cp "$PROJ_DIR/atlantis-searxng.service"     "$UNIT_DIR/"

systemctl --user daemon-reload
systemctl --user enable atlantis-server.service atlantis-worker.service atlantis-code-server.service atlantis-searxng.service
systemctl --user restart atlantis-server.service atlantis-worker.service atlantis-code-server.service atlantis-searxng.service

echo ""
echo "Atlantis OS running."
echo "  UI:          http://localhost:5000"
echo "  code-server: http://localhost:5001"
echo "  SearXNG:     http://localhost:5002"
echo "  Logs:   journalctl --user -u atlantis-server -f"
echo "          journalctl --user -u atlantis-worker -f"
echo "          journalctl --user -u atlantis-code-server -f"
echo "          journalctl --user -u atlantis-searxng -f"
echo "  Stop:   systemctl --user stop atlantis-server atlantis-worker atlantis-code-server atlantis-searxng"
echo "  Status: systemctl --user status atlantis-server atlantis-worker atlantis-code-server atlantis-searxng"
