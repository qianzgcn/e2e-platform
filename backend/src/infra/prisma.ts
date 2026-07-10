import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

export function databaseUrlToMariaDbConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);

  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 5,
    // MySQL 8+ 使用 caching_sha2_password 认证，需允许客户端获取 RSA 公钥
    allowPublicKeyRetrieval: true,
  };
}

const adapter = new PrismaMariaDb(databaseUrlToMariaDbConfig(process.env.DATABASE_URL!));

export const prisma = new PrismaClient({ adapter });
