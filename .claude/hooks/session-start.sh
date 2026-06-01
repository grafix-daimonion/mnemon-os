#!/usr/bin/env bash
# Mnemon-OS SessionStart hook — D2 (MEMORY_ARCHITECTURE_DECISION_v3) / IMPL_SPEC_v2 §8.
#
# Deterministic working-memory load at session boot. Prints the current date/tz so the
# agent never greets blind to time, then the last N days of diary entries so the agent
# wakes up oriented to recent context.
#
# Risk 2 LOCKED: DIARY_LAST_N=5. Matches the CLAUDE.md soft-fallback default so the hook
# and the soft instruction agree on the recall window. Change here is a deliberate edit;
# don't drift between hook and instruction.
#
# Quiet on failure: never blocks the session start. If the diary is unreachable, the
# session still opens with just the date.

set -u
DIARY_LAST_N=5

echo "=== Mnemon session start ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z (%A)')"

if [ -n "${MNEMON_PG_URL:-}" ]; then
  # Postgres backend (Option B). Direct psql is the fastest path — no bun cold-start
  # for ~50ms vs ~2s. Falls through silently if psql isn't on PATH or the connection
  # fails (e.g. server not running).
  DIARY="$(
    psql -t -A -F'|' "$MNEMON_PG_URL" \
      -c "SELECT to_char(entry_date,'YYYY-MM-DD'), regexp_replace(content, E'[\n\r]+', ' ', 'g')
            FROM diary
        ORDER BY entry_date DESC
           LIMIT $DIARY_LAST_N" 2>/dev/null
  )"
  if [ -n "$DIARY" ]; then
    echo ""
    echo "=== Diary (last $DIARY_LAST_N entries) ==="
    echo "$DIARY" | awk -F'|' '{ printf "[%s] %s\n", $1, $2 }'
  fi
fi

echo ""
echo "Memory verbs: recall · recall_as_of · read_diary · find_entity · history · history_raw"
echo "Save verbs:   remember · archive_turn · re_extract"
