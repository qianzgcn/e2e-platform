import type { Page } from '@playwright/test';

const CAPTCHA_COOKIE_NAME = '_COOKIE_KEY_CAPTCHA_';
const CAPTCHA_TIMEOUT_MS = 5_000;
const CAPTCHA_POLL_INTERVAL_MS = 100;

export type LoginOptions = {
  baseUrl: string;
  username: string;
  password: string;
};

/**
 * 从页面 cookies 中获取验证码。登录页的验证码 cookie 可能在 goto 后异步写入。
 */
async function getCaptchaFromCookie(page: Page): Promise<string> {
  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const cookies = await page.context().cookies();
    const captchaCookie = cookies.find(c => c.name === CAPTCHA_COOKIE_NAME);

    if (captchaCookie?.value) {
      return decodeURIComponent(captchaCookie.value);
    }

    await page.waitForTimeout(CAPTCHA_POLL_INTERVAL_MS);
  }

  throw new Error(`未从 Cookie 读取到验证码：${CAPTCHA_COOKIE_NAME}`);
}

export async function login(page: Page, options: LoginOptions): Promise<void> {
  await page.goto(`${options.baseUrl.replace(/\/+$/, '')}/login`);

  const captcha = await getCaptchaFromCookie(page);
  await page.getByRole('textbox', { name: '*用户名' }).fill(options.username);
  await page.getByRole('textbox', { name: '*密码' }).fill(options.password);
  await page.getByRole('textbox', { name: '*验证码' }).fill(captcha);
  await page.getByRole('button', { name: '登录' }).click();
}
