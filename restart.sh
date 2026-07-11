#!/usr/bin/env bash
systemctl --user restart atlantis-server.service atlantis-worker.service atlantis-code-server.service atlantis-searxng.service
systemctl --user status atlantis-server.service atlantis-worker.service atlantis-code-server.service atlantis-searxng.service --no-pager | head -24