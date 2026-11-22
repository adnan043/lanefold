#!/usr/bin/env bash
# Runs the levels in order, never skipping one; stops at the first STOP condition (k6 aborted on a threshold,
# or this machine ran low). A missed target (FAIL) does not stop the ladder.
#   K6=… tests/load/run-ladder.sh <hot|spread> "10 25 50 100 250 500" [ramp] [hold]
set -uo pipefail
cd "$(dirname "$0")/../.."
SCENARIO=$1; LEVELS=$2; RAMP=${3:-1m}; HOLD=${4:-3m}
for n in $LEVELS; do
  tests/load/run-level.sh "$SCENARIO" "$n" "$RAMP" "$HOLD" | tee -a "tests/load/results/${SCENARIO}-ladder.md"
  last=$(tail -1 tests/load/results/summary.md)
  case "$last" in
    *"| ABORTED |"*) echo "STOP: this computer ran low at $n users"; exit 2;;
    *"| STOP |"*) echo "STOP: stop condition (p95 > 3 s or errors > 5 %) at $n users"; exit 3;;
  esac
  sleep 20 # let the server settle between levels
done
