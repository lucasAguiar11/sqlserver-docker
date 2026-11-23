#!/usr/bin/env sh
# Roda o import.mjs num node:22 na rede do servidor, ao lado dos dois bancos. Na pasta sqlserver-docker do servidor:
#   ./import-postgres/run-in-docker.sh
# O destino é o `halley` deste SQL Server (senha do .env). A origem é POSTGRES_DATABASE_URL ou, sem ela, o
# DATABASE_URL do container halley-api.
set -eu
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
if [ -z "${POSTGRES_DATABASE_URL:-}" ]; then
  POSTGRES_DATABASE_URL=$(docker inspect halley-api --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p')
fi
export POSTGRES_DATABASE_URL
docker run --rm --network host -v "$PWD/import-postgres:/app" -w /app \
  -e POSTGRES_DATABASE_URL -e P="$MSSQL_SA_PASSWORD" -e PORT="${MSSQL_PORT:-1433}" node:22-alpine sh -c '
  npm install --silent --no-audit --no-fund >/dev/null &&
  MSSQL_DATABASE_URL=$(node -p "\`mssql://sa:\${encodeURIComponent(process.env.P)}@127.0.0.1:\${process.env.PORT}/halley?encrypt=false\`") node import.mjs'
