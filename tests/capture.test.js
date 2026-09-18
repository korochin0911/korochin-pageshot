import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { captureFullPage, clipFor, createCaptureService, filenameFor, overlappingTileClips, tileClips, viewportFor } from "../capture.js";
import { copyDocumentTitleToClipboard, copyPngToClipboard } from "../clipboard.js";
import { bandsAreRepeated, repetitionBands } from "../image-analysis.js";

function fixture() {
  const calls = [];
  const statuses = [];
  const copies = [];
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
  const run = createCaptureService(
    api,
    async (status) => { statuses.push(status); },
    () => Date.now(),
    async (dataUrl) => { copies.push(dataUrl); }
  );
  return { api, calls, statuses, copies, tab, run };
}

test("manifest wires save and copy commands and only declares required permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(Object.keys(manifest.commands), [
    "capture-viewport", "capture-fullpage", "copy-viewport", "copy-fullpage", "copy-title"
  ]);
  assert.deepEqual(manifest.permissions.sort(), [
    "activeTab", "clipboardWrite", "debugger", "downloads", "offscreen", "scripting", "storage"
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.match(background, /scripting\.executeScript/);
  assert.match(background, /offscreen\.createDocument/);
  assert.equal(manifest.commands["copy-title"].suggested_key, undefined);
  const shortcuts = Object.values(manifest.commands)
    .filter((command) => command.suggested_key)
    .map((command) => command.suggested_key.default);
  assert.equal(new Set(shortcuts).size, 4);
  for (const name of [
    manifest.background.service_worker, manifest.action.default_popup,
    "clipboard.js", "image-analysis.js", "offscreen.html", "offscreen.js"
  ]) {
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

test("viewport and tile clips cover the content without gaps", () => {
  const content = { x: -5, y: 10, width: 1200, height: 1700, scale: 1 };
  const viewport = viewportFor({ cssVisualViewport: { clientWidth: 800.8, clientHeight: 700.9 } }, content);
  assert.deepEqual(viewport, { width: 800, height: 700 });
  assert.deepEqual(tileClips(content, viewport), [
    { x: 0, y: 0, width: 800, height: 700, clip: { x: -5, y: 10, width: 800, height: 700, scale: 1 } },
    { x: 800, y: 0, width: 400, height: 700, clip: { x: 795, y: 10, width: 400, height: 700, scale: 1 } },
    { x: 0, y: 700, width: 800, height: 700, clip: { x: -5, y: 710, width: 800, height: 700, scale: 1 } },
    { x: 800, y: 700, width: 400, height: 700, clip: { x: 795, y: 710, width: 400, height: 700, scale: 1 } },
    { x: 0, y: 1400, width: 800, height: 300, clip: { x: -5, y: 1410, width: 800, height: 300, scale: 1 } },
    { x: 800, y: 1400, width: 400, height: 300, clip: { x: 795, y: 1410, width: 400, height: 300, scale: 1 } }
  ]);
  assert.equal(viewportFor({}, content), null);
});

test("fallback captures seam content inside an overlapping viewport", () => {
  const clips = overlappingTileClips(
    { x: 0, y: 0, width: 1520, height: 1526, scale: 1 },
    { width: 1520, height: 791 }
  );
  assert.deepEqual(clips.map(({ y, height, captureY }) => ({ y, height, captureY })), [
    { y: 0, height: 791, captureY: 0 },
    { y: 791, height: 594, captureY: 594 },
    { y: 1385, height: 141, captureY: 735 }
  ]);
});

test("repeated full-page output falls back to viewport-sized tiles", async () => {
  const f = fixture();
  let captures = 0;
  let position = { x: 0, y: 120 };
  f.api.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target, params]);
    if (method === "Emulation.setDeviceMetricsOverride") throw new Error("unavailable");
    if (method === "Page.getLayoutMetrics") {
      return {
        cssContentSize: { x: 0, y: 0, width: 1200, height: 1700 },
        cssVisualViewport: { clientWidth: 1200, clientHeight: 700 }
      };
    }
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("window.scrollTo")) {
        const match = params.expression.match(/left: ([\d.]+), top: ([\d.]+)/);
        position = { x: Number(match[1]), y: Math.min(Number(match[2]), 1000) };
      }
      return { result: { value: position } };
    }
    captures += 1;
    return { data: `CAPTURE-${captures}` };
  };
  let fallbackNotified = false;
  const processor = {
    hasRepeatedViewport: async (dataUrl, dimensions) => {
      assert.equal(dataUrl, "data:image/png;base64,CAPTURE-1");
      assert.deepEqual(dimensions, { contentHeight: 1700, viewportHeight: 700 });
      return true;
    },
    onFallback: async () => { fallbackNotified = true; },
    stitch: async (tiles, dimensions) => {
      assert.deepEqual(dimensions, { width: 1200, height: 1700 });
      assert.deepEqual(tiles.map(({ y, height, dataUrl }) => ({ y, height, dataUrl })), [
        { y: 0, height: 700, dataUrl: "data:image/png;base64,CAPTURE-2" },
        { y: 700, height: 525, dataUrl: "data:image/png;base64,CAPTURE-3" },
        { y: 1225, height: 475, dataUrl: "data:image/png;base64,CAPTURE-4" }
      ]);
      assert.deepEqual(tiles.map(({ sourceY, viewportHeight }) => ({ sourceY, viewportHeight })), [
        { sourceY: 0, viewportHeight: 700 },
        { sourceY: 175, viewportHeight: 700 },
        { sourceY: 225, viewportHeight: 700 }
      ]);
      return "data:image/png;base64,STITCHED";
    }
  };
  assert.equal(await captureFullPage(f.api, 42, processor), "data:image/png;base64,STITCHED");
  assert.equal(fallbackNotified, true);
  assert.equal(f.calls.filter(([name]) => name === "Page.captureScreenshot").length, 4);
  assert.ok(f.calls.filter(([name, , params]) => name === "Page.captureScreenshot" && params.captureBeyondViewport === false).length === 3);
  assert.deepEqual(position, { x: 0, y: 120 });
  assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
});

