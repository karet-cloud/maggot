#!/usr/bin/env bash
# Spins up N agents on one project at the same time. Each agent forks, edits, and submits; the
# coordinator lands them one by one. Two extra agents edit the same line to show conflict handling.
# Usage: MEGIT_URL=http://127.0.0.1:8787 scripts/demo.sh [agents=6]
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-6}
megit() { node cli/megit.ts "$@"; }
PROJECT="demo-$(date +%s)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

megit init "$PROJECT" --description "megit concurrency demo"

agent() {
  local i=$1 dir="$WORK/agent-$i"
  megit start "$PROJECT" "Add feature $i" --agent "agent-$i" --paths "features/f$i.ts" --dir "$dir" >/dev/null
  mkdir -p "$dir/features"
  echo "export const feature$i = () => $i;" > "$dir/features/f$i.ts"
  megit submit "$dir" -m "Add feature $i" --wait
}

echo "== $N agents working concurrently =="
pids=()
for i in $(seq 1 "$N"); do agent "$i" & pids+=($!); done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
echo "== $((N - failed))/$N agents merged =="

echo "== two agents edit the same line =="
megit start "$PROJECT" "Rename project (left)" --agent left --paths README.md --dir "$WORK/left" >/dev/null
megit start "$PROJECT" "Rename project (right)" --agent right --paths README.md --dir "$WORK/right" | grep warning || true
sed -i '1s/.*/# megit demo (left)/' "$WORK/left/README.md"
sed -i '1s/.*/# megit demo (right)/' "$WORK/right/README.md"
megit submit "$WORK/left" --wait
megit submit "$WORK/right" --wait || echo "-> right conflicted as expected; resolving"

megit sync "$WORK/right" || true
printf '# megit demo (left + right)\n' > "$WORK/right/README.md.new"
tail -n +2 "$WORK/right/README.md" | grep -vE '^(<<<<<<<|=======|>>>>>>>)' | grep -v '^# megit demo' >> "$WORK/right/README.md.new" || true
mv "$WORK/right/README.md.new" "$WORK/right/README.md"
git -C "$WORK/right" add -A && git -C "$WORK/right" commit -qm "Resolve README conflict"
megit submit "$WORK/right" --wait

echo "== final state =="
megit tasks "$PROJECT"
curl -s -H "authorization: Bearer ${MEGIT_API_KEY:-dev}" "${MEGIT_URL:-http://127.0.0.1:8787}/api/projects/$PROJECT/files/README.md"
