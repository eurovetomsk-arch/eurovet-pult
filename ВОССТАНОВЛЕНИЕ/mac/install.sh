#!/bin/bash
# Установка ежедневной копии на Mac под текущим пользователем (без пароля администратора).
# Запуск: bash install.sh   (файл токена ~/.eurovet/export_token кладётся отдельно, см. 00_ЧИТАЙ_МЕНЯ.md)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.eurovet" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.eurovet"
cp "$HERE/eurovet-recovery.sh" "$HOME/.eurovet/eurovet-recovery.sh"
chmod 700 "$HOME/.eurovet/eurovet-recovery.sh"
[ -f "$HOME/.eurovet/export_token" ] && chmod 600 "$HOME/.eurovet/export_token"
sed "s#__HOME__#$HOME#g" "$HERE/ru.eurovet.recovery.plist" > "$HOME/Library/LaunchAgents/ru.eurovet.recovery.plist"
launchctl bootout "gui/$(id -u)/ru.eurovet.recovery" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ru.eurovet.recovery.plist"
echo "Установлено: копия каждый день в 04:15 и при входе в систему. Журнал: ~/Desktop/work/ВОССТАНОВЛЕНИЕ/журнал.txt"
