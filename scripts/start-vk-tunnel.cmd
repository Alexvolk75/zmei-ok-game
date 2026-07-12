@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set PATH=%~dp0..\tools\deploy-gui-py\.portable-node;%PATH%

echo.
echo === VK Tunnel (локалка, НЕ stage/prod) ===
echo.
echo 1) Дождись ссылки oauth.vk.ru В ЭТОМ ОКНЕ
echo 2) Открой её ТУТ ЖЕ на ЭТОМ ПК (не с телефона, не старую ссылку)
echo 3) Залогинься - увидишь "успешно"
echo 4) Сразу вернись СЮДА и нажми Enter
echo.
echo НЕ открывай ссылку из другого окна - будет invalid device_id
echo.

call npm run bundle:hosting
if errorlevel 1 exit /b 1

start "zmei-local-8080" /min cmd /c "set PORT=8080&& node scripts\serve-local.mjs"
timeout /t 2 /nobreak >nul

npx vk-tunnel
