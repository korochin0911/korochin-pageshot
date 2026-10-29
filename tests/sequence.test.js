import test from "node:test";
import assert from "node:assert/strict";
import { createExclusiveRunner, fittedSize, frameName, nextFrameAt, sequenceOptions } from "../sequence.js";
import { createSequenceService } from "../sequence-service.js";
import { crc32, makeZip } from "../zip.js";
import { recordSequence, releaseSequence, stopSequence } from "../sequence-recorder.js";

async function unzipStored(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const data = bytes.slice(start, start + size);
    assert.equal(crc32(data), view.getUint32(offset + 14, true));
    entries.set(name, data);
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), entries.size);
  assert.equal(view.getUint32(bytes.length - 6, true), offset);
  return entries;
}

test("options are bounded, aspect ratio is retained and late frames skip slots", () => {
  assert.deepEqual(sequenceOptions(), { seconds: 3, fps: 10, format: "webp", maxWidth: 1280 });
  for (const input of [{ seconds: 0 }, { seconds: 11 }, { fps: 60 }, { seconds: "3" }, { format: "gif" }, { maxWidth: Infinity }]) {
    assert.throws(() => sequenceOptions(input));
  }
  assert.deepEqual(fittedSize(3840, 2160, 1280), { width: 1280, height: 720 });
  assert.deepEqual(fittedSize(1000, 6000, 1280), { width: 320, height: 1920 });
  assert.deepEqual(fittedSize(320, 200, 1280), { width: 320, height: 200 });
  assert.equal(nextFrameAt(370, 10), 400);
  assert.equal(nextFrameAt(100, 10), 200);
  assert.equal(frameName(4, 401.4, "webp"), "frames/frame-0005-000401ms.webp");
});

test("ZIP holds binary images and UTF-8 metadata with valid checksums and central directory", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const zip = await makeZip([
    { name: "frames/a.webp", blob: new Uint8Array([0, 1, 255]) },
    { name: "manifest.json", blob: '{"title":"日本語"}' }
  ]);
  const entries = await unzipStored(zip);
  assert.deepEqual(entries.get("frames/a.webp"), new Uint8Array([0, 1, 255]));
  assert.equal(new TextDecoder().decode(entries.get("manifest.json")), '{"title":"日本語"}');
  await assert.rejects(makeZip([{ name: "../bad", blob: "x" }]));
});

test("capture lock excludes other operations and releases after an exception", async () => {
  const run = createExclusiveRunner();
  let unblock;
  const first = run(() => new Promise((resolve) => { unblock = resolve; }));
  assert.equal((await run(() => assert.fail("must not execute"))).ok, false);
  unblock("done");
  assert.equal(await first, "done");
  await assert.rejects(run(() => { throw new Error("failure"); }));
  assert.equal(await run(() => 42), 42);
});

function serviceFixture({ cancel = false, failDownload = false, downloadState = "in_progress" } = {}) {
  const data = {}, statuses = [], calls = [];
  const api = {
    tabs: { query: async () => [{ id: 42, title: "Example", url: "https://example.com/" }] },
    tabCapture: { getMediaStreamId: async (params) => { calls.push(["stream", params]); return "stream-42"; } },
    downloads: {
      download: async (params) => { calls.push(["download", params]); if (failDownload) throw new Error("disk"); return 7; },
      search: async () => [{ state: downloadState }]
    },
    storage: { session: {
      get: async (key) => ({ [key]: data[key] }),
      set: async (value) => Object.assign(data, value),
      remove: async (key) => { delete data[key]; }
    } }
  };
  const process = async (type, payload) => {
    calls.push([type, payload]);
    if (type === "record-sequence") return cancel ? { cancelled: true } : { url: "blob:archive", frameCount: 30, stopReason: "duration" };
  };
  const service = createSequenceService(api, async (status) => statuses.push(status), process);
  return { service, data, statuses, calls };
}

test("stream is bound to the selected tab; archive lives until download ends", async () => {
  const f = serviceFixture();
  assert.equal((await f.service.run({})).ok, true);
  assert.deepEqual(f.calls.find(([type]) => type === "stream")[1], { targetTabId: 42 });
  assert.ok(f.calls.findIndex(([type]) => type === "prepare-sequence") < f.calls.findIndex(([type]) => type === "stream"));
  assert.match(f.calls.find(([type]) => type === "download")[1].filename, /^screenshots\/screenshot-sequence-.*\.zip$/);
  assert.equal(f.data["sequenceDownload-7"], "blob:archive");
  assert.ok(!f.calls.some(([type]) => type === "release-sequence"));
  await f.service.releaseDownload(7);
  assert.equal(f.data["sequenceDownload-7"], undefined);
  assert.deepEqual(f.calls.at(-1), ["release-sequence", { url: "blob:archive" }]);
});

