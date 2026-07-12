#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v python3 &> /dev/null; then
    echo "Installing Xcode Command Line Tools (includes python3)..."
    xcode-select --install
    echo "Please re-run this file after that installer finishes."
    exit 1
fi
python3 install.py
