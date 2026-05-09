import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { getFrontendStaticDir, getServerPort } from "../../src/serverConfig.js";

test("getServerPort defaults to local development port", () => {
  assert.equal(getServerPort({}), 3001);
});

test("getServerPort reads PORT for Docker deployment", () => {
  assert.equal(getServerPort({ PORT: "9099" }), 9099);
});

test("getFrontendStaticDir defaults to public under current working directory", () => {
  assert.equal(getFrontendStaticDir({}, "/app"), path.resolve("/app", "public"));
});

test("getFrontendStaticDir accepts an explicit FRONTEND_STATIC_DIR", () => {
  assert.equal(getFrontendStaticDir({ FRONTEND_STATIC_DIR: "/srv/frontend" }, "/app"), "/srv/frontend");
});
