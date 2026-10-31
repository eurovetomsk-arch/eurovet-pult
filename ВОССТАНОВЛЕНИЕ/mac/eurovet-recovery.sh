#!/bin/bash
# ЕВРОВЕТ: ежедневная копия пульта на Mac без ИИ (запускает macOS по расписанию, Claude не нужен).
# Что делает: 1) данные пульта JSON и напоминания ICS по секретной ссылке, 2) раз в неделю код из GitHub,
# 3) свежие инструкции восстановления. Ничего не удаляет. Пишет журнал и файл ВНИМАНИЕ при сбое.
# Токен ссылки лежит в ~/.eurovet/export_token (только для этого пользователя), в копию не попадает.
set -u
ROOT="${EUROVET_RECOVERY_DIR:-$HOME/Desktop/work/ВОССТАНОВЛЕНИЕ}"
FN="${EUROVET_FN:-https://ikxmzapfmgqnnrsttuxc.supabase.co/functions/v1/pult-export}"
REPO_ZIP="${EUROVET_ZIP:-https://github.com/eurovetomsk-arch/eurovet-pult/archive/refs/heads/main.zip}"
TOKEN_FILE="$HOME/.eurovet/export_token"
DAY=$(date +%Y-%m-%d)
mkdir -p "$ROOT/данные" "$ROOT/код"
LOG="$ROOT/журнал.txt"
say() { echo "$(date '+%Y-%m-%d %H:%M') $*" >> "$LOG"; }
fail() { say "СБОЙ: $*"; printf '%s\nСбой копии: %s\nЧто делать: открыть %s и прочитать 00_ЧИТАЙ_МЕНЯ.md, раздел «Копия на Mac не обновляется».\n' "$(date)" "$*" "$ROOT" > "$ROOT/ВНИМАНИЕ_копия_не_обновилась.txt"; }
ok=1

# 1. Данные и напоминания
if [ -r "$TOKEN_FILE" ]; then
  T=$(tr -d ' \n\r' < "$TOKEN_FILE")
  tmp=$(mktemp)
  if curl -fsS --max-time 60 "$FN?f=json&t=$T" -o "$tmp" && grep -q '"format": "eurovet-pult-export/1"' "$tmp"; then
    mv "$tmp" "$ROOT/данные/pult_$DAY.json"; cp "$ROOT/данные/pult_$DAY.json" "$ROOT/данные/pult_последняя.json"
    say "данные: ok ($(wc -c < "$ROOT/данные/pult_$DAY.json" | tr -d ' ') байт)"
  else rm -f "$tmp"; ok=0; fail "данные не скачались (нет интернета, упал Supabase или сменили токен)"; fi
  tmp=$(mktemp)
  if curl -fsS --max-time 60 "$FN?f=ics&t=$T" -o "$tmp" && head -1 "$tmp" | grep -q 'BEGIN:VCALENDAR'; then
    mv "$tmp" "$ROOT/данные/напоминания_последние.ics"; say "напоминания ICS: ok"
  else rm -f "$tmp"; ok=0; fail "напоминания ICS не скачались"; fi
else ok=0; fail "нет файла токена $TOKEN_FILE"; fi

# 2. Код раз в неделю (воскресенье) или если копии ещё нет
if [ "$(date +%u)" = "7" ] || ! ls "$ROOT/код/"eurovet-pult_*.zip >/dev/null 2>&1; then
  tmp=$(mktemp)
  if curl -fsSL --max-time 120 "$REPO_ZIP" -o "$tmp" && unzip -tq "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$ROOT/код/eurovet-pult_$DAY.zip"; say "код: ok"
    # 3. Свежие инструкции из кода наверх папки
    x=$(mktemp -d)
    if unzip -q "$ROOT/код/eurovet-pult_$DAY.zip" -d "$x" 2>/dev/null; then
      src=$(find "$x" -maxdepth 2 -type d -name 'ВОССТАНОВЛЕНИЕ' | head -1)
      [ -n "$src" ] && cp -R "$src/." "$ROOT/" && say "инструкции: обновлены"
    fi
    rm -rf "$x"
  else rm -f "$tmp"; ok=0; fail "код с GitHub не скачался"; fi
fi

[ $ok = 1 ] && rm -f "$ROOT/ВНИМАНИЕ_копия_не_обновилась.txt"
exit 0
