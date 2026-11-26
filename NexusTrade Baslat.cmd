@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_CMD=%ROOT%scripts\start-backend.cmd"
set "WEB_CMD=%ROOT%scripts\start-web.cmd"

if not exist "%ROOT%package.json" (
  echo NexusTrade proje klasoru bulunamadi.
  echo Bu dosyayi nexustrade-pro-v2 klasorunden calistirin.
  pause
  exit /b 1
)

if not exist "%ROOT%web\package.json" (
  echo web klasoru bulunamadi.
  pause
  exit /b 1
)

echo NexusTrade baslatiliyor...
echo Backend ve Web icin iki ayri pencere acilacak.

start "NexusTrade Backend" /D "%ROOT%" "%BACKEND_CMD%"
start "NexusTrade Web" /D "%ROOT%" "%WEB_CMD%"

timeout /t 8 /nobreak >nul
start "" "http://localhost:5173/"

echo Hazir. Backend penceresinde 127.0.0.1:3000, Web penceresinde 5173 gorunmeli.
timeout /t 3 /nobreak >nul
