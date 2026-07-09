import { readFile } from "node:fs/promises";
import path from "node:path";
import mariadb from "mariadb";
import { databaseUrlToMariaDbConfig } from "../prisma.js";

const repeatableSqlFiles = ["init.sql", "add_column.sql", "change_column.sql", "add_project_id.sql"];

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function initializeDatabase() {
  const connection = await mariadb.createConnection(databaseUrlToMariaDbConfig(process.env.DATABASE_URL!));

  try {
    for (const fileName of repeatableSqlFiles) {
      await executeSqlFileIfExists(connection, fileName);
    }
  } finally {
    await connection.end();
  }
}

async function executeSqlFileIfExists(connection: mariadb.Connection, fileName: string) {
  const sqlPath = path.resolve(process.cwd(), "sql", fileName);
  let sql: string;

  try {
    sql = await readFile(sqlPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    await connection.query(statement);
  }
}
