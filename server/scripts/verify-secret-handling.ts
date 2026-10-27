import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlClient } from "../src/db/client";
import { decryptSecret } from "../src/lib/crypto";

// Explicit local acceptance audit. Outputs locations/counts, never matching content.
const encryptedPath = process.argv[2];
if (!encryptedPath) throw new Error("Usage: bun scripts/verify-secret-handling.ts encrypted-provider-key-file");
const root = resolve("..");
const report: { success: boolean; filesChecked: number; rowsChecked: number; tablesChecked: number; findings: string[]; scope: string } = {
  success: false, filesChecked: 0, rowsChecked: 0, tablesChecked: 0, findings: [],
  scope: "Known acceptance provider key: source, public documentation, built web assets, acceptance text artifacts/logs, root config, and current database public tables. API redaction is separately covered by gateway integration tests.",
};
try {
  const secret = decryptSecret((await readFile(resolve(encryptedPath), "utf8")).trim());
  const extensions = /\.(?:[cm]?js|jsx|tsx?|json|mdx?|log|ya?ml|ps1|sh|env|txt|html|csv|css|sql)$/i;
  const paths = new Set((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && (extensions.test(entry.name) || entry.name.startsWith(".env"))).map((entry) => entry.name));
  for (const directory of ["server/src", "server/scripts", "server/tests", "web/src", "web/tests", "web/dist", "shared", "scripts", "docs/content", "docs/development", "artifacts/acceptance"]) {
    for await (const path of new Bun.Glob(`${directory}/**/*`).scan({ cwd: root, onlyFiles: true })) if (extensions.test(path)) paths.add(path);
  }
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path));
    report.filesChecked++;
    if (bytes.includes(Buffer.from(secret))) report.findings.push(`file:${path.split(secret).join("[REDACTED]")}`);
  }
  const tables = await sqlClient<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  for (const table of tables) {
    const rows = await sqlClient`select row_to_json(t)::text as data from ${sqlClient(table.tablename)} t`;
    report.tablesChecked++;
    report.rowsChecked += rows.length;
    if (rows.some((row) => String(row.data).includes(secret))) report.findings.push(`database:${table.tablename.split(secret).join("[REDACTED]")}`);
  }
  report.success = report.findings.length === 0;
  if (!report.success) process.exitCode = 1;
} finally {
  await sqlClient.end();
  await mkdir(resolve(root, "artifacts/acceptance"), { recursive: true });
  await writeFile(resolve(root, "artifacts/acceptance/secret-audit.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
