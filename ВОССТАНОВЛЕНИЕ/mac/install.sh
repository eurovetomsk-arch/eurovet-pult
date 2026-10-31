#!/bin/bash
# Установка ежедневной копии на Mac под текущим пользователем (без пароля администратора).
# Запуск: bash install.sh
# Токен копии создаётся здесь же и остаётся только на этом Mac. Наружу выводится лишь его отпечаток SHA-256:
# его один раз заносят в базу (00_ЧИТАЙ_МЕНЯ.md, раздел 4), сам токен никуда не передают.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.eurovet" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.eurovet"
cp "$HERE/eurovet-recovery.sh" "$HOME/.eurovet/eurovet-recovery.sh"
chmod 700 "$HOME/.eurovet/eurovet-recovery.sh"
if [ ! -s "$HOME/.eurovet/export_token" ]; then
  (umask 077; openssl rand -hex 32 > "$HOME/.eurovet/export_token")
  NEW=1
fi
chmod 600 "$HOME/.eurovet/export_token"
sed "s#__HOME__#$HOME#g" "$HERE/ru.eurovet.recovery.plist" > "$HOME/Library/LaunchAgents/ru.eurovet.recovery.plist"
launchctl bootout "gui/$(id -u)/ru.eurovet.recovery" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ru.eurovet.recovery.plist"
HASH=$(tr -d ' \n\r' < "$HOME/.eurovet/export_token" | shasum -a 256 | cut -d' ' -f1)
echo "Отпечаток токена (не секрет): $HASH"
[ "${NEW:-0}" = 1 ] && echo "Токен новый: занесите отпечаток в базу, см. 00_ЧИТАЙ_МЕНЯ.md, раздел 4"
echo "Установлено: копия каждый день в 04:15 и при входе в систему. Журнал: ~/Desktop/work/ВОССТАНОВЛЕНИЕ/журнал.txt"
