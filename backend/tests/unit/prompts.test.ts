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
  assertUsesOnlySourceVariablePlaceholders,
  buildScriptRepairPrompt,
  loadScriptRepairSystemPrompt,
  parseScriptRepairResult,
  redactProjectVariableValues,
} from "../../src/prompts/scriptRepair.js";
import { validateTestDataSafety } from "../../src/prompts/testDataSafety.js";

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

test("case generation does not receive project automation instructions", () => {
  const project = {
    variables: [{ name: "username" }],
    promptHint: "覆盖登录后的业务流程",
    automationHint: "仅供脚本生成使用的登录细节",
    automationAdapterKey: "pdk-qa",
  };

  const parsed = JSON.parse(buildCaseGenerationPrompt(project));
  assert.equal(parsed.automationInstructions, undefined);
  assert.equal(parsed.automationAdapter, undefined);
  assert.equal(JSON.stringify(parsed).includes(project.automationHint), false);
  assert.equal(JSON.stringify(parsed).includes(project.automationAdapterKey), false);
});

test("script generation prompt contains one case and project instructions", () => {
  const testCase = {
    id: "case-1",
    title: "新增用户",
    originalNaturalLanguage: "1. 输入账号 ${username}\n2. 验证新增成功",
    naturalLanguage: "1. 输入账号 \"alice\"\n2. 验证新增成功",
    protectedVariablePlaceholders: ["${username}"],
  };
  const prompt = buildScriptGenerationPrompt(
    testCase,
    "http://localhost:5173",
    " 仅管理员可操作 ",
    " 登录方式需要从项目配置读取 ",
    {
      key: "pdk-qa",
      modulePath: "tests/project-helpers/pdk-qa/index.ts",
      importPath: "../project-helpers/pdk-qa",
    },
  );

  assert.deepEqual(JSON.parse(prompt), {
    baseUrl: "http://localhost:5173",
    outputDir: "tests/generated",
    projectInstructions: "仅管理员可操作",
    automationInstructions: "登录方式需要从项目配置读取",
    automationAdapter: {
      key: "pdk-qa",
      modulePath: "tests/project-helpers/pdk-qa/index.ts",
      importPath: "../project-helpers/pdk-qa",
    },
    testCase,
  });
});

test("script generation prompt normalizes empty project instructions", () => {
  const prompt = buildScriptGenerationPrompt(
    {
      id: "case-1",
      title: "查看首页",
      originalNaturalLanguage: "1. 打开首页",
      naturalLanguage: "1. 打开首页",
      protectedVariablePlaceholders: [],
    },
    "https://example.test",
    " ",
    "\n",
  );

  const parsed = JSON.parse(prompt);
  assert.equal(parsed.projectInstructions, null);
  assert.equal(parsed.automationInstructions, null);
  assert.equal(parsed.automationAdapter, null);
});

