@echo off
setlocal
title NexusTrade Backend

set "ROOT=%~dp0.."
pushd "%ROOT%" || exit /b 1

:loop
cls
echo NexusTrade Backend baslatiliyor...
echo Klasor: %CD%
echo.

node --import tsx src\server.ts

echo.
echo Backend durdu veya kapandi. 5 saniye sonra tekrar baslatilacak.
echo Bu pencereyi kapatmadigin surece backend otomatik yeniden dener.
timeout /t 5 /nobreak >nul
goto loop
