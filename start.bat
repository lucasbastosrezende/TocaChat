@echo off

echo Iniciando TocaChat Helper na porta 3000...
start cmd /k "python server.py"

echo Iniciando Gateway Unificado na porta 8080...
start cmd /k "node gateway.js"

echo Sistema iniciado! Mantenha as janelas abertas.
pause
