@echo off
REM Node.js sunucusunu başlat
start cmd /k "node server.js"

REM Sunucu açıldıktan sonra tarayıcıda sayfayı aç
REM Burada kendi adresini yaz (örneğin http://localhost:3000)
start http://localhost:3000
