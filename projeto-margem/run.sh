#!/usr/bin/env bash
# Sobe o servidor da aplicação Margem em http://localhost:3000
set -e
cd "$(dirname "$0")"
echo "→ http://localhost:3000  (Ctrl+C para parar)"
echo "  login: joao paiva  / senha inicial: 858646"
exec node server.js
