import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { db, sqlClient } from "./client";

export async function migrateDatabase() {
  const connection = await sqlClient.reserve();
  try {
    await connection`select pg_advisory_lock(71423, 0)`;
    try { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
    finally { await connection`select pg_advisory_unlock(71423, 0)`; }
  } finally { connection.release(); }
}

if (import.meta.main) {
  try { await migrateDatabase(); } finally { await sqlClient.end(); }
}
