import type { Page } from "@playwright/test";

const CAPTCHA_COOKIE_NAME = "_COOKIE_KEY_CAPTCHA_";
const CAPTCHA_TIMEOUT_MS = 5_000;
const CAPTCHA_POLL_INTERVAL_MS = 100;
const LOGIN_TIMEOUT_MS = 10_000;

export type LoginOptions = {
  baseUrl: string;
  username: string;
  password: string;
};

async function getCaptchaFromCookie(page: Page): Promise<string> {
  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const cookies = await page.context().cookies();
    const captchaCookie = cookies.find((cookie) => cookie.name === CAPTCHA_COOKIE_NAME);

    if (captchaCookie?.value) {
      return decodeURIComponent(captchaCookie.value);
    }

    await page.waitForTimeout(CAPTCHA_POLL_INTERVAL_MS);
  }

  throw new Error(`未从 Cookie 读取到验证码：${CAPTCHA_COOKIE_NAME}`);
}

export async function login(page: Page, options: LoginOptions): Promise<void> {
  const loginUrl = `${options.baseUrl.replace(/\/+$/, "")}/login`;
  const loginPathname = normalizePathname(new URL(loginUrl).pathname);

  await page.goto(loginUrl);
  await page.waitForLoadState("networkidle");

  const captcha = await getCaptchaFromCookie(page);
  await page.getByRole("textbox", { name: "*用户名" }).fill(options.username);
  await page.getByRole("textbox", { name: "*密码" }).fill(options.password);
  await page.getByRole("textbox", { name: "*验证码" }).fill(captcha);
  await page.getByRole("button", { name: "登录" }).click();

  try {
    await page.waitForURL(
      (url) => normalizePathname(url.pathname) !== loginPathname,
      { timeout: LOGIN_TIMEOUT_MS },
    );
  } catch {
    throw new Error("登录提交后仍停留在登录页");
  }
}

function normalizePathname(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}
