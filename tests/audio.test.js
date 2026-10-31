import test from "node:test";
import assert from "node:assert/strict";
import { createAudioRecorder, MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS } from "../audio-recorder.js";
import { createAudioService } from "../audio-service.js";

function recorderFixture({ failMedia = false, failResume = false, failStart = false, supported = true } = {}) {
  const statuses = [], results = [], requests = [], timers = new Map(), urls = new Map(), revoked = [];
  let recorder, connected = false, disconnected = false, closed = false, stopped = false;
  const track = new EventTarget();
  track.readyState = "live";
  track.stop = () => { stopped = true; track.readyState = "ended"; };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class Recorder extends EventTarget {
    static isTypeSupported() { return supported; }
    constructor(input, options) {
      super();
      assert.equal(input, stream);
      assert.equal(options.audioBitsPerSecond, 128000);
      this.mimeType = options.mimeType;
      this.state = "inactive";
      recorder = this;
    }
    start(timeslice) {
      assert.equal(timeslice, 1000);
      if (failStart) throw new Error("encoder-start");
      this.state = "recording";
    }
    chunk(data) {
      const event = new Event("dataavailable");
      event.data = data;
      this.dispatchEvent(event);
    }
    stop() {
      assert.equal(this.state, "recording", "stop must never be called twice");
      this.state = "inactive";
      queueMicrotask(() => {
        this.chunk(new Blob(["last-chunk"]));
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  const env = {
    navigator: { mediaDevices: { getUserMedia: async (constraints) => {
      requests.push(constraints);
      if (failMedia) throw new Error("permission-denied");
      return stream;
    } } },
    MediaRecorder: Recorder,
    AudioContext: class {
      state = "suspended";
      createMediaStreamSource(input) {
        assert.equal(input, stream);
        return { connect() { connected = true; }, disconnect() { disconnected = true; } };
      }
      async resume() { if (failResume) throw new Error("audio-output"); this.state = "running"; }
      async close() { closed = true; }
    },
    Blob,
    Date: { now: () => 1793424000000 },
    URL: {
      createObjectURL(blob) { const url = `blob:audio-${urls.size}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
    },
    setTimeout(callback, ms) { timers.set(ms, callback); return ms; },
    clearTimeout(id) { timers.delete(id); }
  };
  const audio = createAudioRecorder({ report: async (status) => statuses.push(status), onResult: async (result) => results.push(result) }, env);
  return {
    audio, statuses, results, requests, timers, urls, revoked, track,
    recorder: () => recorder,
    resources: () => ({ connected, disconnected, closed, stopped })
  };
}

// Flush final data, the stop event, and the asynchronous download notification.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("audio-only capture keeps playback audible and saves the final chunk exactly once", async () => {
  const f = recorderFixture();
  const status = await f.audio.start("stream-42", { title: "Music" });
  assert.equal(status.mode, "audio");
  assert.equal(status.state, "recording");
  assert.match(status.message, /Music/);
  assert.deepEqual(f.requests, [{ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: "stream-42" } }, video: false }]);
  assert.equal(f.resources().connected, true);
  await assert.rejects(f.audio.start("another"), /すでに/);
  f.recorder().chunk(new Blob(["first-chunk"]));
  assert.equal(f.audio.stop(), true);
  assert.equal(f.audio.stop(), false);
  assert.equal(f.audio.status().state, "packaging");
  await settled();
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].stopReason, "user");
  const blob = f.urls.get(f.results[0].url);
  assert.equal(await blob.text(), "first-chunklast-chunk");
  assert.equal(blob.type, "audio/webm;codecs=opus");
  assert.equal(f.audio.status(), null);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.resources(), { connected: true, disconnected: true, closed: true, stopped: true });
  assert.equal(f.urls.size, 1, "URL must survive until the download finishes");
  f.audio.release(f.results[0].url);
  f.audio.release(f.results[0].url);
  assert.equal(f.revoked.length, 1);
  f.track.readyState = "live";
  await f.audio.start("next");
  f.audio.stop();
  await settled();
});

test("closing a tab and hitting the duration or memory limit save a partial recording", async () => {
  for (const reason of ["stream-ended", "duration-limit", "size-limit"]) {
    const f = recorderFixture();
    await f.audio.start("stream");
    f.recorder().chunk(new Blob(["recorded-audio"]));
    if (reason === "stream-ended") f.track.dispatchEvent(new Event("ended"));
    if (reason === "duration-limit") f.timers.get(MAX_AUDIO_DURATION_MS)();
    if (reason === "size-limit") {
      // Report a large encoded chunk without allocating 128 MB in a test.
      f.recorder().chunk({ size: MAX_AUDIO_BYTES });
    }
    await settled();
    assert.equal(f.results[0].stopReason, reason);
    assert.equal(f.audio.status(), null);
    assert.equal(f.resources().stopped, true);
  }
});

test("an inactive recorder error still saves its final data and reports the warning", async () => {
  const f = recorderFixture();
  await f.audio.start("stream");
  f.recorder().state = "inactive";
  const error = new Event("error");
  error.error = new Error("encoder failure");
  f.recorder().dispatchEvent(error);
  f.recorder().chunk(new Blob(["partial"]));
  f.recorder().dispatchEvent(new Event("stop"));
  await settled();
  assert.equal(f.results[0].stopReason, "recorder-error");
  assert.equal(f.results[0].warning, "encoder failure");
  assert.equal(await f.urls.get(f.results[0].url).text(), "partial");
});

test("unsupported capture and failed initialization release the stream and the recording lock", async () => {
  for (const options of [{ failMedia: true }, { failResume: true }, { failStart: true }, { supported: false }]) {
    const f = recorderFixture(options);
    await assert.rejects(f.audio.start("stream"));
    assert.equal(f.audio.status(), null);
    assert.equal(f.results.length, 0);
    assert.equal(f.urls.size, 0);
    if (options.failResume || options.failStart) {
      assert.equal(f.resources().stopped, true);
      assert.equal(f.resources().closed, true);
      assert.equal(f.resources().disconnected, true);
    }
  }
});

test("an empty recording reports an error and releases resources", async () => {
  const f = recorderFixture();
  await f.audio.start("stream");
  f.recorder().state = "inactive";
  f.recorder().dispatchEvent(new Event("stop"));
  await settled();
  assert.equal(f.statuses.at(-1).state, "error");
  assert.equal(f.results.length, 0);
  assert.equal(f.audio.status(), null);
  assert.equal(f.resources().stopped, true);
});

function serviceFixture({ failDownload = false, downloadState = "in_progress", failStart = false } = {}) {
  const data = {}, statuses = [], calls = [];
  const api = {
    tabs: { query: async () => [{ id: 42, title: "Music" }] },
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
    if (failStart && type === "start-audio") throw new Error("capture rejected");
  };
  const publish = async (status) => statuses.push(status);
  return { service: createAudioService(api, publish, process), api, publish, process, data, statuses, calls };
}

const recording = { url: "blob:audio", startedAt: 1793424000000, stopReason: "user" };

test("audio capture targets the chosen tab and returns without waiting for recording to end", async () => {
  const f = serviceFixture();
  assert.equal((await f.service.start()).ok, true);
  assert.deepEqual(f.calls.map(([type]) => type), ["prepare-audio", "stream", "start-audio"]);
  assert.deepEqual(f.calls[1][1], { targetTabId: 42 });
  assert.deepEqual(f.calls[2][1], { streamId: "stream-42", page: { title: "Music" } });
  assert.ok(!f.calls.some(([type]) => type === "download"));
  const failure = serviceFixture({ failStart: true });
  assert.equal((await failure.service.start()).ok, false);
  assert.equal(failure.statuses.at(-1).state, "error");
});

test("a new worker saves the offscreen result; another worker releases its URL after download", async () => {
  const f = serviceFixture();
  await f.service.start();
  const newWorker = createAudioService(f.api, f.publish, f.process);
  const result = await newWorker.save(recording);
  assert.equal(result.ok, true);
  assert.match(result.filename, /^screenshots\/audio-\d{8}-\d{6}-\d{3}\.webm$/);
  assert.equal(f.calls.find(([type]) => type === "download")[1].conflictAction, "uniquify");
  assert.equal(f.data["audioDownload-7"], "blob:audio");
  assert.ok(!f.calls.some(([type]) => type === "release-audio"));
  await createAudioService(f.api, f.publish, f.process).releaseDownload(7);
  assert.deepEqual(f.calls.at(-1), ["release-audio", { url: "blob:audio" }]);
  assert.equal(f.data["audioDownload-7"], undefined);
});

test("fast downloads, interrupted downloads, and failed saves clean up audio URLs", async () => {
  for (const state of ["complete", "interrupted"]) {
    const f = serviceFixture({ downloadState: state });
    assert.equal((await f.service.save({ ...recording, stopReason: "stream-ended" })).ok, true);
    assert.equal(f.data["audioDownload-7"], undefined);
    assert.ok(f.calls.some(([type]) => type === "release-audio"));
    assert.match(f.statuses.at(-1).message, /共有終了/);
  }
  const f = serviceFixture({ failDownload: true });
  assert.equal((await f.service.save(recording)).ok, false);
  assert.ok(f.calls.some(([type]) => type === "release-audio"));
  assert.equal(f.statuses.at(-1).state, "error");
});
