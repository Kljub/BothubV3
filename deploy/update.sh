#!/bin/sh
# Update without offline bots (Admin → Server settings → Updates; run by the
# updater helper in the repository after "git pull"; OLD_COMMIT is the
# commit before the pull).
#
#  1. Back up the database (VACUUM INTO data/backups/pre-update-<time>.sqlite,
#     the last 3 are kept).
#  2. Build the new images while everything runs.
#  3. Start a second BotCore from the new image ("handover" role). It logs
#     the same bots in; while the flag bothub:overlap is set, every Discord
#     event is handled by only one core (Redis claim, bot/src/core/handover.ts).
#  4. Restart the services (the bot service gets the new image). Meanwhile
#     the second core answers.
#  5. Check: the dashboard reports healthy and the new BotCore runs its bots.
#     If not, roll back: the old commit, the database backup, rebuild.
#  6. When everything runs, stop the second core and remove old images.
#
# The first update after the encryption at rest encrypts the database (the
# app does it at its start); the bots are stopped for that one restart.
#
# If the second core does not come up, the update goes on as before (the
# bots are offline for the restart).

set -u
step() { echo "--- $* ---"; }
rc() { docker compose exec -T redis sh -c 'if [ -s /keys/redis.pass ]; then exec redis-cli -a "$(cat /keys/redis.pass)" --no-auth-warning "$@"; else exec redis-cli "$@"; fi' -- "$@" 2>/dev/null; }
# wait_key <key> <seconds> [old value]: until the key exists (and differs from the old value)
wait_key() {
  i=0
  while [ "$i" -lt "$2" ]; do
    v=$(rc GET "$1" | tr -d '\r')
    if [ -n "$v" ] && [ "$v" != "${3:-}" ]; then return 0; fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}
# wait_healthy <service> <seconds>: until Docker reports the service healthy
wait_healthy() {
  i=0
  while [ "$i" -lt "$2" ]; do
    id=$(docker compose ps -q "$1" 2>/dev/null | head -n 1)
    if [ -n "$id" ]; then
      h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
      [ "$h" = "healthy" ] || [ "$h" = "running" ] && return 0
    fi
    sleep 3
    i=$((i + 3))
  done
  return 1
}
cleanup_handover() {
  docker stop -t 30 bothub-bot-handover >/dev/null 2>&1
  docker rm -f bothub-bot-handover >/dev/null 2>&1
  rc DEL bothub:overlap >/dev/null
}

# --- 1. database backup (the app container has PHP and SQLite) ---
backup=""
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  step "backing up the database"
  name="pre-update-$(date -u +%Y%m%d-%H%M%S).sqlite"
  if docker compose exec -T app php -r '
    require "/app/src/autoload.php";
    $dir = "/data/backups";
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    // Through Connection: an encrypted database is backed up encrypted.
    $pdo = BotHub\Database\Connection::open("/data/bothub.sqlite");
    $pdo->exec("VACUUM INTO " . $pdo->quote($dir . "/" . $argv[1]));
    $old = glob($dir . "/pre-update-*.sqlite");
    sort($old);
    foreach (array_slice($old, 0, max(0, count($old) - 3)) as $f) unlink($f);
  ' "$name"; then
    backup="$name"
    echo "backup: data/backups/$name"
  else
    step "the backup failed: a failed update can roll back the code, not the data"
  fi
fi

# --- 2. build ---
step building
docker compose --progress plain build || exit 1

# A database that is still plain gets encrypted once by the new app at its
# start; no BotCore may hold it open meanwhile, so this update runs without
# the second core and stops the bots for the restart.
plain_db=0
if docker compose exec -T app sh -c 'head -c 15 /data/bothub.sqlite 2>/dev/null' | grep -q '^SQLite format 3'; then
  plain_db=1
  step "the database gets encrypted: the bots restart without a second BotCore"
fi

# --- 3. second BotCore ---
handover=0
bot_running=0
if docker compose ps --status running --services 2>/dev/null | grep -qx bot && [ "$plain_db" = 1 ]; then
  bot_running=1
  docker compose stop bot >/dev/null 2>&1
elif docker compose ps --status running --services 2>/dev/null | grep -qx bot; then
  bot_running=1
  step "starting a second BotCore for the switch"
  rc SET bothub:overlap 1 EX 900 >/dev/null
  docker rm -f bothub-bot-handover >/dev/null 2>&1
  if docker compose run -d --no-deps --name bothub-bot-handover -e BOTHUB_CORE_ROLE=handover bot >/dev/null && wait_key bothub:core:ready:handover 180; then
    handover=1
    step "second BotCore runs the bots"
  else
    step "second BotCore did not start: the bots restart as before"
  fi
fi

# --- 4. restart ---
old=$(rc GET bothub:core:ready:main | tr -d '\r')
step restarting
docker compose up -d --remove-orphans
status=$?

# --- 5. check ---
step "checking the new version"
ok=1
[ "$status" = 0 ] || ok=0
if [ "$ok" = 1 ] && ! wait_healthy app 180; then
  echo "the dashboard did not become healthy"
  ok=0
fi
if [ "$ok" = 1 ] && [ "$bot_running" = 1 ] && ! wait_key bothub:core:ready:main 240 "$old"; then
  echo "the new BotCore did not start its bots"
  ok=0
fi

if [ "$ok" = 0 ] && [ -n "${OLD_COMMIT:-}" ]; then
  step "rolling back to $(echo "$OLD_COMMIT" | cut -c1-7)"
  docker compose logs --tail 40 app bot 2>/dev/null | tail -n 40
  git reset -q --hard "$OLD_COMMIT"
  if [ -n "$backup" ]; then
    docker compose stop app bot >/dev/null 2>&1
    docker compose run --rm --no-deps --entrypoint sh app -c "cp /data/backups/$backup /data/bothub.sqlite && rm -f /data/bothub.sqlite-wal /data/bothub.sqlite-shm" \
      && echo "database restored from data/backups/$backup"
  fi
  docker compose --progress plain build && docker compose up -d --remove-orphans
  wait_healthy app 180 || echo "the old version did not report healthy either: check the containers by hand"
  cleanup_handover
  step "rolled back"
  exit 1
fi

# --- 6. done ---
if [ "$handover" = 1 ]; then
  step "stopping the second BotCore"
fi
cleanup_handover
if [ "$ok" = 1 ]; then
  step "cleaning up old images"
  docker image prune -f >/dev/null 2>&1
fi
step done
[ "$ok" = 1 ] && exit 0 || exit 1