test("download race and download errors release URLs; countdown cancellation saves nothing", async () => {
  const fast = serviceFixture({ downloadState: "complete" });
  await fast.service.run({});
  assert.equal(fast.data["sequenceDownload-7"], undefined);
  const failed = serviceFixture({ failDownload: true });
  assert.equal((await failed.service.run({})).ok, false);
  assert.equal(failed.statuses.at(-1).state, "error");
  assert.ok(failed.calls.some(([type]) => type === "release-sequence"));
  const cancelled = serviceFixture({ cancel: true });
  assert.equal((await cancelled.service.run({})).cancelled, true);
  assert.ok(!cancelled.calls.some(([type]) => type === "download"));
});

async function recorderFixture(run, { encodingMs = 5, onStatus = () => {}, encodeFailure = false } = {}) {
  let now = 0, stopped = 0, removed = false;
  const statuses = [], labels = [];
  const track = { readyState: "live", stop() { stopped++; this.readyState = "ended"; } };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4, play: async () => {}, pause() {}, remove() { removed = true; } };
  const original = new Map();
  const replace = (name, value) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const timer = globalThis.setTimeout;
  replace("performance", { now: () => now });
  replace("setTimeout", (callback, ms) => {
    if (ms > 1000) return timer(callback, ms);
    now += ms;
    queueMicrotask(callback);
    return 0;
  });
  replace("navigator", { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } });
  replace("document", {
    body: { append() {} },
    createElement: (tag) => tag === "video" ? video : {
      getContext: () => ({ fillRect() {}, drawImage() {}, fillText: (text) => labels.push(text) }),
      toBlob: (callback, type) => { now += encodingMs; callback(encodeFailure ? null : new Blob(["image"], { type })); }
    }
  });
  replace("createImageBitmap", async () => ({ width: 1280, height: 720, close() {} }));
  replace("chrome", { runtime: { sendMessage: async ({ status }) => { statuses.push(status); onStatus(status); } } });
  try { await run({ statuses, labels }); }
  finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    assert.ok(stopped > 0, "capture track must be stopped on all paths");
    assert.ok(removed, "video element must be removed");
  }
}

test("3-second capture produces 30 ordered frames, 3 labelled sheets and real timestamps", async () => {
  await recorderFixture(async ({ labels }) => {
    const result = await recordSequence("stream", {}, { title: "test" });
    try {
      const entries = await unzipStored(await (await fetch(result.url)).blob());
      const metadata = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
      assert.equal(result.frameCount, 30);
      assert.equal(metadata.sheets.length, 3);
      assert.equal(metadata.frames[0].elapsedMs, 0);
      assert.equal(metadata.frames.at(-1).elapsedMs, 2900);
      assert.equal(metadata.width, 1280);
      assert.equal(metadata.height, 720);
      assert.equal(labels.length, 30);
      assert.match(labels[10], /#0011.*1\.000 s/);
    } finally { releaseSequence(result.url); }
  });
});

test("slow encoder skips missed slots rather than faking 10fps", async () => {
  await recorderFixture(async () => {
    const result = await recordSequence("stream", { seconds: 1 }, {});
    try {
      const entries = await unzipStored(await (await fetch(result.url)).blob());
      const metadata = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
      assert.deepEqual(metadata.frames.map((frame) => frame.elapsedMs), [0, 200, 400, 600, 800]);
    } finally { releaseSequence(result.url); }
  }, { encodingMs: 130 });
});

test("cancel during countdown stops capture without creating an archive", async () => {
  await recorderFixture(async () => {
    assert.deepEqual(await recordSequence("stream", {}, {}), { cancelled: true });
  }, { onStatus: (status) => { if (status.state === "countdown") stopSequence(); } });
});

test("stop during recording saves a partial archive; failed encoding releases capture", async () => {
  await recorderFixture(async () => {
    const result = await recordSequence("stream", {}, {});
    assert.equal(result.stopReason, "user");
    assert.equal(result.frameCount, 1);
    releaseSequence(result.url);
  }, { onStatus: (status) => { if (status.state === "recording" && status.message.includes("コマ")) stopSequence(); } });
  await recorderFixture(async () => {
    await assert.rejects(recordSequence("stream", {}, {}), /変換/);
  }, { encodeFailure: true });
});
