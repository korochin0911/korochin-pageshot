export const MAX_AUDIO_DURATION_MS = 60 * 60 * 1000;
export const MAX_AUDIO_BYTES = 128 * 1024 * 1024;

// The offscreen document owns the stream, so closing the popup or suspending
// the service worker does not interrupt a recording.
export function createAudioRecorder({ report, onResult }, env = globalThis) {
  let active;
  const recordings = new Set();

  function status() { return active?.status ?? null; }

  function release(url) {
    if (recordings.delete(url)) env.URL.revokeObjectURL(url);
  }

  function cleanup(session) {
    env.clearTimeout(session.timer);
    session.stream?.getTracks().forEach((track) => track.stop());
    session.source?.disconnect();
    if (session.output) void session.output.close().catch(() => {});
  }

  function stop(reason = "user", session = active) {
    if (!session || active !== session || session.status.state !== "recording") return false;
    session.stopReason = reason;
    session.status = { ...session.status, state: "packaging", message: "録音を停止して音声を保存しています…" };
    // On an encoder error (or when all tracks end), the browser may already
    // have made the recorder inactive before delivering its final data/stop.
    if (session.recorder.state !== "inactive") session.recorder.stop();
    return true;
  }

  async function finish(session) {
    if (session.finishing || active !== session) return;
    session.finishing = true;
    cleanup(session);
    session.status = { ...session.status, state: "packaging", message: "録音した音声を保存しています…" };
    try {
      await report(session.status);
      const blob = new env.Blob(session.chunks, { type: session.recorder.mimeType });
      session.chunks.length = 0;
      if (!blob.size) throw new Error(session.error || "音声データを取得できませんでした。");
      const url = env.URL.createObjectURL(blob);
      recordings.add(url);
      await onResult({ url, startedAt: session.startedAt, stopReason: session.stopReason, warning: session.error });
    } catch (error) {
      await report({ state: "error", mode: "audio", message: `音声を保存できませんでした。\n${error?.message || String(error)}` }).catch(() => {});
    } finally {
      if (active === session) active = undefined;
    }
  }

  async function start(streamId, page = {}) {
    if (active) throw new Error("音声録音はすでに実行中です。");
    const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => env.MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("このブラウザはWebM音声の録音に対応していません。");
    const session = { chunks: [], bytes: 0, status: { state: "preparing", mode: "audio", message: "音声録音を準備しています…" } };
    active = session;
    try {
      session.stream = await env.navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: false
      });
      const tracks = session.stream.getAudioTracks();
      if (!tracks.length || tracks.some((track) => track.readyState === "ended")) throw new Error("タブの音声を取得できませんでした。");
      // tabCapture redirects tab audio. Route it back to the speakers as well
      // as recording it, otherwise the tab becomes inaudible during capture.
      session.output = new env.AudioContext();
      session.source = session.output.createMediaStreamSource(session.stream);
      session.source.connect(session.output.destination);
      await session.output.resume();
      if (session.output.state !== "running") throw new Error("録音中の音声再生を開始できませんでした。");
      const recorder = session.recorder = new env.MediaRecorder(session.stream, { mimeType, audioBitsPerSecond: 128000 });
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (data.size > 0) { session.chunks.push(data); session.bytes += data.size; }
        if (session.bytes >= MAX_AUDIO_BYTES) stop("size-limit", session);
      });
      recorder.addEventListener("error", (event) => {
        session.error = event.error?.message || "音声エンコーダーでエラーが発生しました。";
        stop("recorder-error", session);
      });
      recorder.addEventListener("stop", () => { void finish(session); });
      tracks.forEach((track) => track.addEventListener("ended", () => stop("stream-ended", session)));
      recorder.start(1000);
      session.startedAt = env.Date.now();
      session.status = {
        state: "recording", mode: "audio", startedAt: session.startedAt,
        message: `音声を録音中です。停止するとWebMに保存します。${page.title ? `\n${page.title}` : ""}`
      };
      session.timer = env.setTimeout(() => stop("duration-limit", session), MAX_AUDIO_DURATION_MS);
      await report(session.status);
      return session.status;
    } catch (error) {
      // Ignore a stop event generated while unwinding a failed start.
      if (active === session) active = undefined;
      if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
      cleanup(session);
      throw error;
    }
  }

  return { start, stop, status, release };
}
