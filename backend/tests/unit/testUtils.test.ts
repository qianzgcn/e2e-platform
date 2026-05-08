import assert from "node:assert/strict";
import test from "node:test";

import { login } from "../utils/auth.ts";

test("login visits baseUrl login page and submits credentials with captcha", async () => {
  const events: string[] = [];
  const cookieSnapshots = [
    [],
    [{ name: "_COOKIE_KEY_CAPTCHA_", value: "upUd" }],
  ];
  const page = {
    goto: async (url: string) => {
      events.push(`goto:${url}`);
    },
    context: () => ({
      cookies: async () => cookieSnapshots.shift() ?? [],
    }),
    waitForTimeout: async (ms: number) => {
      events.push(`wait:${ms}`);
    },
    getByRole: (role: string, options: { name: string }) => ({
      fill: async (value: string) => {
        events.push(`fill:${role}:${options.name}:${value}`);
      },
      click: async () => {
        events.push(`click:${role}:${options.name}`);
      },
    }),
  };

  await login(page as never, {
    baseUrl: "http://113.44.81.150:8080/",
    username: "zhangqian",
    password: "Cloud@5036",
  });

  assert.deepEqual(events, [
    "goto:http://113.44.81.150:8080/login",
    "wait:100",
    "fill:textbox:*用户名:zhangqian",
    "fill:textbox:*密码:Cloud@5036",
    "fill:textbox:*验证码:upUd",
    "click:button:登录",
  ]);
});
