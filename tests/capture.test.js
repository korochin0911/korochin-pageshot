import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { captureFullPage, clipFor, createCaptureService, filenameFor } from "../capture.js";

function fixture() {
  const calls = [];
  const statuses = [];
  const tab = { id: 42, windowId: 7 };
  const api = {
    tabs: {
      query: async (query) => { calls.push(["query", query]); return [tab]; },
      captureVisibleTab: async (...args) => { calls.push(["visible", ...args]); return "data:image/png;base64,VIEW"; }
    },
    debugger: {
      attach: async (...args) => { calls.push(["attach", ...args]); },
      detach: async (...args) => { calls.push(["detach", ...args]); },
      sendCommand: async (target, method, params) => {
        calls.push([method, target, params]);
        return method === "Page.getLayoutMetrics"
          ? { cssContentSize: { x: 0, y: 0, width: 1200, height: 3500 }, contentSize: { width: 2400, height: 7000 } }
          : { data: "FULL" };
      }
    },
    downloads: { download: async (options) => { calls.push(["download", options]); return 123; } }
  };
  const run = createCaptureService(api, async (status) => { statuses.push(status); });
  return { api, calls, statuses, tab, run };
}

test("manifest wires both commands and only declares required permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(Object.keys(manifest.commands), ["capture-viewport", "capture-fullpage"]);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "debugger", "downloads", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  for (const name of [manifest.background.service_worker, manifest.action.default_popup]) {
    assert.ok((await readFile(new URL(`../${name}`, import.meta.url))).length);
  }
});

test("filenames distinguish modes and use local time with milliseconds", () => {
  assert.equal(filenameFor("viewport", new Date(2026, 8, 9, 1, 2, 3, 4)), "screenshots/screenshot-viewport-20260909-010203-004.png");
});

test("viewport uses the originating window without attaching a debugger", async () => {
  const f = fixture();
  assert.equal((await f.run("viewport", f.tab)).ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === "visible"), ["visible", 7, { format: "png" }]);
  assert.ok(!f.calls.some(([name]) => name === "attach"));
  const options = f.calls.find(([name]) => name === "download")[1];
  assert.equal(options.url, "data:image/png;base64,VIEW");
  assert.equal(options.saveAs, false);
  assert.equal(options.conflictAction, "uniquify");
  assert.equal(f.statuses.at(-1).state, "started");
});

test("full page uses CSS content dimensions and detaches before downloading", async () => {
  const f = fixture();
  assert.equal((await f.run("fullpage", f.tab)).ok, true);
  const capture = f.calls.find(([name]) => name === "Page.captureScreenshot");
  assert.deepEqual(capture[2], {
    format: "png", fromSurface: true, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1200, height: 3500, scale: 1 }
  });
  assert.ok(f.calls.findIndex(([name]) => name === "detach") < f.calls.findIndex(([name]) => name === "download"));
  assert.equal(f.calls.find(([name]) => name === "download")[1].url, "data:image/png;base64,FULL");
});

test("clip preserves negative content origins and rounds fractional dimensions up", () => {
  assert.deepEqual(clipFor({ cssContentSize: { x: -25, y: 0, width: 800.5, height: 2000.1 } }),
    { x: -25, y: 0, width: 801, height: 2001, scale: 1 });
  for (const height of [0, -1, NaN, Infinity]) {
    assert.throws(() => clipFor({ cssContentSize: { x: 0, y: 0, width: 100, height } }));
  }
  assert.throws(() => clipFor({ contentSize: { width: 100, height: 200 } }));
});

test("capture failures always detach and never download", async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async () => { throw new Error("capture failed"); };
  const result = await f.run("fullpage", f.tab);
  assert.equal(result.ok, false);
  assert.match(result.error, /capture failed/);
  assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
  assert.ok(!f.calls.some(([name]) => name === "download"));
  assert.equal(f.statuses.at(-1).state, "error");
});

test("attach failure does not detach another debugger session", async () => {
  const f = fixture();
  f.api.debugger.attach = async () => { throw new Error("Another debugger is already attached"); };
  const result = await f.run("fullpage", f.tab);
  assert.equal(result.ok, false);
  assert.match(result.error, /開発者ツール/);
  assert.ok(!f.calls.some(([name]) => name === "detach"));
});

test("original capture error survives a subsequent detach failure", async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async () => { throw new Error("original error"); };
  f.api.debugger.detach = async () => { throw new Error("detach error"); };
  await assert.rejects(captureFullPage(f.api, 42), /original error/);
});

test("a switched tab is not accidentally captured", async () => {
  const f = fixture();
  f.api.tabs.query = async () => [{ id: 99, windowId: 7 }];
  assert.equal((await f.run("viewport", f.tab)).ok, false);
  assert.ok(!f.calls.some(([name]) => name === "visible"));
});

test("missing tab and unknown mode never initiate capture", async () => {
  const f = fixture();
  f.api.tabs.query = async () => [];
  assert.equal((await f.run("viewport")).ok, false);
  assert.equal((await f.run("other")).ok, false);
  assert.equal(f.calls.length, 0);
});

test("overlapping requests are rejected and lock is released after failure", async () => {
  const f = fixture();
  let rejectCapture;
  const pending = new Promise((_, reject) => { rejectCapture = reject; });
  f.api.debugger.sendCommand = () => pending;
  const first = f.run("fullpage", f.tab);
  const second = await f.run("fullpage", f.tab);
  assert.equal(second.ok, false);
  assert.match(second.error, /処理中/);
  rejectCapture(new Error("failed"));
  await first;
  assert.equal((await f.run("viewport", f.tab)).ok, true);
});

test("rapid visible captures are throttled before the Chrome API call", async () => {
  const f = fixture();
  let time = 1000;
  const run = createCaptureService(f.api, async () => {}, () => time);
  assert.equal((await run("viewport", f.tab)).ok, true);
  assert.equal((await run("viewport", f.tab)).ok, false);
  time += 600;
  assert.equal((await run("viewport", f.tab)).ok, true);
  assert.equal(f.calls.filter(([name]) => name === "visible").length, 2);
});

test("download rejection is reported and next request can run", async () => {
  const f = fixture();
  f.api.downloads.download = async () => { throw new Error("download refused"); };
  assert.equal((await f.run("fullpage", f.tab)).ok, false);
  assert.match(f.statuses.at(-1).message, /download refused/);
  f.api.downloads.download = async () => 10;
  assert.equal((await f.run("fullpage", f.tab)).ok, true);
});
