import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGates, type Facts } from "../server/tasks/gates/gates.ts";
import {
  checkScreenshot,
  readScreenshots,
  screenshotUrls,
} from "../server/tasks/gates/screenshot-facts.ts";

const pr = {
  number: 1,
  url: "https://github.com/a/b/pull/1",
  state: "OPEN",
  body: "",
};
const facts: Facts = {
  repo: true,
  branch: "task-t1-ui",
  base: "main",
  pr,
  ci: null,
  numstat: [],
  functions: [],
  dirty: [],
  ahead: 1,
  pushed: true,
  claims: [],
};

test("截图链接提取只认 Markdown 图片和 GitHub 附件，去重", () => {
  assert.deepEqual(
    screenshotUrls(
      "[普通链接](https://example.com/a.png) ![首页](https://example.com/a.png) " +
        '![深色](<https://example.com/dark.webp> "深色") ' +
        "https://github.com/user-attachments/assets/abc-123 " +
        "https://github.com/user-attachments/assets/abc-123",
    ),
    [
      "https://example.com/a.png",
      "https://example.com/dark.webp",
      "https://github.com/user-attachments/assets/abc-123",
    ],
  );
  assert.deepEqual(screenshotUrls("已截图，但未附图"), []);
});

test("HEAD 200 才通过；404、异常及非公网跳转留下原因", async () => {
  const calls: string[] = [];
  const head = async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    return {
      status: url.endsWith("/bad.png") ? 404 : 200,
      headers: new Headers(),
    };
  };
  assert.deepEqual(
    await readScreenshots(
      "![好](https://example.com/good.png) ![坏](https://example.com/bad.png)",
      head,
    ),
    [
      { url: "https://example.com/good.png", status: 200 },
      { url: "https://example.com/bad.png", status: 404 },
    ],
  );
  assert.deepEqual(calls, [
    "HEAD https://example.com/good.png",
    "HEAD https://example.com/bad.png",
  ]);
  assert.deepEqual(
    await checkScreenshot("https://example.com/no.png", async () => {
      throw new Error("网络不可用");
    }),
    { url: "https://example.com/no.png", error: "HEAD 请求失败" },
  );
  assert.deepEqual(
    await checkScreenshot("https://example.com/a.png", async () => ({
      status: 302,
      headers: new Headers({ location: "https://127.0.0.1/private" }),
    })),
    {
      url: "https://example.com/a.png",
      error: "重定向缺失或指向非公网 HTTPS 链接",
    },
  );
});

test("screenshots 判定：无图、404 和多图一张坏均不过", () => {
  const noPr = evaluateGates(["screenshots"], {}, { ...facts, pr: null });
  assert.match(noPr.failed[0]!.evidence, /请开 PR/);
  const noImage = evaluateGates(["screenshots"], {}, facts);
  assert.match(noImage.failed[0]!.evidence, /请添加 Markdown 图片/);
  const url = "https://example.com/a.png";
  const bad = evaluateGates(
    ["screenshots"],
    {},
    {
      ...facts,
      screenshots: [{ url, status: 404 }],
    },
  );
  assert.match(bad.failed[0]!.evidence, /a\.png（404）/);
  const mixed = evaluateGates(
    ["screenshots"],
    {},
    {
      ...facts,
      screenshots: [
        { url, status: 200 },
        { url: "https://example.com/b.png", status: 404 },
      ],
    },
  );
  assert.equal(mixed.passed, false);
  assert.match(mixed.failed[0]!.evidence, /b\.png（404）/);
  const signed = evaluateGates(
    ["screenshots"],
    {},
    {
      ...facts,
      screenshots: [{ url: `${url}?token=private`, status: 404 }],
    },
  );
  assert.doesNotMatch(signed.failed[0]!.evidence, /private/);
  assert.equal(
    evaluateGates(
      ["screenshots"],
      {},
      {
        ...facts,
        screenshots: [{ url, status: 200 }],
      },
    ).passed,
    true,
  );
  assert.equal(
    evaluateGates(
      ["screenshot"],
      {},
      {
        ...facts,
        screenshots: [{ url, status: 200 }],
      },
    ).passed,
    true,
  );
});
