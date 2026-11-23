#!/bin/sh
# Porta publicada do SQL Server: só a rede interna do servidor e os IPs de MSSQL_ALLOWED_SOURCES (no .env, fora do
# git). O ufw não filtra porta publicada pelo Docker, por isso a regra fica na chain DOCKER-USER. Idempotente: roda no
# boot e a cada início do Docker.
set -eu
cd "$(dirname "$0")/.."
# Lido linha a linha: a lista tem espaços sem aspas, como o docker compose aceita, e o `.` do shell não.
env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
PORT="$(env_value MSSQL_PORT)"
PORT="${PORT:-1433}"
SOURCES="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 $(env_value MSSQL_ALLOWED_SOURCES)"

iptables -N MSSQL-ALLOW 2>/dev/null || iptables -F MSSQL-ALLOW
for source in $SOURCES; do iptables -A MSSQL-ALLOW -s "$source" -j RETURN; done
iptables -A MSSQL-ALLOW -j DROP

# --ctorigdstport: a porta que o cliente pediu, antes do DNAT do Docker.
match="-p tcp -m conntrack --ctorigdstport $PORT --ctdir ORIGINAL -j MSSQL-ALLOW"
iptables -C DOCKER-USER $match 2>/dev/null || iptables -I DOCKER-USER $match
echo "porta $PORT liberada só para: $SOURCES"
