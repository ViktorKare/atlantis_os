#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v python3 &> /dev/null; then
    echo "python3 not found. Install it with your package manager, e.g.:"
    echo "  sudo apt install python3      (Debian/Ubuntu)"
    echo "  sudo dnf install python3      (Fedora)"
    exit 1
fi
python3 install.py
