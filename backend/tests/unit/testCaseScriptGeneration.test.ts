import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveScriptGenerationOnSave,
  shouldGenerateScript,
} from "../../src/utils/testCaseScriptGeneration.js";

test("shouldGenerateScript only enters agent when marked or script is empty", () => {
  assert.equal(shouldGenerateScript({ scriptNeedsGeneration: false, playwrightScript: "test('ok')" }), false);
  assert.equal(shouldGenerateScript({ scriptNeedsGeneration: true, playwrightScript: "test('ok')" }), true);
  assert.equal(shouldGenerateScript({ scriptNeedsGeneration: false, playwrightScript: "" }), true);
  assert.equal(shouldGenerateScript({ scriptNeedsGeneration: false, playwrightScript: null }), true);
});

test("resolveScriptGenerationOnSave invalidates current run artifacts whenever generation is required", () => {
  assert.deepEqual(
    resolveScriptGenerationOnSave(
      {
        naturalLanguage: "打开首页",
        playwrightScript: "test('old')",
        scriptNeedsGeneration: false,
      },
      {
        naturalLanguage: "打开首页并登录",
        scriptNeedsGeneration: false,
      },
    ),
    {
      scriptNeedsGeneration: true,
      resetRunState: true,
      clearScript: true,
      clearRunHistory: true,
    },
  );

  assert.deepEqual(
    resolveScriptGenerationOnSave(
      {
        naturalLanguage: "打开首页",
        playwrightScript: "test('old')",
        scriptNeedsGeneration: false,
      },
      {
        naturalLanguage: "打开首页",
        scriptNeedsGeneration: true,
      },
    ),
    {
      scriptNeedsGeneration: true,
      resetRunState: true,
      clearScript: true,
      clearRunHistory: true,
    },
  );

  assert.deepEqual(
    resolveScriptGenerationOnSave(
      {
        naturalLanguage: "打开首页",
        playwrightScript: "test('old')",
        scriptNeedsGeneration: true,
      },
      {
        naturalLanguage: "打开首页",
        scriptNeedsGeneration: false,
      },
    ),
    {
      scriptNeedsGeneration: false,
      resetRunState: false,
      clearScript: false,
      clearRunHistory: false,
    },
  );

  assert.deepEqual(
    resolveScriptGenerationOnSave(
      {
        naturalLanguage: "打开首页",
        playwrightScript: null,
        scriptNeedsGeneration: false,
      },
      {
        naturalLanguage: "打开首页",
        scriptNeedsGeneration: false,
      },
    ),
    {
      scriptNeedsGeneration: true,
      resetRunState: true,
      clearScript: false,
      clearRunHistory: true,
    },
  );
});
