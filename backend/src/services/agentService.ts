type ScriptSource = {
  title: string;
  id: string;
  naturalLanguage: string;
};

export async function generateScript(testCase: ScriptSource) {
  const testTitle = testCase.title;

  // MVP 阶段先保留 agent 的服务边界，后续只需要替换这里的实现即可接入真实 AI。
  // 这里等待 10 秒，用于模拟真实 agent 的响应延迟。
  await delay(10_000);

  return `
import { test, expect } from '@playwright/test';

test(${JSON.stringify(testTitle)}, async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度一下/);
  await expect(page.getByRole('button', { name: '百度一下' })).toBeVisible();
});
`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