test("fallback reports an unscrollable page instead of stitching repeated captures", async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target, params]);
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width: 800, height: 1800 },
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 }
    };
    if (method === "Runtime.evaluate") return { result: { value: { x: 0, y: 0 } } };
    return { data: "CAPTURE" };
  };
  const processor = { hasRepeatedViewport: async () => true, stitch: async () => assert.fail("must not stitch") };
  await assert.rejects(captureFullPage(f.api, 42, processor), /スクロールできませんでした/);
  assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
});

test("fallback recaptures a tile when scroll anchoring moves the page during capture", async () => {
  const f = fixture();
  let position = { x: 0, y: 0 };
  let captures = 0;
  f.api.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target, params]);
    if (method === "Emulation.setDeviceMetricsOverride") throw new Error("unavailable");
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width: 800, height: 1700 },
      cssVisualViewport: { clientWidth: 800, clientHeight: 700 }
    };
    if (method === "Runtime.evaluate") {
      const match = params.expression.match(/left: ([\d.]+), top: ([\d.]+)/);
      if (match) position = { x: Number(match[1]), y: Math.min(Number(match[2]), 1000) };
      return { result: { value: position } };
    }
    captures++;
    if (captures === 3) position = { x: 0, y: position.y + 10 };
    return { data: `CAPTURE-${captures}` };
  };
  const processor = {
    hasRepeatedViewport: async () => true,
    stitch: async (tiles) => {
      assert.equal(tiles[1].dataUrl, "data:image/png;base64,CAPTURE-4");
      assert.equal(tiles[1].sourceY, 165);
      return "data:image/png;base64,STITCHED";
    }
  };
  assert.equal(await captureFullPage(f.api, 42, processor), "data:image/png;base64,STITCHED");
  assert.equal(captures, 5);
});

test("expanded viewport captures a short page without a seam even when repetition is absent", async () => {
  const f = fixture();
  let expanded = false;
  let captures = 0;
  const pngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
  pngHeader.writeUInt32BE(800, 16);
  pngHeader.writeUInt32BE(1500, 20);
  const completePng = pngHeader.toString("base64");
  f.api.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target, params]);
    if (method === "Emulation.setDeviceMetricsOverride") { expanded = true; return {}; }
    if (method === "Emulation.clearDeviceMetricsOverride") { expanded = false; return {}; }
    if (method === "Runtime.evaluate") return { result: { value: params.expression.includes("setTimeout") ? true : { x: 0, y: 100 } } };
    if (method === "Page.getLayoutMetrics") return {
      cssContentSize: { x: 0, y: 0, width: 800, height: 1500 },
      cssVisualViewport: { clientWidth: 800, clientHeight: expanded ? 1500 : 800 }
    };
    captures++;
    return { data: captures === 1 ? "REPEATED" : completePng };
  };
  let analyses = 0;
  const processor = {
    hasRepeatedViewport: async () => { analyses++; return false; },
    stitch: async () => assert.fail("expanded capture should not stitch")
  };
  assert.equal(await captureFullPage(f.api, 42, processor), `data:image/png;base64,${completePng}`);
  assert.equal(captures, 2);
  assert.equal(analyses, 2);
  assert.equal(expanded, false);
  assert.equal(f.calls.filter(([name]) => name === "Emulation.clearDeviceMetricsOverride").length, 1);
  assert.deepEqual(f.calls.filter(([name]) => name === "Page.captureScreenshot")[1][2], {
    format: "png", fromSurface: true, captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 800, height: 1500, scale: 1 }
  });
});

