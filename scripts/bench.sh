#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root="$(dirname -- "$script_dir")"
csv_path="${1:-$root/results/bench.csv}"
if [[ $# -gt 0 ]]; then
    shift
fi
fixture_source="$root/test/bench/fixtures/bench-loop.c"
fixture_binary="$root/test/bench/fixtures/bench-loop"

npm run build --workspace @earendil-works/pi-debugger-core
gcc -g -O0 "$fixture_source" -o "$fixture_binary"
npm exec --workspace @earendil-works/pi-debugger-core -- tsx "$root/test/bench/latency-bench.ts" --csv "$csv_path" "$@"
