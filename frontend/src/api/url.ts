const LOCAL_DEV_API_BASE_URL = "http://localhost:3001/api";
const PRODUCTION_API_BASE_URL = "/api";

type ApiEnv = {
  DEV?: boolean;
  VITE_API_BASE_URL?: string;
};

export function getApiBaseUrl(env: ApiEnv = import.meta.env) {
  const configuredUrl = env.VITE_API_BASE_URL?.trim();

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  return env.DEV ? LOCAL_DEV_API_BASE_URL : PRODUCTION_API_BASE_URL;
}

export function toBackendUrl(url: string, apiBaseUrl = getApiBaseUrl()) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  const backendBaseUrl = apiBaseUrl.endsWith("/api") ? apiBaseUrl.slice(0, -4) : "";
  return `${backendBaseUrl}${normalizePath(url)}`;
}

function normalizePath(value: string) {
  return value.startsWith("/") ? value : `/${value}`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