test("image analysis failure is reported instead of accepting a potentially repeated capture", async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target, params]);
    return method === "Page.getLayoutMetrics"
      ? {
          cssContentSize: { x: 0, y: 0, width: 1200, height: 1700 },
          cssVisualViewport: { clientWidth: 1200, clientHeight: 700 }
        }
      : { data: "FULL" };
  };
  const processor = {
    hasRepeatedViewport: async () => { throw new Error("analysis unavailable"); },
    stitch: async () => assert.fail("must not stitch")
  };
  await assert.rejects(captureFullPage(f.api, 42, processor), /analysis unavailable/);
  assert.equal(f.calls.filter(([name]) => name === "Page.captureScreenshot").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "detach").length, 1);
});

test("repetition sampling uses only the available part of a final partial viewport", () => {
  assert.deepEqual(repetitionBands(1908, 989, 1908), { offset: 989, height: 919 });
  assert.deepEqual(repetitionBands(1908, 987, 1908, 2), { offset: 989, height: 919 });
  assert.deepEqual(repetitionBands(3500, 900, 3500), { offset: 900, height: 900 });
  assert.equal(repetitionBands(1500, 900, 1500), null);
});

test("image repetition detection tolerates tiny pixel noise but rejects different bands", () => {
  const first = new Uint8ClampedArray(400).fill(100);
  const almostSame = new Uint8ClampedArray(first);
  almostSame[0] = 106;
  assert.equal(bandsAreRepeated(first, almostSame), true);

  const different = new Uint8ClampedArray(first);
  for (let index = 0; index < different.length; index += 8) different[index] = 180;
  assert.equal(bandsAreRepeated(first, different), false);
  assert.equal(bandsAreRepeated(first, new Uint8ClampedArray(4)), false);
});

test("clipboard destination copies the PNG without starting a download", async () => {
  const f = fixture();
  let copiedTab;
  const run = createCaptureService(
    f.api,
    async (status) => { f.statuses.push(status); },
    () => Date.now(),
    async (dataUrl, tab) => { f.copies.push(dataUrl); copiedTab = tab; }
  );
  const result = await run("viewport", f.tab, "clipboard");
  assert.deepEqual(result, { ok: true, destination: "clipboard" });
  assert.deepEqual(f.copies, ["data:image/png;base64,VIEW"]);
  assert.equal(copiedTab, f.tab);
  assert.ok(!f.calls.some(([name]) => name === "download"));
  assert.equal(f.statuses.at(-1).state, "copied");
});

test("clipboard output writes one PNG ClipboardItem", async () => {
  const blob = { type: "image/png" };
  const writes = [];
  class FakeClipboardItem {
    constructor(data) { this.data = data; }
  }
  const result = await copyPngToClipboard("data:image/png;base64,VIEW", {
    fetcher: async (url) => {
      assert.equal(url, "data:image/png;base64,VIEW");
      return { blob: async () => blob };
    },
    clipboard: { write: async (items) => { writes.push(items); } },
    ClipboardItemCtor: FakeClipboardItem,
    skipFocusCheck: true
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  assert.equal(writes[0][0].data["image/png"], blob);
});

test("clipboard output rejects non-PNG data", async () => {
  const result = await copyPngToClipboard("bad", {
    fetcher: async () => ({ blob: async () => ({ type: "text/plain" }) }),
    clipboard: { write: async () => assert.fail("must not write") },
    ClipboardItemCtor: class {},
    skipFocusCheck: true
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /PNGではありません/);
});

test("document title is copied as plain text", async () => {
  const writes = [];
  const result = await copyDocumentTitleToClipboard({
    document: { title: "PageShot キャプチャ確認ページ", hasFocus: () => true },
    clipboard: { writeText: async (text) => { writes.push(text); } },
    skipFocusCheck: true
  });
  assert.deepEqual(result, { ok: true, title: "PageShot キャプチャ確認ページ" });
  assert.deepEqual(writes, ["PageShot キャプチャ確認ページ"]);
});

test("missing document title is reported without writing to the clipboard", async () => {
  const result = await copyDocumentTitleToClipboard({
    document: { title: "", hasFocus: () => true },
    clipboard: { writeText: async () => assert.fail("must not write") },
    skipFocusCheck: true
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /タイトルがありません/);
});

test("clipboard failures are reported and do not fall back to downloading", async () => {
  const f = fixture();
  const run = createCaptureService(
    f.api,
    async (status) => { f.statuses.push(status); },
    () => Date.now(),
    async () => { throw new Error("Clipboard write failed"); }
  );
  const result = await run("fullpage", f.tab, "clipboard");
  assert.equal(result.ok, false);
  assert.match(result.error, /クリップボードにコピーできませんでした/);
  assert.ok(!f.calls.some(([name]) => name === "download"));
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
  assert.equal((await f.run("viewport", f.tab, "other")).ok, false);
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
