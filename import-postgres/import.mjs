// Importação do Halley: copia do PostgreSQL antigo para o SQL Server as linhas que ainda não estão lá (pela chave
// primária, com os mesmos ids) e alinha as sequences. Tabela com a mesma contagem nos dois lados é pulada; linha que já
// existe no SQL Server não é alterada. O destino precisa estar migrado pelo halley-api (`pnpm db:migrate`). Confere o
// schema antes, grava tudo numa transação e valida FKs e CHECKs no fim: falhou, nada fica. Pode rodar de novo.
//
//   cd import-postgres && npm install
//   POSTGRES_DATABASE_URL='postgres://…' MSSQL_DATABASE_URL='mssql://usuario:senha@host:1433/halley?encrypt=false' node import.mjs
import { sql, Kysely, MssqlDialect } from 'kysely';
import pg from 'pg';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';

// Tabela de ferramenta de migration que ficou no PostgreSQL, sem dado da aplicação.
const SKIPPED_SOURCE_TABLES = new Set(['_prisma_migrations']);
const MAX_PARAMETERS = 2000;
// O tedious manda NULL como nvarchar, que o SQL Server não converte para varbinary (erro 257).
const NULL_BINARY = sql`CAST(NULL AS varbinary(max))`;
// Lidos como texto: data e hora já estão em UTC (a sessão roda em UTC), numeric e bigint não perdem precisão e JSON
// chega byte a byte. Os arrays (`text[]`, `int[]`) chegam como array JS e viram JSON.
const RAW_TYPES = new Set([
  pg.types.builtins.TIMESTAMP,
  pg.types.builtins.TIMESTAMPTZ,
  pg.types.builtins.DATE,
  pg.types.builtins.TIME,
  pg.types.builtins.JSON,
  pg.types.builtins.JSONB,
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
]);
const types = {
  getTypeParser: (oid, format) => (RAW_TYPES.has(oid) ? (value) => value : pg.types.getTypeParser(oid, format)),
};

const toMssql = (value) => {
  if (Array.isArray(value)) return JSON.stringify(value);
  // timestamptz em UTC chega como '2026-11-19 20:02:25.123+00'; datetime2 não aceita o fuso.
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/.test(value)) return value.slice(0, -3);
  return value;
};

// Chave primária como texto nos dois lados: ids são texto (nvarchar(36)) e as chaves compostas juntam as partes.
const keyOf = (row, pk) => pk.map((col) => String(row[col])).join('\u0000');

