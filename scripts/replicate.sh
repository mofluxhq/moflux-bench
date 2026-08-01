#!/usr/bin/env bash
# Runs the full arm set across several seeds. One run of one seed is an
# anecdote; published numbers need medians and spread.
#
#   bash scripts/replicate.sh 5 45000
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SEEDS="${1:-5}"
PHASE_MS="${2:-45000}"
mkdir -p results/replicates

for seed in $(seq 1 "$SEEDS"); do
  echo "=== seed $seed ==="
  node demo/run-demo.mjs \
    --pause-ms=0 --skip-verify --seed="$seed" --phase-ms="$PHASE_MS"
  cp results/comparison.json "results/replicates/comparison-seed$seed.json"
done

echo
echo "Aggregating $SEEDS seeds..."
node scripts/aggregate.mjs results/replicates
