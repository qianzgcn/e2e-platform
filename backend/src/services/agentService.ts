type ScriptSource = {
  title: string;
  id: string;
};

export async function generateScript(testCase: ScriptSource) {
  return `
  import { test, expect } from '@playwright/test';
  test(${JSON.stringify(`验证百度首页 ${testCase.id}`)}, async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度1下/);
  await expect(page.getByRole('button', { name: '百度1下' })).toBeVisible();});`;
}
