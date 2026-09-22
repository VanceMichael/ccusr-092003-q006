
const { openDatabase } = require("../src/db");

const databasePath = process.env.DATABASE_PATH;
const database = openDatabase(databasePath);
database.close();
console.log(`数据库迁移完成：${databasePath || require("node:path").join(process.cwd(), "data", "app.sqlite3")}`);
