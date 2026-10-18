#!/usr/bin/env bash
# macOS / Linux / Raspberry Pi launcher (on a Pi, run ./setup_pi.sh once first).
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
exec .venv/bin/python run.py
