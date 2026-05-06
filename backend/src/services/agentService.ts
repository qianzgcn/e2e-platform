type ScriptSource = {
  title: string;
  id: string;
};

export async function generateScript(testCase: ScriptSource) {
  const testTitle = `${testCase.title} ${testCase.id}`;

  // MVP 阶段先保留 agent 的服务边界，后续只需要替换这里的实现即可接入真实 AI。
  // 测试标题里带上用例 id，runner 会通过 --grep 精准执行本次用例。
  return `
import { test, expect } from '@playwright/test';

test(${JSON.stringify(testTitle)}, async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度/);
  await expect(page.getByRole('button', { name: '百度一下' })).toBeVisible();
});
`;
}
