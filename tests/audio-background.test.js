import test from "node:test";
import assert from "node:assert/strict";

test("a restarted worker blocks competing captures while audio records and accepts stop and completion only from trusted pages", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const calls = [], stored = {};
  let listener, recording = true;
  const runtime = {
    id: "pageshot-test",
    getURL: (file) => `chrome-extension://pageshot-test/${file}`,
    getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
    onMessage: { addListener: (callback) => { listener = callback; } },
    sendMessage: async (message) => {
      calls.push(message);
      if (message.type === "get-audio-status") return { ok: true, value: recording ? { state: "recording", mode: "audio" } : null };
      return { ok: true };
    }
  };
  const api = {
    runtime,
    commands: { onCommand: { addListener() {} } },
    downloads: {
      onChanged: { addListener() {} },
      download: async (options) => { calls.push({ type: "download", ...options }); return 7; },
      search: async () => [{ state: "in_progress" }]
    },
    storage: { session: {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (value) => Object.assign(stored, value),
      remove: async (key) => { delete stored[key]; }
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true, title: "Example" } }] },
    tabs: { query: async () => [{ id: 42 }] }
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: api });
  try {
    // A fresh import has no in-memory busy flag; the offscreen recording is
    // already running as it would be after service worker suspension.
    await import(`../background.js?audio-restart-test`);
    const popup = { id: runtime.id, url: runtime.getURL("popup.html") };
    const offscreen = { id: runtime.id, url: runtime.getURL("offscreen.html") };
    const send = (message, sender = popup) => new Promise((resolve) => {
      const accepted = listener(message, sender, resolve);
      if (accepted !== true) resolve(undefined);
    });
    for (const message of [
      { type: "capture", mode: "viewport", destination: "download" },
      { type: "copy-title" },
      { type: "sequence-start", options: {} },
      { type: "audio-start" }
    ]) {
      const response = await send(message);
      assert.equal(response.ok, false);
      assert.match(response.error, /音声録音/);
    }
    assert.ok(calls.every((call) => call.type === "get-audio-status"));
    assert.equal(await send({ type: "audio-stop" }, { id: "untrusted", url: popup.url }), undefined);
    assert.equal(await send({ type: "audio-stop" }, { id: runtime.id, url: "https://example.com/" }), undefined);
    assert.equal((await send({ type: "audio-stop" })).ok, true);
    assert.equal(calls.at(-1).type, "stop-audio");
    const result = { url: "blob:audio", startedAt: 1793424000000, stopReason: "user" };
    assert.equal(await send({ target: "audio-result", result }), undefined, "popup cannot submit arbitrary download URLs");
    assert.equal((await send({ target: "audio-result", result }, offscreen)).ok, true);
    assert.equal(stored["audioDownload-7"], "blob:audio");
    assert.equal(stored.captureStatus.state, "started");
    recording = false;
    assert.equal((await send({ type: "copy-title" })).ok, true);
  } finally {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else delete globalThis.chrome;
  }
});
