import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

function databaseUrlToMariaDbConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);

  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 5,
  };
}

const adapter = new PrismaMariaDb(databaseUrlToMariaDbConfig(process.env.DATABASE_URL!));

export const prisma = new PrismaClient({ adapter });
