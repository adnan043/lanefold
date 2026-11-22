#!/usr/bin/env bash
# One load level against the LOCAL site: k6 + a machine monitor (stops k6 when this computer runs low) + the
# data-consistency check + a short report.
#
#   K6=/path/to/k6 tests/load/run-level.sh <hot|spread> <vus> [ramp] [hold]
#
# Stops k6 early when MemAvailable < MIN_FREE_MB (default 1000): the result is then marked ABORTED (machine),
# never reported as an app limit.
set -euo pipefail
cd "$(dirname "$0")/../.."

SCENARIO=${1:?hot or spread}
VUS=${2:?number of users}
RAMP=${3:-1m}
HOLD=${4:-3m}
K6=${K6:-k6}
MIN_FREE_MB=${MIN_FREE_MB:-1000}
NAME="${SCENARIO}-${VUS}"
DIR=tests/load/results
mkdir -p "$DIR"
MON="$DIR/$NAME.mon.csv"
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

"$K6" run --quiet -e SCENARIO="$SCENARIO" -e VUS="$VUS" -e RAMP="$RAMP" -e HOLD="$HOLD" \
  -e OUT="$DIR/$NAME.json" tests/load/app-user.js >"$DIR/$NAME.k6.log" 2>&1 &
K6PID=$!

# The site's own processes: this project's astro dev server and EVERY process under it (its workerd runtime is
# where requests run). Another project's dev server on this computer is left out.
descendants() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants "$p"; done; }
SITE_PIDS=""
for p in $(pgrep -f "bin/node .*node_modules/astro/bin/astro"); do
  if [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$PWD" ]; then SITE_PIDS="$SITE_PIDS $p $(for d in $(descendants "$p"); do [ "$(cat /proc/$d/comm 2>/dev/null)" = workerd ] && echo "$d"; done)"; fi
done
SITE_PIDS=$(echo $SITE_PIDS | tr ' ' ',')
[ -n "$SITE_PIDS" ] || { echo "No astro dev server of this project is running." >&2; exit 1; }

echo "t,mem_avail_mb,swap_free_mb,load1,k6_rss_mb,k6_cpu,site_rss_mb,site_cpu" >"$MON"
ABORT=""
while kill -0 "$K6PID" 2>/dev/null; do
  AV=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  SW=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
  L1=$(cut -d' ' -f1 /proc/loadavg)
  # CURRENT CPU % (top, one 1 s sample; ps would give the lifetime average) and memory.
  K=$(top -b -n1 -d1 -p "$K6PID" 2>/dev/null | awk -v p="$K6PID" '$1==p {split($6,a,"g"); printf "%d,%.0f", ($6 ~ /g/ ? a[1]*1024 : $6/1024), $9}')
  S=$(top -b -n1 -d1 -p "$SITE_PIDS" 2>/dev/null | awk 'NR>7 && $1 ~ /^[0-9]+$/ {m=$6; if (m ~ /g/) {sub("g","",m); m*=1048576} r+=m; c+=$9} END {printf "%d,%.0f", r/1024, c}')
  echo "$(date +%s),$AV,$SW,$L1,${K:-0,0},${S:-0,0}" >>"$MON"
  if [ "$AV" -lt "$MIN_FREE_MB" ]; then
    ABORT="machine: MemAvailable ${AV} MB, swap free ${SW} MB"
    kill -INT "$K6PID" 2>/dev/null || true
    sleep 5
    kill -9 "$K6PID" 2>/dev/null || true
    break
  fi
  sleep 5
done
wait "$K6PID" 2>/dev/null && K6RC=0 || K6RC=$?

SENT=$(node -e "try{const d=require('./$DIR/$NAME.json');console.log(d.metrics.chat_sent_ok?.values?.count??0)}catch{console.log(0)}")
node --env-file=.env tests/load/check.mjs --since "$SINCE" --sent "$SENT" >"$DIR/$NAME.check.json"
node tests/load/report.mjs "$NAME" "$K6RC" "$ABORT"
