#!/usr/bin/with-contenv bashio

# bashio is the HA Supervisor shell helper library.
# It provides logging, config reading, and ingress port resolution.

# Resolve the ingress port assigned by the Supervisor.
# Falls back to 8000 if not running under the Supervisor (local dev).
PORT="${PORT:-8000}"

# The Supervisor mounts /data as a persistent volume for this add-on.
# All state (the SQLite file) lives here and survives updates/reinstalls.
export DB_PATH="/data/homeboard.db"
export PORT

bashio::log.info "Starting HomeBoard on port ${PORT}"
bashio::log.info "Database path: ${DB_PATH}"

exec python /app/main.py
