#!/usr/bin/env bash
# Shared secret/PII scanner for git hooks.
# Scans the files passed as arguments (or staged files if none) and fails
# with a non-zero exit code if anything that looks like a secret or PII is found.
set -u

# Patterns for secrets / PII that must never be committed.
# - real gmail addresses (placeholders like ...@example.com are allowed)
# - Telegram bot tokens (e.g. 123456789:AA...)
# - generic long token after a colon
# - hard-coded chatId with a numeric value
PATTERNS=(
  '[A-Za-z0-9._%+-]+@gmail\.com'
  '[0-9]{6,}:[A-Za-z0-9_-]{30,}'
  'bot[0-9]{6,}:'
  '"chatId"[[:space:]]*:[[:space:]]*"[0-9]{5,}"'
  '(token|api[_-]?key|secret|password|passwd)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'' ]{8,}'
)

# Collect files to scan.
if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACM)
fi

[ "${#FILES[@]}" -eq 0 ] && exit 0

found=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in
    .githooks/*|*.md) continue ;;   # skip the scanner & docs (contain pattern examples)
  esac
  for p in "${PATTERNS[@]}"; do
    # allow obvious placeholders
    if grep -nEi "$p" "$f" 2>/dev/null \
        | grep -vEi 'example\.com|REPLACE_WITH|<YOUR_' >/tmp/_secret_hits 2>/dev/null; then
      if [ -s /tmp/_secret_hits ]; then
        echo "🚫 Potential secret/PII in $f:"
        sed 's/^/    /' /tmp/_secret_hits
        found=1
      fi
    fi
  done
done
rm -f /tmp/_secret_hits

if [ "$found" -ne 0 ]; then
  echo ""
  echo "❌ Blocked: remove the secret/PII or replace it with a REPLACE_WITH_... placeholder."
  echo "   (Real credentials belong only inside n8n, never in this repo.)"
  exit 1
fi
exit 0
