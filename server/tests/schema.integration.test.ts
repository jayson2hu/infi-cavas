import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaTest = databaseUrl ? test : test.skip;

// 只规范本次比较的命名空间；保留约束、默认值和索引 SQL 的完整语义。
function normalizeNamespace(value: unknown, namespace: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(`${namespace}.`, "__schema__.");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNamespace(item, namespace));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeNamespace(item, namespace),
    ]));
  }
  return value;
}

async function inspectSchema(client: Pick<postgres.Sql, "unsafe">, namespace: string) {
  const tables = await client.unsafe(`
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `, [namespace]);
  const columns = await client.unsafe(`
    SELECT c.relname AS table_name, a.attname AS name, a.attnum AS position,
      format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
      pg_get_expr(d.adbin, d.adrelid) AS default_value,
      cn.nspname AS collation_schema, co.collname AS collation_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `, [namespace]);
  const constraints = await client.unsafe(`
    SELECT c.relname AS table_name, co.conname AS name, co.contype AS type,
      co.condeferrable AS deferrable, co.condeferred AS deferred,
      co.convalidated AS validated, co.connoinherit AS no_inherit,
      pg_get_constraintdef(co.oid, false) AS definition
    FROM pg_constraint co
    JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
    ORDER BY c.relname, co.conname
  `, [namespace]);
  const indexes = await client.unsafe(`
    SELECT c.relname AS table_name, ic.relname AS name,
      i.indisunique AS is_unique, i.indisprimary AS is_primary,
      i.indisvalid AS is_valid, i.indisready AS is_ready,
      i.indimmediate AS is_immediate, i.indnullsnotdistinct AS nulls_not_distinct,
      pg_get_indexdef(i.indexrelid, 0, false) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
    ORDER BY c.relname, ic.relname
  `, [namespace]);
  return {
    tables: normalizeNamespace([...tables], namespace),
    columns: normalizeNamespace([...columns], namespace),
    constraints: normalizeNamespace([...constraints], namespace),
    indexes: normalizeNamespace([...indexes], namespace),
  };
}

schemaTest("PostgreSQL 迁移结果与 specs/schema.sql 的 25 张表完整等价（需 TEST_DATABASE_URL）", async () => {
  const client = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const referenceSchema = `schema_spec_${randomUUID().replaceAll("-", "")}`;
  try {
    const referenceSql = await readFile(new URL("../../specs/schema.sql", import.meta.url), "utf8");
    const { reference, migrated } = await client.begin(async (tx) => {
      // 不使用 IF NOT EXISTS：若名称发生冲突，直接失败，绝不清理原有 schema。
      // 创建、查询、删除处于同一事务；异常回滚也会撤销本次创建。
      await tx`CREATE SCHEMA ${tx(referenceSchema)}`;
      await tx`SELECT set_config('search_path', ${referenceSchema}, true)`;
      await tx.unsafe(referenceSql);
      // 让 PostgreSQL 显式输出引用表的 schema，便于严格对比外键和索引。
      await tx`SELECT set_config('search_path', 'pg_catalog', true)`;
      const reference = await inspectSchema(tx, referenceSchema);
      const migrated = await inspectSchema(tx, "public");
      await tx`DROP SCHEMA ${tx(referenceSchema)} CASCADE`;
      return { reference, migrated };
    });
    expect(reference.tables).toHaveLength(25);
    expect(migrated.tables).toEqual(reference.tables);
    expect(migrated.columns).toEqual(reference.columns);
    expect(migrated.constraints).toEqual(reference.constraints);
    expect(migrated.indexes).toEqual(reference.indexes);
  } finally {
    await client.end();
  }
}, 30_000);
