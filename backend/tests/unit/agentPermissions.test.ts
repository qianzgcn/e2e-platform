import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isAllowedScriptAgentBashCommand } from "../../src/infra/scriptAgentToolPolicy.js";

type ClaudeSettings = {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
};

test("script agents only receive the required unattended shell permissions", async () => {
  const settingsPath = path.resolve(process.cwd(), ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as ClaudeSettings;
  const allow = settings.permissions?.allow ?? [];

  assert.deepEqual(
    allow.filter((rule) => rule.startsWith("Bash")),
    ["Bash(playwright-cli *)", "Bash(npm run test:generated *)"],
  );
  assert.equal(allow.includes("Skill(playwright-cli)"), true);
  assert.equal(allow.includes("Bash"), false);
  assert.equal(allow.includes("Bash(*)"), false);
});

test("script agent permissions protect environment files", async () => {
  const settingsPath = path.resolve(process.cwd(), ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as ClaudeSettings;
  const deny = settings.permissions?.deny ?? [];

  assert.equal(deny.includes("Read(./.env)"), true);
  assert.equal(deny.includes("Read(./.env.*)"), true);
  assert.equal(deny.includes("Write(./.env)"), true);
  assert.equal(deny.includes("Edit(./.env)"), true);
});

test("playwright agent instructions require direct single-command CLI calls", async () => {
  const [skill, ...systemPrompts] = await Promise.all([
    readFile(path.resolve(process.cwd(), ".claude", "skills", "playwright-cli", "SKILL.md"), "utf8"),
    readFile(path.resolve(process.cwd(), "prompts", "script-generation.system.md"), "utf8"),
    readFile(path.resolve(process.cwd(), "prompts", "script-repair.system.md"), "utf8"),
  ]);

  for (const content of [skill, ...systemPrompts]) {
    assert.match(content, /直接执行 `playwright-cli`|Invoke `playwright-cli` directly/);
    assert.match(content, /每次 Bash 调用只能包含一条|Each Bash tool call must contain exactly one/);
    assert.match(content, /不得搜索 Skill 文件|Do not search for this Skill/);
  }

  assert.doesNotMatch(skill, /^TOKEN=\$\(|^diff /m);
  for (const line of skill.split(/\r?\n/).filter((item) => item.startsWith("playwright-cli "))) {
    assert.equal(isAllowedScriptAgentBashCommand(line), true, line);
  }
});

test("script agent Bash policy allows only direct CLI and generated-test commands", () => {
  const allowed = [
    "playwright-cli --version",
    "playwright-cli open http://localhost:5173",
    "playwright-cli eval \"element => element.textContent\"",
    "playwright-cli eval 'async element => { await element.click(); }'",
    "npm run test:generated -- tests/generated/case-1.spec.ts",
    "npm run test:generated -- tests/generated/case-1.repair-42.spec.ts",
  ];
  const denied = [
    "which playwright-cli",
    "playwright-cli --version; node --version",
    "playwright-cli --version && node --version",
    "playwright-cli --version | head -1",
    "playwright-cli eval \"$(node --version)\"",
    "playwright-cli eval `node --version`",
    "playwright-cli --version > version.txt",
    "npm run test:generated",
    "npm run test:generated -- tests/generated/case.spec.ts --config other.config.ts",
    " npm run test:generated -- tests/generated/case.spec.ts",
  ];

  for (const command of allowed) assert.equal(isAllowedScriptAgentBashCommand(command), true, command);
  for (const command of denied) assert.equal(isAllowedScriptAgentBashCommand(command), false, command);
});
