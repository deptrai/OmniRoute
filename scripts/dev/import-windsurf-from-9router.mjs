// Import 2 windsurf apikey connections from 9router DB into local OmniRoute.
// Uses createProviderConnection so dedup (#3023), encryption, and backup pre-write fire.
//
// Run: node --import tsx/esm scripts/dev/import-windsurf-from-9router.mjs
import Database from "better-sqlite3";
import { createProviderConnection, getProviderConnections } from "../../src/lib/db/providers.ts";

const NINEROUTER_DB = `${process.env.HOME}/.9router/db/data.sqlite`;

// Read the 2 windsurf apikey rows from 9router (read-only)
const nine = new Database(NINEROUTER_DB, { readonly: true, fileMustExist: true });
const rows = nine
  .prepare(
    "SELECT id, name, data FROM providerConnections WHERE provider = 'windsurf' AND authType = 'apikey' ORDER BY priority"
  )
  .all() as Array<{ id: string; name: string; data: string }>;
nine.close();

console.log(`9router windsurf apikey rows found: ${rows.length}`);

console.log("\nBefore:");
const before = await getProviderConnections({ provider: "windsurf" });
for (const c of before) {
  console.log(`  id=${c.id} authType=${c.authType} name=${JSON.stringify(c.name)} test=${c.testStatus || "-"}`);
}

for (const row of rows) {
  const parsed = JSON.parse(row.data);
  const payload = {
    provider: "windsurf",
    authType: "apikey",
    name: row.name,
    apiKey: parsed.apiKey,
    providerSpecificData: parsed.providerSpecificData || {},
    isActive: 1,
  };
  console.log(`\nImporting "${row.name}" (apiKey prefix: ${parsed.apiKey.slice(0, 30)}…)`);
  try {
    const created = await createProviderConnection(payload);
    console.log(`  -> created id=${created?.id ?? "(existing/upserted)"}`);
  } catch (err) {
    console.error(`  -> FAILED:`, err instanceof Error ? err.message : err);
  }
}

console.log("\nAfter:");
const after = await getProviderConnections({ provider: "windsurf" });
for (const c of after) {
  console.log(`  id=${c.id} authType=${c.authType} name=${JSON.stringify(c.name)} test=${c.testStatus || "-"}`);
}
console.log(`\nWindsurf count: ${before.length} -> ${after.length}`);
