@echo off
setlocal
title NexusTrade Backend

set "ROOT=%~dp0.."
pushd "%ROOT%" || exit /b 1

rem Ekran temizlenmez: backend coker ve yeniden baslarsa onceki hata mesaji
rem pencerede gorunur kalir. Tum cikti ayrica logs\backend.log dosyasina yazilir.

:loop
echo NexusTrade Backend baslatiliyor...
echo Klasor: %CD%
echo Log: %CD%\logs\backend.log
echo.

node scripts\run-backend-logged.cjs

echo.
echo Backend durdu veya kapandi. Sebep icin yukaridaki ciktiya veya logs\backend.log dosyasina bakin.
echo 5 saniye sonra tekrar baslatilacak. Bu pencereyi kapatmadigin surece backend otomatik yeniden dener.
timeout /t 5 /nobreak >nul
goto loop
