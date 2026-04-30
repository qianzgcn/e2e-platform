
  import { test, expect } from '@playwright/test';
  test("验证百度首页 e038c5d3-17a2-4fed-9fb3-90a73de47777", async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度1下/);
  await expect(page.getByRole('button', { name: '百度1下' })).toBeVisible();});