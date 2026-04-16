#!/bin/bash
set -e

# The Supervisor mounts /data as persistent storage for this add-on.
export DB_PATH="/data/homeboard.db"

# PORT is provided via the ingress configuration.
# Defaults to 8000 if not set (e.g. during local dev).
export PORT="${PORT:-8000}"

echo "[HomeBoard] Starting on port ${PORT}"
echo "[HomeBoard] Database: ${DB_PATH}"

exec python /app/main.py
