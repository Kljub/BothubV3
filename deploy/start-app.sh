#!/usr/bin/env bash
# Starts the processes of the app container and watches them: the PHP API
# (migrates first), the outbox relay, the gateway and the dashboard. When one
# of them stops, the others stop too and the container exits, so Docker's
# restart policy starts everything again.
#   API      127.0.0.1:9000 (FrankenPHP, localhost only)
#   gateway  127.0.0.1:9001 (sign-in, sessions, per-bot access; localhost only)
#   dashboard :8080 (the only port reachable from outside; talks to the gateway)
#
# Keys live in KEYS_DIR (/keys, its own volume), not next to the database in
# /data: secret.key (encrypts tokens and secrets), internal.key (gateway ↔ API),
# redis.pass (written by the redis service). Old installs keep theirs in
# /data; they are moved over on the first start.
set -uo pipefail
BOTHUB_INTERNAL_KEY="${BOTHUB_INTERNAL_KEY:-}"

# "start-app hash-password <pw>": print an Argon2id hash for BOTHUB_ADMIN_PASSWORD.
if [[ "${1:-}" == "hash-password" ]]; then
  shift
  exec bothub-gateway hash-password "$@"
fi

# "start-app recover-admin <RECOVERY-KEY> [username]": the admin account back
# (Admin → Security → Recovery key). Then the gateway restarts, so it loads
# the new password; the container comes back by itself.
if [[ "${1:-}" == "recover-admin" ]]; then
  shift
  php /app/bin/recover-admin.php "$@" || exit $?
  pkill -f bothub-gateway 2>/dev/null && echo "The dashboard restarts now (a few seconds)."
  exit 0
fi

KEYS_DIR="${KEYS_DIR:-/keys}"
export KEYS_DIR
mkdir -p "$KEYS_DIR"
chmod 750 "$KEYS_DIR" 2>/dev/null
# Keys of older installs: out of the data folder.
for f in secret.key internal.key; do
  if [[ -s "${DATA_DIR:-/data}/$f" && ! -s "$KEYS_DIR/$f" ]]; then
    mv "${DATA_DIR:-/data}/$f" "$KEYS_DIR/$f" && echo "start-app: moved $f to $KEYS_DIR" >&2
  fi
done

# Shared secret of gateway and API (/internal/*). Without it the gateway
# runs in memory only (no database). Empty or too short: use a generated
# one, kept in /data so it stays the same across restarts.
if [[ ${#BOTHUB_INTERNAL_KEY} -lt 32 ]]; then
  [[ -n "${BOTHUB_INTERNAL_KEY:-}" ]] && echo "start-app: BOTHUB_INTERNAL_KEY is shorter than 32 characters, using the generated key" >&2
  keyfile="$KEYS_DIR/internal.key"
  if [[ ! -s "$keyfile" ]]; then
    (umask 077 && php -r 'echo bin2hex(random_bytes(32));' > "$keyfile")
  fi
  BOTHUB_INTERNAL_KEY="$(cat "$keyfile")"
  export BOTHUB_INTERNAL_KEY
fi

pids=()
stop_all() {
  trap - TERM INT
  kill -TERM "${pids[@]}" 2>/dev/null
  wait
  exit "${1:-0}"
}
trap 'stop_all 0' TERM INT

# Redis password (written by the redis service): into REDIS_URL of the API,
# relay and gateway, unless the URL brings one.
if [[ -s "$KEYS_DIR/redis.pass" && "${REDIS_URL:-}" != *@* ]]; then
  REDIS_URL="redis://:$(cat "$KEYS_DIR/redis.pass")@${REDIS_URL#redis://}"
  export REDIS_URL
fi

# API: migrations, shared data, then FrankenPHP (the image's entrypoint).
/app/bin/entrypoint.sh --config /etc/frankenphp/Caddyfile --adapter caddyfile &
pids+=($!)

# Wait for the API (migrations can take a moment).
for _ in $(seq 1 60); do
  php -r 'exit(@file_get_contents("http://127.0.0.1:9000/api/health") === false ? 1 : 0);' && break
  sleep 1
done

php /app/bin/relay.php &
pids+=($!)

# The bot (user node, group 1000) reads secret.key; nobody else.
if [[ -s "$KEYS_DIR/secret.key" ]]; then
  chgrp 1000 "$KEYS_DIR" "$KEYS_DIR/secret.key" 2>/dev/null
  chmod 640 "$KEYS_DIR/secret.key" 2>/dev/null
fi

LISTEN_ADDR="127.0.0.1:9001" PHP_API_URL="http://127.0.0.1:9000" bothub-gateway &
pids+=($!)

LISTEN_ADDR=":8080" API_URL="http://127.0.0.1:9001" bothub-dashboard &
pids+=($!)

# The first process that ends takes the container down (restart policy).
wait -n
echo "start-app: a process stopped, restarting the container" >&2
stop_all 1
