"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(databasePath) {
  const target = databasePath || process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const database = new DatabaseSync(target);
  database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const migrationsDir = path.join(__dirname, "..", "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return database;
}

module.exports = { openDatabase };
