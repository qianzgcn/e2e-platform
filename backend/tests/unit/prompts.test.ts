import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCaseGenerationPrompt,
  loadCaseGenerationSystemPrompt,
  parseTestCaseCandidates,
} from "../../src/prompts/caseGeneration.js";
import {
  buildScriptGenerationPrompt,
  loadScriptGenerationSystemPrompt,
  parseScriptGenerationError,
} from "../../src/prompts/scriptGeneration.js";
import {
  assertNoProjectVariableValues,
  assertPreservesVariablePlaceholders,
  buildScriptRepairPrompt,
  loadScriptRepairSystemPrompt,
  parseScriptRepairResult,
  redactProjectVariableValues,
} from "../../src/prompts/scriptRepair.js";

test("case generation prompt keeps dynamic inputs as separate JSON fields", () => {
  const project = {
    variables: [
      { name: " username ", value: "secret-user" },
      { name: "password", value: "secret-password" },
      { name: " ", value: "ignored" },
    ],
    promptHint: " 必须覆盖\"管理员\"角色\n并检查权限 ",
  };
  const prompt = buildCaseGenerationPrompt(
    project,
    " 生成 20 条\n重点覆盖登录 ",
  );

  assert.deepEqual(JSON.parse(prompt), {
    variablePlaceholders: ["${username}", "${password}"],
    projectInstructions: "必须覆盖\"管理员\"角色\n并检查权限",
    requestInstructions: "生成 20 条\n重点覆盖登录",
  });
  assert.equal(prompt.includes("secret-user"), false);
  assert.equal(prompt.includes("secret-password"), false);
});

test("case generation prompt normalizes empty instructions to null", () => {
  const prompt = buildCaseGenerationPrompt(
    { variables: [], promptHint: "  " },
    "\n",
  );

  assert.deepEqual(JSON.parse(prompt), {
    variablePlaceholders: [],
    projectInstructions: null,
    requestInstructions: null,
  });
});

test("script generation prompt contains one case and project instructions", () => {
  const testCase = {
    id: "case-1",
    title: "新增用户",
    naturalLanguage: "1. 输入账号 \"alice\"\n2. 验证新增成功",
  };
  const prompt = buildScriptGenerationPrompt(testCase, "http://localhost:5173", " 仅管理员可操作 ");

  assert.deepEqual(JSON.parse(prompt), {
    baseUrl: "http://localhost:5173",
    outputDir: "tests/generated",
    projectInstructions: "仅管理员可操作",
    testCase,
  });
});

test("script generation error parser returns an actionable problem and suggestion", () => {
  const result = parseScriptGenerationError(`无法继续生成：
<script-generation-error>
问题：步骤 2 要选择项目“示例项目”，但前置条件没有说明该项目应已存在，真实页面中也未找到该数据。
修改建议：在前置步骤中创建“示例项目”，或把步骤 2 改为选择一个明确存在的项目变量。
</script-generation-error>`);

  assert.deepEqual(result, {
    problem: "步骤 2 要选择项目“示例项目”，但前置条件没有说明该项目应已存在，真实页面中也未找到该数据。",
    suggestion: "在前置步骤中创建“示例项目”，或把步骤 2 改为选择一个明确存在的项目变量。",
  });
});

test("script generation error parser ignores success and rejects incomplete error reports", () => {
  assert.equal(parseScriptGenerationError("脚本已生成并验证通过"), null);
  assert.throws(
    () => parseScriptGenerationError("<script-generation-error>\n问题：缺少前置数据"),
    /格式不完整/,
  );
  assert.throws(
    () =>
      parseScriptGenerationError(
        "<script-generation-error>\n问题： \n修改建议：补充数据\n</script-generation-error>",
      ),
    /缺少问题描述或修改建议/,
  );
});

test("script repair prompt keeps evidence fields inside valid JSON", () => {
  const input = {
    baseUrl: "http://localhost:5173",
    targetFile: "tests/generated/case-1.spec.ts",
    businessRepository: "C:/repo/business",
    projectInstructions: "仅管理员可操作",
    testCase: {
      id: "case-1",
      title: "新增用户",
      originalNaturalLanguage: "1. 输入 ${username}\n2. 保存",
      resolvedNaturalLanguage: "1. 输入 admin\n2. 保存",
    },
    currentScript: "test('新增用户', async () => {})",
    sourceFailure: {
      runLogId: 12,
      failureReason: "按钮不可见",
      stdout: "line 1\nline 2",
      stderr: "locator timeout",
      artifactPaths: ["C:/results/error-context.md"],
      videoFramePaths: ["C:/frames/frame-1.png"],
    },
  };

  assert.deepEqual(JSON.parse(buildScriptRepairPrompt(input)), input);
});

