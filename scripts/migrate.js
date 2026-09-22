
const path = require("node:path");
const { openDatabase } = require("../src/db");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
const db = openDatabase(databasePath);
db.close();
console.log(`数据库迁移完成：${databasePath}`);
