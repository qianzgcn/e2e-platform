import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildPrompt } from "../../src/services/agentService.js";

test("buildPrompt instructs Claude to resolve navigation through baseUrl without verbose repetition", () => {
  const prompt = buildPrompt(
    [
      {
        id: "todo-delete",
        title: "删除待办",
        naturalLanguage: "进入首页，删除一个待办。",
      },
    ],
    "https://todo.example.com/app",
  );

  assert.match(prompt, /导航：使用完整 URL/);
  assert.match(prompt, /禁止 page\.goto\('\/'\)/);
  assert.match(prompt, /https:\/\/todo\.example\.com\/app/);
  assert.doesNotMatch(prompt, /导航代码统一写成/);
  assert.doesNotMatch(prompt, /必须根据输入数据中的 `baseUrl` 生成导航地址/);
});

test("buildPrompt points Claude to the stable script format contract", () => {
  const prompt = buildPrompt(
    [
      {
        id: "todo-delete",
        title: "删除待办",
        naturalLanguage: "删除一个待办。",
      },
    ],
    "https://demo.playwright.dev/todomvc/#/",
  );

  assert.match(prompt, /优先级/);
  assert.match(prompt, /输出格式/);
  assert.match(prompt, /步骤 N/);
  assert.match(prompt, /断言 N/);
});

test("CLAUDE.md defines one concrete output example with step and assertion comments", () => {
  const instructions = readFileSync("CLAUDE.md", "utf8");

  assert.match(instructions, /输出模板/);
  assert.match(instructions, /\/\/ 步骤 1：访问待办应用首页/);
  assert.match(instructions, /await page\.goto\('https:\/\/demo\.playwright\.dev\/todomvc\/#\/'\);/);
  assert.match(instructions, /\/\/ 断言 1：页面标题正确/);
  assert.match(instructions, /\/\/ 步骤 3：删除该待办/);
  assert.doesNotMatch(instructions, /必须根据输入数据中的 `baseUrl` 生成导航地址/);
  assert.doesNotMatch(instructions, /导航代码统一写成/);
});