test("script repair result parser accepts exactly three strict outcomes", () => {
  assert.deepEqual(
    parseScriptRepairResult('<script-repair-result>{"outcome":"script_repair","summary":"修正按钮定位"}</script-repair-result>'),
    { outcome: "script_repair", summary: "修正按钮定位" },
  );
  assert.deepEqual(
    parseScriptRepairResult('<script-repair-result>{"outcome":"case_repair","problem":"缺少前置项目","suggestion":"补充项目变量","naturalLanguage":"1. 选择 ${project}"}</script-repair-result>'),
    { outcome: "case_repair", problem: "缺少前置项目", suggestion: "补充项目变量", naturalLanguage: "1. 选择 ${project}" },
  );
  assert.deepEqual(
    parseScriptRepairResult('<script-repair-result>{"outcome":"unrepairable","category":"business","problem":"接口返回错误","suggestion":"修复业务接口"}</script-repair-result>'),
    { outcome: "unrepairable", category: "business", problem: "接口返回错误", suggestion: "修复业务接口" },
  );
  assert.throws(
    () => parseScriptRepairResult('<script-repair-result>{"outcome":"script_repair","summary":"ok","extra":true}</script-repair-result>'),
    /格式无效/,
  );
  assert.throws(() => parseScriptRepairResult("没有结果块"), /完整的修复结果/);
});

test("repair candidate rejects real project variable values and redacts messages", () => {
  const variables = [{ name: "password", value: "SuperSecret" }];
  assert.throws(
    () => assertNoProjectVariableValues("1. 输入 SuperSecret", variables),
    /变量 password 的真实值/,
  );
  assert.doesNotThrow(() => assertNoProjectVariableValues("1. 输入 ${password}", variables));
  assert.equal(redactProjectVariableValues("密码 SuperSecret 无效", variables), "密码 ${password} 无效");
});

test("repair candidate preserves every variable placeholder from the source case", () => {
  assert.doesNotThrow(() => assertPreservesVariablePlaceholders(
    "1. 输入 ${ username }\n2. 输入 ${password}",
    "1. 输入 ${username}\n2. 输入 ${password}\n3. 提交",
  ));
  assert.throws(
    () => assertPreservesVariablePlaceholders("1. 输入 ${username}\n2. 输入 ${password}", "1. 输入 ${username}"),
    /缺少原用例变量 \$\{password\}/,
  );
});

test("candidate parser accepts strict valid JSON and trims fields", () => {
  const candidates = parseTestCaseCandidates(`结果如下：
\`\`\`json
[{"title":" 登录 ","groupName":" 认证 ","naturalLanguage":" 1. 打开登录页 "}]
\`\`\``);

  assert.deepEqual(candidates, [
    { title: "登录", groupName: "认证", naturalLanguage: "1. 打开登录页" },
  ]);
});

test("candidate parser rejects invalid candidate structures", () => {
  assert.throws(
    () => parseTestCaseCandidates('[{"title":"登录","groupName":"认证"}]'),
    /格式不符合要求/,
  );
  assert.throws(
    () => parseTestCaseCandidates('[{"title":"登录","groupName":"认证","naturalLanguage":"步骤","extra":true}]'),
    /格式不符合要求/,
  );
  assert.throws(() => parseTestCaseCandidates("[]"), /格式不符合要求/);
  assert.throws(() => parseTestCaseCandidates('{"title":"登录"}'), /未找到 JSON 数组/);
  assert.throws(() => parseTestCaseCandidates("[invalid]"), /无法解析为 JSON/);
});

test("system prompt files are available from the backend runtime directory", async () => {
  const [casePrompt, scriptPrompt, repairPrompt] = await Promise.all([
    loadCaseGenerationSystemPrompt(),
    loadScriptGenerationSystemPrompt(),
    loadScriptRepairSystemPrompt(),
  ]);

  assert.match(casePrompt, /E2E 自然语言用例生成/);
  assert.match(scriptPrompt, /Playwright 自动化脚本生成/);
  assert.match(scriptPrompt, /不得创建或覆盖 spec/);
  assert.match(scriptPrompt, /修改建议/);
  assert.match(repairPrompt, /Playwright 自动化用例修复/);
  assert.match(repairPrompt, /case_repair/);
});
