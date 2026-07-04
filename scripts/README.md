# Бюджет — Telegram-дайджест

`tg_digest.py` читает `../data.json` и шлёт в Telegram короткий дайджест по бюджету
+ контекстные напоминания. Зависимостей нет — только Python 3 (стандартная библиотека).

## Что в дайджесте
- статус текущего месяца: доход план/факт, сколько категорий закрыто, дельта факт;
- бонусный пул + раскладка по целям (в порядке приоритета) + прогноз по среднему бонусу;
- конверты (sinking funds);
- напоминания: около 5-го — «впиши факт дохода»; в конце месяца — «закрой месяц».

## 1. Бот и chat_id (один раз)
1. В Telegram напиши **@BotFather** → `/newbot` → получи токен вида `123456:AA...`.
2. Напиши своему боту любое сообщение (иначе он не сможет тебе писать).
3. Узнай свой `chat_id`: открой
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` — в ответе найди `"chat":{"id":...}`.

## 2. Секреты (не в код, не в git)
Создай `~/.claude/secrets/budget_tg.env` (права 600):

```
TG_BOT_TOKEN=123456:AA...
TG_CHAT_ID=123456789
```

```bash
mkdir -p ~/.claude/secrets
printf 'TG_BOT_TOKEN=ВАШ_ТОКЕН\nTG_CHAT_ID=ВАШ_ID\n' > ~/.claude/secrets/budget_tg.env
chmod 600 ~/.claude/secrets/budget_tg.env
```

Либо через переменные окружения `TG_BOT_TOKEN` / `TG_CHAT_ID`.

## 3. Проверка
```bash
cd ~/Desktop/ОМП/Финансы
python3 scripts/tg_digest.py --dry     # печатает текст, ничего не шлёт
python3 scripts/tg_digest.py           # реально шлёт в Telegram
```

## 4. Расписание (macOS, launchd)
Дайджест удобно слать раз в день, напр. в 9:30. Создай
`~/Library/LaunchAgents/org.bitok.budget.digest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.bitok.budget.digest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/konstantinzabotin/Desktop/ОМП/Финансы/scripts/tg_digest.py</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/budget-digest.err</string>
  <key>StandardOutPath</key><string>/tmp/budget-digest.out</string>
</dict>
</plist>
```

Загрузить / перезагрузить:
```bash
launchctl unload ~/Library/LaunchAgents/org.bitok.budget.digest.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/org.bitok.budget.digest.plist
```

launchd берёт секреты из `~/.claude/secrets/budget_tg.env` (env-переменные там не видны,
поэтому файл секретов обязателен для расписания).

## Альтернатива — cron
```
30 9 * * * cd ~/Desktop/ОМП/Финансы && /usr/bin/python3 scripts/tg_digest.py
```

## Замечания
- Скрипт читает `data.json` как есть. Он не меняет данные и ничего не пишет.
- «Бонусный пул» = ручные записи «+ отложить в пул» в приложении. История бонусов из
  Google-таблицы (`bonusHistory`) идёт в прогноз (медиана/среднее), а не в баланс пула.
