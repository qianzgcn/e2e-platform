
  import { test, expect } from '@playwright/test';
  test("验证百度首页 1", async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度一下/);
  await expect(page.getByRole('button', { name: '百度一下' })).toBeVisible();});