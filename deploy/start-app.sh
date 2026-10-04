#!/usr/bin/env bash
# Starts the processes of the app container and watches them: the PHP API
# (migrates first), the outbox relay, the gateway and the dashboard. When one
# of them stops, the others stop too and the container exits, so Docker's
# restart policy starts everything again.
#   API      127.0.0.1:9000 (FrankenPHP)
#   gateway  127.0.0.1:9001 (sign-in, sessions, per-bot access; talks to the API)
#   dashboard :8080 (the only public port; talks to the gateway)
set -uo pipefail
BOTHUB_INTERNAL_KEY="${BOTHUB_INTERNAL_KEY:-}"

# "start-app hash-password <pw>": print an Argon2id hash for BOTHUB_ADMIN_PASSWORD.
if [[ "${1:-}" == "hash-password" ]]; then
  shift
  exec bothub-gateway hash-password "$@"
fi

# Shared secret of gateway and API (/internal/*). Without it the gateway
# runs in memory only (no database). Empty or too short: use a generated
# one, kept in /data so it stays the same across restarts.
if [[ ${#BOTHUB_INTERNAL_KEY} -lt 32 ]]; then
  [[ -n "${BOTHUB_INTERNAL_KEY:-}" ]] && echo "start-app: BOTHUB_INTERNAL_KEY is shorter than 32 characters, using the generated key" >&2
  keyfile="${DATA_DIR:-/data}/internal.key"
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

LISTEN_ADDR=":9001" PHP_API_URL="http://127.0.0.1:9000" bothub-gateway &
pids+=($!)

LISTEN_ADDR=":8080" API_URL="http://127.0.0.1:9001" bothub-dashboard &
pids+=($!)

# The first process that ends takes the container down (restart policy).
wait -n
echo "start-app: a process stopped, restarting the container" >&2
stop_all 1
