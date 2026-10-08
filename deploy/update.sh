#!/bin/sh
# Update without offline bots (Admin → Server settings → Updates; run by the
# updater helper in the repository after "git pull").
#
#  1. Build the new images while everything runs.
#  2. Start a second BotCore from the new image ("handover" role). It logs
#     the same bots in; while the flag bothub:overlap is set, every Discord
#     event is handled by only one core (Redis claim, bot/src/core/handover.ts).
#  3. Restart the services (the bot service gets the new image). Meanwhile
#     the second core answers.
#  4. When the new bot service runs its bots, stop the second core.
#
# If the second core does not come up, the update goes on as before (the
# bots are offline for the restart).

set -u
step() { echo "--- $* ---"; }
rc() { docker compose exec -T redis redis-cli "$@" 2>/dev/null; }
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

step building
docker compose --progress plain build || exit 1

handover=0
if docker compose ps --status running --services 2>/dev/null | grep -qx bot; then
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

old=$(rc GET bothub:core:ready:main | tr -d '\r')
step restarting
docker compose up -d --remove-orphans
status=$?

if [ "$handover" = 1 ]; then
  wait_key bothub:core:ready:main 240 "$old" || step "the new BotCore is slow; stopping the second one anyway"
  step "stopping the second BotCore"
  docker stop -t 30 bothub-bot-handover >/dev/null 2>&1
fi
docker rm -f bothub-bot-handover >/dev/null 2>&1
rc DEL bothub:overlap >/dev/null
step done
exit "$status"
