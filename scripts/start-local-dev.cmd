@echo off

chcp 65001 >nul

cd /d "%~dp0.."

set PATH=%~dp0..\tools\deploy-gui-py\.portable-node;%PATH%



echo.

echo === Локалка БЕЗ VK hosting (не stage, не prod) ===

echo.

echo НЕ localtunnel (loca.lt) — там страница "введи IP", VK iframe не проходит.

echo Используем localhost.run (SSH-туннель, без interstitial).

echo.



call npm run bundle:hosting

if errorlevel 1 exit /b 1



echo [1/2] Сервер http://127.0.0.1:8080

start "zmei-8080" /min cmd /c "set PORT=8080&& node scripts\serve-local.mjs"

timeout /t 2 /nobreak >nul



echo [2/2] HTTPS туннель (localhost.run)...

echo.

echo Жди строку:  https://XXXX.lhr.life

echo.

echo В VK вставь (web + mobile + mvk, режим разработки ВКЛ):

echo   https://XXXX.lhr.life/index.html

echo.

echo Сначала открой URL в браузере — должна загрузиться игра, не форма с IP.

echo Открыть в VK: https://vk.ru/app54660972

echo НЕ ЗАКРЫВАЙ это окно!

echo.



ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:127.0.0.1:8080 nokey@localhost.run

