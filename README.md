# sqlserver-docker

SQL Server 2022 (edição Developer) local, com os dados no volume Docker `sqlserver-docker_sqlserver_data`.

## Subir

```bash
cp .env.example .env   # troque a senha do sa
docker compose up -d
docker compose logs sqlserver-init   # bancos criados por init/*.sql
```

O `sqlserver-init` roda depois que o servidor fica saudável, executa cada `init/*.sql` em ordem e sai. Os scripts são
idempotentes: rodam de novo a cada `up` sem efeito.

## Conectar

- Host `localhost`, porta `1433` (`MSSQL_PORT`), usuário `sa`, senha do `.env`. A porta só escuta em `127.0.0.1`
  (`MSSQL_BIND`). Num servidor, conecte por túnel SSH, sem abrir a porta para a internet:

  ```bash
  ssh -N -L 14334:127.0.0.1:1433 root@<servidor>   # depois: localhost:14334
  ```

- Certificado autoassinado: use `TrustServerCertificate=true` (ou `encrypt=false`).
- Linha de comando dentro do container:

  ```bash
  docker exec -it sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$(grep MSSQL_SA_PASSWORD .env | cut -d= -f2)"
  ```

### Abrir a porta só para a rede interna e IPs liberados

Quando o túnel não serve (API ou ferramenta conectando direto), a porta fica em `0.0.0.0` e um firewall deixa entrar
só a rede interna do servidor e os IPs liberados. É o que roda no VPS de homologação do Halley desde 23/11/2026.

**O ufw não resolve.** O Docker grava as regras das portas publicadas no iptables antes das do ufw: com o ufw ligado, a
porta do container continua aberta. A regra vai na chain `DOCKER-USER`, que o Docker consulta antes de encaminhar e
não apaga ao reiniciar.

Arquivos em `firewall/`:

- `sqlserver-firewall.sh`: cria a chain `MSSQL-ALLOW` com um `RETURN` por origem liberada e `DROP` no fim, e manda
  para ela, a partir da `DOCKER-USER`, toda conexão TCP para a porta `MSSQL_PORT`. A porta é comparada antes do DNAT
  do Docker (`--ctorigdstport`). Pode rodar de novo: recria a lista e não duplica a regra.
- `sqlserver-firewall.service`: unit do systemd que roda o script no boot e a cada (re)início do Docker.

Origens liberadas:

| Origem | Por quê |
| --- | --- |
| `127.0.0.0/8` | o próprio servidor |
| `10.0.0.0/8` | rede privada do provedor (na DigitalOcean, a interface privada e a VPC) |
| `172.16.0.0/12` | redes do Docker: os containers do servidor |
| `MSSQL_ALLOWED_SOURCES` do `.env` | IPs de fora, separados por espaço, por exemplo o IP público do próprio servidor (container que conecta por ele) e o de quem administra |

Os IPs ficam no `.env`, fora do git: este repositório é público.

Instalar no servidor (pasta em `/root/devops/sqlserver-docker`, com `MSSQL_BIND=0.0.0.0` e `MSSQL_ALLOWED_SOURCES`
no `.env`):

```bash
cd /root/devops/sqlserver-docker
chmod +x firewall/sqlserver-firewall.sh
cp firewall/sqlserver-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sqlserver-firewall.service
iptables -S MSSQL-ALLOW   # um RETURN por origem e o DROP no fim
```

O `ExecStart` da unit aponta para `/root/devops/sqlserver-docker`; em outra pasta, ajuste a unit.

Liberar ou tirar um IP: edite `MSSQL_ALLOWED_SOURCES` no `.env` e rode `systemctl restart sqlserver-firewall`. O IP de
casa costuma mudar; quando a conexão parar, confira o IP atual (`curl -4 ifconfig.me`) e atualize a lista.

Conferir:

```bash
nc -vz <ip-do-servidor> 1433                # de um IP liberado: succeeded
nc -vz -w 5 <ip-do-servidor> 1433           # de outra rede (4G do celular): timeout
docker exec <container> node -e "require('net').connect(1433,'<ip-do-servidor>').on('connect',()=>{console.log('ok');process.exit()})"
```

Tirar o firewall: `systemctl disable --now sqlserver-firewall`, depois
`iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport 1433 --ctdir ORIGINAL -j MSSQL-ALLOW` e
`iptables -F MSSQL-ALLOW && iptables -X MSSQL-ALLOW`.

Mesmo com o firewall, use `encrypt=true&trustServerCertificate=true` na URL de quem conecta pela internet: com
`encrypt=false` o login vai cifrado, mas as queries e os resultados não.

## Importar os dados do PostgreSQL antigo do Halley

`import-postgres/` copia de um PostgreSQL do Halley para o banco `halley` daqui as linhas que ainda não estão lá, pela
chave primária e com os mesmos ids, e alinha as sequences. Tabela com a mesma contagem nos dois lados é pulada; linha
que já existe não é alterada. O banco precisa estar migrado pelo halley-api (`pnpm db:migrate`). Se o schema não bater
ou alguma FK ou CHECK falhar, nada é gravado. Pode rodar de novo quantas vezes precisar.

```bash
cd import-postgres && npm install
POSTGRES_DATABASE_URL='postgres://…' MSSQL_DATABASE_URL='mssql://sa:…@localhost:1433/halley?encrypt=false' node import.mjs
```

No servidor, um comando só (roda num `node:22-alpine` na rede do host; a origem é `POSTGRES_DATABASE_URL` ou o
`DATABASE_URL` do container `halley-api`). É bem mais rápido do que pelo túnel SSH, que derrubou a conexão no meio:

```bash
cd /root/devops/sqlserver-docker && ./import-postgres/run-in-docker.sh
```

## Observações

- A imagem só existe para `amd64`. No Mac com Apple Silicon roda pelo Rosetta (Docker Desktop, "Use Rosetta for
  x86_64/amd64 emulation").
- O SQL Server precisa de pelo menos 2 GB de memória no Docker. Dois servidores ao mesmo tempo (este e o
  `docker-compose.mssql.yml` dos testes do halley-api) pedem 4 GB ou mais.
- Os dados ficam num volume nomeado: bind mount de pasta do macOS não funciona com o SQL Server (erro 5105 ao abrir
  o `master.mdf`). Para recomeçar do zero: `docker compose down -v`.
