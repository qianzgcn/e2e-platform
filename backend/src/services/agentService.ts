type ScriptSource = {
  title: string;
  id: string;
  naturalLanguage: string;
};

export async function generateScript(testCase: ScriptSource) {
  const testTitle = `${testCase.title} ${testCase.id}`;
  const resolvedSteps = testCase.naturalLanguage
    .split(/\r?\n/)
    .map((line) => `// ${line}`)
    .join("\n");
  // MVP 阶段先保留 agent 的服务边界，后续只需要替换这里的实现即可接入真实 AI。
  // 测试标题里带上用例 id，runner 会通过 --grep 精准执行本次用例。
  return `
import { test, expect } from '@playwright/test';

// 解析后的自然语言步骤会传给真实 AI agent；当前默认实现先写入脚本注释，方便排查变量替换结果。
${resolvedSteps}
test(${JSON.stringify(testTitle)}, async ({ page }) => {
  await page.goto('https://www.baidu.com/');
  await expect(page).toHaveTitle(/百度一下/);
  await expect(page.getByRole('button', { name: '百度一下' })).toBeVisible();
});
`;
}
