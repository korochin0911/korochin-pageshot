import { fittedSize, frameName, nextFrameAt, sequenceOptions } from "./sequence.js";
import { makeZip } from "./zip.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeSession;
const archives = new Set();

export function stopSequence() {
  if (activeSession) activeSession.stopped = true;
}

export function releaseSequence(url) {
  if (archives.delete(url)) URL.revokeObjectURL(url);
}

async function report(state, message) {
  await chrome.runtime.sendMessage({ target: "sequence-status", status: { state, mode: "sequence", message } });
}

async function encode(canvas, format) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, `image/${format}`, 0.82));
  if (!blob || blob.type !== `image/${format}`) throw new Error(`${format.toUpperCase()}に変換できませんでした。`);
  return blob;
}

async function contactSheets(frames) {
  const sheets = [];
  const cellWidth = 480, pictureHeight = 300, labelHeight = 28;
  for (let start = 0; start < frames.length; start += 10) {
    const batch = frames.slice(start, start + 10);
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * 2;
    canvas.height = Math.ceil(batch.length / 2) * (pictureHeight + labelHeight);
    const context = canvas.getContext("2d");
    context.fillStyle = "#f1f4f2";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < batch.length; index++) {
      const frame = batch[index];
      const image = await createImageBitmap(frame.blob);
      try {
        const x = (index % 2) * cellWidth, y = Math.floor(index / 2) * (pictureHeight + labelHeight);
        const size = fittedSize(image.width, image.height, cellWidth - 8, pictureHeight - 8);
        context.drawImage(image, x + (cellWidth - size.width) / 2, y + (pictureHeight - size.height) / 2, size.width, size.height);
        context.fillStyle = "#182e24";
        context.font = "16px sans-serif";
        context.fillText(`#${String(start + index + 1).padStart(4, "0")}   ${(frame.elapsedMs / 1000).toFixed(3)} s`, x + 10, y + pictureHeight + 19);
      } finally { image.close(); }
    }
    sheets.push({ name: `sheets/sheet-${String(sheets.length + 1).padStart(3, "0")}.png`, blob: await encode(canvas, "png") });
  }
  return sheets;
}

export async function recordSequence(streamId, input, page) {
  if (activeSession) throw new Error("連続撮影はすでに実行中です。");
  const options = sequenceOptions(input);
  const session = { stopped: false };
  activeSession = session;
  let stream, video, readyTimer;
  try {
    // Consume the stream ID immediately, before the countdown (IDs are short-lived).
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
    });
    const track = stream.getVideoTracks()[0];
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.append(video);
    await Promise.race([
      video.play(),
      new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error("タブの映像を開始できませんでした。")), 8000); })
    ]);
    clearTimeout(readyTimer);
    for (let seconds = 2; seconds > 0 && !session.stopped; seconds--) {
      await report("countdown", `${seconds}秒後に連続撮影を開始します。ページを操作できます。`);
      for (let tick = 0; tick < 10 && !session.stopped; tick++) await wait(100);
    }
    if (session.stopped) return { cancelled: true };
    if (track.readyState === "ended") throw new Error("タブの共有が終了しました。");
    const size = fittedSize(video.videoWidth, video.videoHeight, options.maxWidth);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    const frames = [];
    let totalBytes = 0, lastReport = -1, nextAt = 0;
    await report("recording", `連続撮影中：0 / ${options.seconds}秒`);
    const startedAt = new Date().toISOString(), start = performance.now();
    const durationMs = options.seconds * 1000;
    while (!session.stopped && track.readyState !== "ended") {
      const elapsed = performance.now() - start;
      if (elapsed >= durationMs) break;
      if (elapsed < nextAt) { await wait(Math.min(50, nextAt - elapsed)); continue; }
      if (video.readyState < 2) { await wait(20); continue; }
      // Preserve aspect ratio if the user resizes the source tab during capture.
      const fit = fittedSize(video.videoWidth, video.videoHeight, size.width, size.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      context.drawImage(video, (size.width - fit.width) / 2, (size.height - fit.height) / 2, fit.width, fit.height);
      const blob = await encode(canvas, options.format);
      totalBytes += blob.size;
      if (totalBytes > 128 * 1024 * 1024) throw new Error("画像が128MBを超えました。時間・画像サイズを小さくして再試行してください。");
      frames.push({ name: frameName(frames.length, elapsedMs, options.format), blob, elapsedMs });
      const second = Math.floor(elapsedMs / 1000);
      if (second !== lastReport) {
        lastReport = second;
        await report("recording", `連続撮影中：${second} / ${options.seconds}秒（${frames.length}コマ）`);
      }
      nextAt = nextFrameAt(performance.now() - start, options.fps);
    }
    const durationActualMs = Math.round(performance.now() - start);
    const stopReason = session.stopped ? "user" : track.readyState === "ended" ? "stream-ended" : "duration";
    stream.getTracks().forEach((item) => item.stop());
    video.pause();
    video.srcObject = null;
    if (!frames.length) throw new Error("画像を取得できませんでした。タブを表示して再試行してください。");
    await report("packaging", `${frames.length}コマの一覧画像とZIPを作成しています…`);
    const sheets = await contactSheets(frames);
    const metadata = {
      schemaVersion: 1, app: "Korochin PageShot", startedAt, page,
      ...options, width: size.width, height: size.height, durationActualMs, stopReason,
      frameCount: frames.length,
      timing: "elapsedMs is the actual sampling time after capture began, not a guaranteed source-frame presentation time. Identical frames are retained. No audio.",
      frames: frames.map(({ name, elapsedMs }) => ({ file: name, elapsedMs })),
      sheets: sheets.map(({ name }) => name)
    };
    const zip = await makeZip([
      ...frames.map(({ name, blob }) => ({ name, blob })), ...sheets,
      { name: "manifest.json", blob: JSON.stringify(metadata, null, 2) },
      { name: "README.txt", blob: "PageShot 連続撮影\nまず sheets/ の時刻付き一覧画像を見て、細部は frames/ の連番画像で確認してください。\nmanifest.json の elapsedMs は撮影開始から実際に画像を切り出した時刻です。10fps等は目標値で、負荷による間引き・同一画像の繰り返しがあり得ます。音声は含みません。\n" }
    ]);
    const url = URL.createObjectURL(zip);
    archives.add(url);
    return { url, frameCount: frames.length, stopReason };
  } finally {
    clearTimeout(readyTimer);
    stream?.getTracks().forEach((track) => track.stop());
    if (video) { video.pause(); video.srcObject = null; video.remove(); }
    activeSession = undefined;
  }
}
