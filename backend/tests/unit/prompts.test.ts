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
} from "../../src/prompts/scriptGeneration.js";

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
  const [casePrompt, scriptPrompt] = await Promise.all([
    loadCaseGenerationSystemPrompt(),
    loadScriptGenerationSystemPrompt(),
  ]);

  assert.match(casePrompt, /E2E 自然语言用例生成/);
  assert.match(scriptPrompt, /Playwright 自动化脚本生成/);
});
