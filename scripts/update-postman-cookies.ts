import { createProviderConnection } from "../src/lib/db/providers.ts";
import { getDbInstance } from "../src/lib/db/core.ts";

const fullCookie = process.env.POSTMAN_COOKIE || "";
const teamDomain = process.env.POSTMAN_TEAM_DOMAIN || "epsiloncryptoai-7880991";
const workspaceId = process.env.POSTMAN_WORKSPACE_ID || "280d1867-5a3e-41c7-8465-9e4b0edf866f";

async function updateCookies() {
  if (!fullCookie) {
    console.log(
      "Usage: POSTMAN_COOKIE='postman.sid=...' npx tsx scripts/update-postman-cookies.ts"
    );
    return;
  }

  const db: any = getDbInstance();
  db.prepare("DELETE FROM provider_connections WHERE provider = 'postman-agent'").run();

  const res = await createProviderConnection({
    provider: "postman-agent",
    name: "Postman Agent (Claude Opus 4.8)",
    authType: "apikey",
    apiKey: fullCookie,
    isActive: true,
    priority: 0,
    providerSpecificData: {
      teamDomain,
      workspaceId,
    },
  });

  console.log("Updated SQLite with session cookie:", res?.id);
}

updateCookies().catch(console.error);