function createMssqlDb(url) {
  const u = new URL(url);
  return new Kysely({
    dialect: new MssqlDialect({
      tarn: { ...Tarn, options: { min: 0, max: 1 } },
      tedious: {
        ...Tedious,
        connectionFactory: () =>
          new Tedious.Connection({
            server: u.hostname,
            authentication: {
              type: 'default',
              options: { userName: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
            },
            options: {
              port: Number(u.port || 1433),
              database: decodeURIComponent(u.pathname.slice(1)),
              encrypt: u.searchParams.get('encrypt') !== 'false',
              trustServerCertificate: u.searchParams.get('trustServerCertificate') === 'true',
              requestTimeout: 0,
            },
          }),
      },
    }),
  });
}

function columnsByTable(rows) {
  const tables = new Map();
  for (const { tbl, col } of rows) {
    if (!tables.has(tbl)) tables.set(tbl, []);
    tables.get(tbl).push(col);
  }
  for (const cols of tables.values()) cols.sort();
  return tables;
}

async function importData(source, target) {
  await source.query(`SET TIME ZONE 'UTC'`);
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const sourceTables = columnsByTable(
    (
      await source.query(`
        SELECT c.table_name AS tbl, c.column_name AS col
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.is_generated = 'NEVER'`)
    ).rows.filter((row) => !SKIPPED_SOURCE_TABLES.has(row.tbl)),
  );
  const targetTables = columnsByTable(
    (
      await sql`
        SELECT t.name AS tbl, c.name AS col
        FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
        WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.is_computed = 0 AND t.name NOT LIKE 'kysely[_]migration%'`.execute(
        target,
      )
    ).rows,
  );
  const binaryColumns = new Set(
    (
      await sql`
        SELECT t.name AS tbl, c.name AS col
        FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
        WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND TYPE_NAME(c.user_type_id) IN ('varbinary', 'binary')`.execute(target)
    ).rows.map(({ tbl, col }) => `${tbl}.${col}`),
  );
  const primaryKeys = new Map();
  for (const { tbl, col } of (
    await sql`
      SELECT t.name AS tbl, c.name AS col
      FROM sys.tables t
      JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
      ORDER BY t.name, ic.key_ordinal`.execute(target)
  ).rows) {
    if (!primaryKeys.has(tbl)) primaryKeys.set(tbl, []);
    primaryKeys.get(tbl).push(col);
  }

  const errors = [];
  for (const [tbl, cols] of sourceTables) {
    const targetCols = targetTables.get(tbl);
    if (!targetCols) errors.push(`${tbl}: existe no PostgreSQL e não no SQL Server`);
    else if (cols.join() !== targetCols.join())
      errors.push(`${tbl}: colunas diferentes\n  PostgreSQL: ${cols.join(', ')}\n  SQL Server: ${targetCols.join(', ')}`);
    else if (!primaryKeys.has(tbl)) errors.push(`${tbl}: sem chave primária no SQL Server`);
  }
  if (errors.length) throw new Error(`Importação recusada, nada foi gravado:\n${errors.join('\n')}`);
  for (const tbl of targetTables.keys())
    if (!sourceTables.has(tbl)) console.log(`${tbl}: não existe no PostgreSQL, fica como está`);

  let imported = 0;
  await target.transaction().execute(async (trx) => {
    for (const tbl of targetTables.keys())
      await sql`ALTER TABLE ${sql.id('dbo', tbl)} NOCHECK CONSTRAINT ALL`.execute(trx);

    for (const [tbl, cols] of sourceTables) {
      const pk = primaryKeys.get(tbl);
      const { rows: counted } = await source.query(`SELECT count(*)::int AS total FROM ${pg.escapeIdentifier(tbl)}`);
      const sourceTotal = counted[0].total;
      const { total } = await trx
        .selectFrom(tbl)
        .select((eb) => eb.fn.countAll().as('total'))
        .executeTakeFirstOrThrow();
      if (Number(total) === sourceTotal) {
        console.log(`${tbl}: ${sourceTotal} nos dois, pulada`);
        continue;
      }

      // shortcut: lê a tabela inteira na memória; serve para as bases de hoje (dezenas de MB), paginar se crescer.
      const existing = new Set((await trx.selectFrom(tbl).select(pk).execute()).map((row) => keyOf(row, pk)));
      const { rows } = await source.query(
        `SELECT ${cols.map((col) => pg.escapeIdentifier(col)).join(', ')} FROM ${pg.escapeIdentifier(tbl)}`,
      );
      const missing = rows.filter((row) => !existing.has(keyOf(row, pk)));
      const batch = Math.max(1, Math.floor(MAX_PARAMETERS / cols.length));
      for (let i = 0; i < missing.length; i += batch) {
        const values = missing
          .slice(i, i + batch)
          .map((row) =>
            Object.fromEntries(
              cols.map((col) => [
                col,
                row[col] === null && binaryColumns.has(`${tbl}.${col}`) ? NULL_BINARY : toMssql(row[col]),
              ]),
            ),
          );
        await trx.insertInto(tbl).values(values).execute();
      }
      imported += missing.length;
      const onlyInTarget = Number(total) + missing.length - sourceTotal;
      console.log(
        `${tbl}: ${missing.length} importadas (PostgreSQL ${sourceTotal}, SQL Server ${Number(total)} antes)` +
          (onlyInTarget > 0 ? `; ${onlyInTarget} só no SQL Server` : ''),
      );
    }

    // WITH CHECK valida cada linha, as copiadas e as que já estavam, contra as FKs e os CHECKs.
    for (const tbl of targetTables.keys())
      await sql`ALTER TABLE ${sql.id('dbo', tbl)} WITH CHECK CHECK CONSTRAINT ALL`.execute(trx);
  });
  await source.query('COMMIT');
  console.log(`${imported} linhas importadas`);
}

// Cada sequence do SQL Server passa a começar acima do último valor usado no PostgreSQL; nunca volta para trás.
async function alignSequences(source, target) {
  const { rows: postgres } = await source.query(
    `SELECT sequencename AS name, COALESCE(last_value + increment_by, start_value)::bigint::text AS next
     FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`,
  );
  // Sem uso desde a criação ou o último RESTART, `last_used_value` é NULL e `current_value` é o próximo a sair.
  const { rows: mssql } = await sql`
    SELECT name, CAST(COALESCE(CAST(last_used_value AS bigint) + CAST(increment AS bigint), CAST(current_value AS bigint)) AS bigint) AS next
    FROM sys.sequences WHERE SCHEMA_NAME(schema_id) = 'dbo'`.execute(target);
  const nextInMssql = new Map(mssql.map((row) => [row.name, BigInt(row.next)]));
  for (const { name, next: postgresNext } of postgres) {
    const current = nextInMssql.get(name);
    const next = BigInt(postgresNext);
    if (current === undefined) console.log(`${name}: não existe no SQL Server`);
    else if (next <= current) console.log(`${name}: mantida (próximo ${current}; no PostgreSQL ${next})`);
    else {
      await sql`ALTER SEQUENCE ${sql.id('dbo', name)} RESTART WITH ${sql.raw(next.toString())}`.execute(target);
      console.log(`${name}: reinicia em ${next}`);
    }
  }
}

const { POSTGRES_DATABASE_URL, MSSQL_DATABASE_URL } = process.env;
if (!POSTGRES_DATABASE_URL || !MSSQL_DATABASE_URL)
  throw new Error('Defina POSTGRES_DATABASE_URL e MSSQL_DATABASE_URL (ver o cabeçalho do script)');
const source = new pg.Client({ connectionString: POSTGRES_DATABASE_URL, types });
const target = createMssqlDb(MSSQL_DATABASE_URL);
await source.connect();
try {
  await importData(source, target);
  await alignSequences(source, target);
} finally {
  await source.end();
  await target.destroy();
}
