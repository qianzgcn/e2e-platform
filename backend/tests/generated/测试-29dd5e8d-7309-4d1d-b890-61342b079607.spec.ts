
  import { test, expect } from '@playwright/test';
  test("验证百度首页 29dd5e8d-7309-4d1d-b890-61342b079607", async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度一下/);
  await expect(page.getByRole('button', { name: '百度一下' })).toBeVisible();});