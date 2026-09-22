"use strict";

const { createDomain } = require("./domain");
const { createApp } = require("./app");
const { openDatabase } = require("./db");

function createServer(options = {}) {
  const database = options.database || openDatabase(options.databasePath);
  const domain = createDomain(database, options);
  return createApp(domain);
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
