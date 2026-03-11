@echo off
echo Iniciando Servidor PeerJS na porta 9000...
start cmd /k "node peerserver.js"

echo Iniciando TocaChat Helper na porta 3000...
start cmd /k "python server.py"

echo Sistema iniciado! Mantenha as duas janelas pretas abertas.
pause
