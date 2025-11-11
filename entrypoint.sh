#!/bin/bash
set -e

echo "🧹 Limpando sessões antigas..."
rm -rf /usr/src/app/sessions/* || true
mkdir -p /usr/src/app/sessions
chmod -R 777 /usr/src/app/sessions

echo "🚀 Iniciando API..."
exec node server.js