test("script generation error parser returns an actionable problem and suggestion", () => {
  const result = parseScriptGenerationError(`无法继续生成：
<script-generation-error>
问题：步骤 2 要选择项目“示例项目”，但前置条件没有说明该项目应已存在，真实页面中也未找到该数据。
修改建议：运行时创建唯一临时项目并在 finally 中清理，或者把步骤 2 改为只读查询一个明确存在的项目变量。
</script-generation-error>`);

  assert.deepEqual(result, {
    problem: "步骤 2 要选择项目“示例项目”，但前置条件没有说明该项目应已存在，真实页面中也未找到该数据。",
    suggestion: "运行时创建唯一临时项目并在 finally 中清理，或者把步骤 2 改为只读查询一个明确存在的项目变量。",
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
    repairMode: "script_or_case" as const,
    baseUrl: "http://localhost:5173",
    targetFile: "tests/generated/case-1.spec.ts",
    businessRepository: "C:/repo/business",
    projectInstructions: "仅管理员可操作",
    automationInstructions: "使用项目配置的登录流程",
    automationAdapter: {
      key: "pdk-qa",
      modulePath: "tests/project-helpers/pdk-qa/index.ts",
      importPath: "../project-helpers/pdk-qa",
    },
    testCase: {
      id: "case-1",
      title: "新增用户",
      originalNaturalLanguage: "1. 输入 ${username}\n2. 保存",
      resolvedNaturalLanguage: "1. 输入 admin\n2. 保存",
      protectedVariablePlaceholders: ["${username}"],
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

test("script repair prompt supports case-only diagnosis when script generation failed", () => {
  const prompt = buildScriptRepairPrompt({
    repairMode: "case_only",
    baseUrl: "http://localhost:5173",
    targetFile: "tests/generated/should-not-be-exposed.spec.ts",
    businessRepository: null,
    projectInstructions: null,
    automationInstructions: null,
    automationAdapter: null,
    testCase: {
      id: "case-1",
      title: "创建项目",
      originalNaturalLanguage: "1. 创建 ${testProject}",
      resolvedNaturalLanguage: "1. 创建 ProtectedFixtureProject",
      protectedVariablePlaceholders: ["${testProject}"],
    },
    currentScript: "test('must not be exposed', () => {})",
    sourceFailure: {
      runLogId: 1,
      failureReason: "项目 ProtectedFixtureProject 已存在",
      stdout: "无法创建 ProtectedFixtureProject",
      stderr: "ProtectedFixtureProject 冲突",
      artifactPaths: [],
      videoFramePaths: [],
    },
  }, [{ name: "testProject", value: "ProtectedFixtureProject" }]);

  const parsed = JSON.parse(prompt);
  assert.equal(parsed.repairMode, "case_only");
  assert.equal(parsed.targetFile, null);
  assert.equal(parsed.currentScript, null);
  assert.equal(parsed.testCase.resolvedNaturalLanguage, null);
  assert.equal(parsed.sourceFailure.failureReason, "项目 ${testProject} 已存在");
  assert.equal(parsed.sourceFailure.stdout, "无法创建 ${testProject}");
  assert.equal(parsed.sourceFailure.stderr, "${testProject} 冲突");
  assert.doesNotMatch(prompt, /ProtectedFixtureProject/);
  assert.doesNotMatch(prompt, /must not be exposed/);
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
  assert.throws(
    () => parseScriptRepairResult(
      '<script-repair-result>{"outcome":"script_repair","summary":"修正脚本"}</script-repair-result>',
      "case_only",
    ),
    /没有可修复的 Playwright 脚本/,
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

test("repair candidate may remove an unsafe placeholder but cannot introduce unknown placeholders", () => {
  assert.doesNotThrow(() => assertUsesOnlySourceVariablePlaceholders(
    "1. 输入 ${ username }\n2. 输入 ${password}",
    "1. 输入 ${username}\n2. 使用运行时唯一临时数据",
  ));
  assert.throws(
    () => assertUsesOnlySourceVariablePlaceholders("1. 输入 ${username}", "1. 输入 ${manager}"),
    /引入了原用例未配置的变量 \$\{manager\}/,
  );
});

test("test data safety rejects writes to existing data without isolated setup and cleanup", () => {
  const issue = validateTestDataSafety([
    "1. 使用 ${admin_user} 与 ${admin_password} 登录系统",
    "2. 点击新建项目",
    "3. 在项目名称输入 ${testProject}",
    "4. 点击确定",
    "5. 预期提示创建成功",
  ].join("\n"));

  assert.ok(issue);
  assert.match(issue.problem, /已经存在的所有业务数据都禁止修改或删除/);
  assert.match(issue.suggestion, /先创建临时对象/);
});

test("test data safety accepts read-only cases and isolated write cases", () => {
  assert.equal(validateTestDataSafety(
    "1. 使用 ${admin_user} 登录\n2. 查询项目 ${testProject}\n3. 断言项目详情可见",
  ), null);
  assert.equal(validateTestDataSafety([
    "1. 使用 ${admin_user} 登录",
    "2. 本次运行生成唯一临时项目名称",
    "3. 创建临时项目，只操作本次创建的项目并断言创建成功",
    "4. 在 finally 中无论成功或失败都清理本次临时项目",
  ].join("\n")), null);
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
  assert.match(casePrompt, /受保护的既有业务数据/);
  assert.match(scriptPrompt, /Playwright 自动化脚本生成/);
  assert.match(scriptPrompt, /automationInstructions/);
  assert.match(scriptPrompt, /automationAdapter/);
  assert.match(scriptPrompt, /必须先读取其 `modulePath`/);
  assert.match(scriptPrompt, /禁止复制其实现/);
  assert.match(scriptPrompt, /Adapter 始终只读/);
  assert.match(scriptPrompt, /不得创建或覆盖 spec/);
  assert.match(scriptPrompt, /修改建议/);
  assert.doesNotMatch(scriptPrompt, /_COOKIE_KEY_CAPTCHA_|Element Plus|\.\.\/utils\/auth|\/login/);
  assert.match(repairPrompt, /Playwright 自动化用例修复/);
  assert.match(repairPrompt, /automationInstructions/);
  assert.match(repairPrompt, /automationAdapter/);
  assert.match(repairPrompt, /禁止复制、替代或编辑 Adapter/);
  assert.match(repairPrompt, /case_repair/);
  assert.match(repairPrompt, /受保护的既有业务数据/);
});
