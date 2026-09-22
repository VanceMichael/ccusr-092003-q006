
const path = require("node:path");
const { openDatabase } = require("./db");
const { RaceService } = require("./race");
const { createApp } = require("./http");

function createServer({ databasePath = process.env.DATABASE_PATH
  || path.join(process.cwd(), "data", "app.sqlite3") } = {}) {
  const db = openDatabase(databasePath);
  const service = new RaceService(db);
  const server = createApp(service);
  server.on("close", () => db.close());
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`赛事保障服务监听 0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
