import assert from "node:assert/strict";
import test from "node:test";
import { generateTestCaseCandidates } from "../../src/services/caseGenerationService.js";

const safeCandidate = {
  title: "查看项目详情",
  groupName: "项目管理",
  naturalLanguage: "1. 查询项目 ${testProject}\n2. 断言项目详情可见",
};

const unsafeCandidate = {
  title: "成功创建新项目",
  groupName: "项目管理",
  naturalLanguage: "1. 在项目名称输入 ${testProject}\n2. 点击确定\n3. 预期提示创建成功",
};

const correctedCandidate = {
  title: "使用临时数据创建新项目",
  groupName: "项目管理",
  naturalLanguage: [
    "1. 本次运行生成唯一临时项目名称",
    "2. 创建临时项目，并只操作本次创建的项目",
    "3. 预期提示创建成功",
    "4. 在 finally 中无论成功、失败或断言异常都清理本次临时项目",
  ].join("\n"),
};

test("case generation automatically replaces only candidates that fail data safety", async () => {
  const prompts: string[] = [];
  const logs: string[] = [];
  const responses = [
    JSON.stringify([safeCandidate, unsafeCandidate]),
    JSON.stringify([correctedCandidate]),
  ];

  const result = await generateTestCaseCandidates(
    "C:\\workspace\\repo",
    {
      variables: [{ name: "testProject" }],
      promptHint: "不得影响已有数据",
    },
    undefined,
    {
      onProgress: (message) => logs.push(message),
      runClaude: async (prompt) => {
        prompts.push(prompt);
        return responses.shift()!;
      },
    },
  );

  assert.deepEqual(result.candidates, [safeCandidate, correctedCandidate]);
  assert.equal(prompts.length, 2);
  const correctionInput = JSON.parse(prompts[1]);
  assert.equal(correctionInput.mode, "correct_test_data_safety");
  assert.equal(correctionInput.unsafeCandidates.length, 1);
  assert.equal(correctionInput.unsafeCandidates[0].candidateNumber, 2);
  assert.deepEqual(correctionInput.unsafeCandidates[0].candidate, unsafeCandidate);
  assert.ok(logs.some((message) => message.includes("正在进行第 1 轮自动修正")));
  assert.ok(logs.some((message) => message.includes("所有候选均已通过测试数据安全校验")));
});

test("case generation fails only after bounded safety correction attempts", async () => {
  let callCount = 0;

  await assert.rejects(
    generateTestCaseCandidates(
      "C:\\workspace\\repo",
      { variables: [{ name: "testProject" }], promptHint: null },
      undefined,
      {
        runClaude: async () => {
          callCount += 1;
          return JSON.stringify([unsafeCandidate]);
        },
      },
    ),
    /AI 已自动修正 2 轮，但第 1 条候选仍未通过测试数据安全校验/,
  );
  assert.equal(callCount, 3);
});
