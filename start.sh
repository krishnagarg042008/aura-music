#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Activate virtualenv if present
if [ -d "$DIR/.venv" ]; then
    source "$DIR/.venv/bin/activate"
fi

export PORT="${PORT:-8000}"
export HOST="${HOST:-0.0.0.0}"

echo "Starting AURA Music on http://$HOST:$PORT ..."
exec python3 run.py
