@echo off
setlocal
title NexusTrade Web

set "ROOT=%~dp0.."
pushd "%ROOT%\web" || exit /b 1

:loop
cls
echo NexusTrade Web baslatiliyor...
echo Klasor: %CD%
echo.

npm.cmd run dev

echo.
echo Web sunucusu durdu veya kapandi. 5 saniye sonra tekrar baslatilacak.
echo Bu pencereyi kapatmadigin surece web otomatik yeniden dener.
timeout /t 5 /nobreak >nul
goto loop
