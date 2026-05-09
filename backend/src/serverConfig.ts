import path from "node:path";

const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_FRONTEND_STATIC_DIR = "public";

export function getServerPort(env: NodeJS.ProcessEnv = process.env) {
  const rawPort = env.PORT;

  if (!rawPort) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number(rawPort);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT;
}

export function getFrontendStaticDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const staticDir = env.FRONTEND_STATIC_DIR || DEFAULT_FRONTEND_STATIC_DIR;
  return path.resolve(cwd, staticDir);
}
