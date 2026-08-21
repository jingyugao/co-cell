import { migrateBusinessDatabase } from "./business-migrations.js";

const connectionString = process.env.AGENT_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("AGENT_DATABASE_URL is required");
}

const applied = await migrateBusinessDatabase({ connectionString });
process.stdout.write(
  applied.length > 0
    ? `Applied business migrations:\n${applied.map((file) => `- ${file}`).join("\n")}\n`
    : "Business database is already up to date.\n",
);
