@echo off
:: CONFIGURAÇÃO
set DOMAIN=tocachat
set TOKEN=7e1b74c3-668c-490e-9ac6-5586864ece4e

echo Atualizando DuckDNS para %DOMAIN%...

:loop
powershell -Command "Invoke-RestMethod -Uri 'https://www.duckdns.org/update?domains=%DOMAIN%&token=%TOKEN%&ip='"
echo.
echo Proxima atualizacao em 5 minutos...
timeout /t 300 /nobreak
goto loop
