@echo off
echo Iniciando Servidor PeerJS na porta 9000...
start cmd /k "node peerserver.js"

echo Iniciando TocaChat Helper na porta 3000...
start cmd /k "python server.py"

echo Iniciando Gateway Unificado na porta 8080...
start cmd /k "node gateway.js"

echo Sistema iniciado! Mantenha as janelas abertas.
echo.
echo === CLOUDFLARE TUNNEL (GRATUITO) ===
echo Para gerar seu link publico (sem precisar de dominio), rode:
echo .\cloudflared.exe tunnel --url http://localhost:8080
echo.
echo O link gerado terminara em .trycloudflare.com
echo ===================================
pause
