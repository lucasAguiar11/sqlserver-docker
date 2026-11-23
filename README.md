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

- Host `localhost`, porta `1433` (`MSSQL_PORT`), usuário `sa`, senha do `.env`.
- Certificado autoassinado: use `TrustServerCertificate=true` (ou `encrypt=false`).
- Linha de comando dentro do container:

  ```bash
  docker exec -it sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$(grep MSSQL_SA_PASSWORD .env | cut -d= -f2)"
  ```

## Observações

- A imagem só existe para `amd64`. No Mac com Apple Silicon roda pelo Rosetta (Docker Desktop, "Use Rosetta for
  x86_64/amd64 emulation").
- O SQL Server precisa de pelo menos 2 GB de memória no Docker. Dois servidores ao mesmo tempo (este e o
  `docker-compose.mssql.yml` dos testes do halley-api) pedem 4 GB ou mais.
- Os dados ficam num volume nomeado: bind mount de pasta do macOS não funciona com o SQL Server (erro 5105 ao abrir
  o `master.mdf`). Para recomeçar do zero: `docker compose down -v`.
