# Deploy GUI (Python)

Простой GUI на Python (Tkinter) для массового деплоя одной и той же игры в много приложений,
где у каждой игры есть **пара**: VK `app_id` и OK `app_id`.

## Запуск

В PowerShell:

```powershell
cd C:\Users\Administrator\Desktop\newgame\tools\deploy-gui-py
python .\deploy_gui.py
```

## Как работает

- Выбираешь **папку-основу** (где лежит `vk-hosting-config.json` и есть `npm run deploy`)
- Вставляешь список **пар** `VK_ID,OK_ID` (по одной паре в строке)
- Нажимаешь **Старт**
- По каждому `VK_ID` приложение временно меняет `app_id` в `vk-hosting-config.json`, запускает `npm run deploy`,
  парсит PROD URL из лога и сохраняет в результаты

## Выходной txt (как ты просил)

После прогона автоматически создаётся файл в папке-основе:

`deploy-results-YYYYMMDD-HHMMSS.txt`

Формат строк:

`VK_ID,OK_ID - PROD_URL`

## Чтобы деплой не просил подтверждение на телефоне

Задай переменную окружения:

- `MINI_APPS_ACCESS_TOKEN`

и (если нужно) `MINI_APPS_ENVIRONMENT=production`.

Токен **никому не отправляй**.

