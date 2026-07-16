import assert from "node:assert/strict";
import test from "node:test";
import {
  listProjectAutomationAdapters,
  resolveProjectAutomationAdapter,
  validateAutomationAdapterKey,
} from "../../src/infra/projectAutomationAdapter.js";

test("automation adapter keys reject path traversal and unsupported formats", () => {
  for (const key of ["pdk-qa", "project2", "v2-adapter"]) {
    assert.doesNotThrow(() => validateAutomationAdapterKey(key));
  }

  for (const key of ["../pdk-qa", "pdk/qa", "PDK-QA", "-pdk", "pdk--qa", "pdk-"]) {
    assert.throws(() => validateAutomationAdapterKey(key), /key 无效/);
  }
});

test("installed automation adapter resolves to its fixed entry and spec import path", async () => {
  assert.deepEqual(await resolveProjectAutomationAdapter("pdk-qa"), {
    key: "pdk-qa",
    modulePath: "tests/project-helpers/pdk-qa/index.ts",
    importPath: "../project-helpers/pdk-qa",
  });

  await assert.rejects(
    () => resolveProjectAutomationAdapter("missing-adapter"),
    /未安装.*tests\/project-helpers\/missing-adapter\/index\.ts/,
  );
});

test("automation adapter list only exposes installed entries", async () => {
  const adapters = await listProjectAutomationAdapters();
  assert.equal(adapters.includes("pdk-qa"), true);
  assert.deepEqual(adapters, [...adapters].sort());
});
