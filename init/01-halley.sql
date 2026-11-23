-- Banco do halley-api: collation que diferencia maiúsculas e acentos e leitura sem bloqueio (READ_COMMITTED_SNAPSHOT),
-- as mesmas que scripts/db/mssql/migrate.mjs exige. As tabelas vêm de `pnpm db:migrate:mssql` no halley-api.
IF DB_ID(N'halley') IS NULL
BEGIN
  CREATE DATABASE [halley] COLLATE Latin1_General_100_CS_AS_SC;
  ALTER DATABASE [halley] SET READ_COMMITTED_SNAPSHOT ON;
END
GO
