#!/usr/bin/env bash
# Spins up N agents on one project at the same time. Each agent forks, edits, and submits; the
# coordinator lands them one by one. Two extra agents edit the same line to show conflict handling.
# Usage: MAGGOT_URL=http://127.0.0.1:8787 scripts/demo.sh [agents=6]
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-6}
maggot() { node cli/maggot.ts "$@"; }
PROJECT="demo-$(date +%s)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

maggot init "$PROJECT" --description "maggot concurrency demo"

agent() {
  local i=$1 dir="$WORK/agent-$i"
  maggot start "$PROJECT" "Add feature $i" --agent "agent-$i" --paths "features/f$i.ts" --dir "$dir" >/dev/null
  mkdir -p "$dir/features"
  echo "export const feature$i = () => $i;" > "$dir/features/f$i.ts"
  maggot submit "$dir" -m "Add feature $i" --wait
}

echo "== $N agents working concurrently =="
pids=()
for i in $(seq 1 "$N"); do agent "$i" & pids+=($!); done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=$((failed + 1)); done
echo "== $((N - failed))/$N agents merged =="

echo "== two agents edit the same line =="
maggot start "$PROJECT" "Rename project (left)" --agent left --paths README.md --dir "$WORK/left" >/dev/null
maggot start "$PROJECT" "Rename project (right)" --agent right --paths README.md --dir "$WORK/right" | grep warning || true
sed -i '1s/.*/# maggot demo (left)/' "$WORK/left/README.md"
sed -i '1s/.*/# maggot demo (right)/' "$WORK/right/README.md"
maggot submit "$WORK/left" --wait
maggot submit "$WORK/right" --wait || echo "-> right conflicted as expected; resolving"

maggot sync "$WORK/right" || true
printf '# maggot demo (left + right)\n' > "$WORK/right/README.md.new"
tail -n +2 "$WORK/right/README.md" | grep -vE '^(<<<<<<<|=======|>>>>>>>)' | grep -v '^# maggot demo' >> "$WORK/right/README.md.new" || true
mv "$WORK/right/README.md.new" "$WORK/right/README.md"
git -C "$WORK/right" add -A && git -C "$WORK/right" commit -qm "Resolve README conflict"
maggot submit "$WORK/right" --wait

echo "== final state =="
maggot tasks "$PROJECT"
curl -s -H "authorization: Bearer ${MAGGOT_API_KEY:-dev}" "${MAGGOT_URL:-http://127.0.0.1:8787}/api/projects/$PROJECT/files/README.md"
