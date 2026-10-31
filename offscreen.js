import { bandsAreRepeated, repetitionBands, repetitionOffsets } from "./image-analysis.js";
import { recordSequence, releaseSequence, stopSequence } from "./sequence-recorder.js";
import { createAudioRecorder } from "./audio-recorder.js";

const audio = createAudioRecorder({
  report: (status) => chrome.runtime.sendMessage({ target: "audio-status", status }),
  onResult: (result) => chrome.runtime.sendMessage({ target: "audio-result", result })
});

async function loadImage(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.type !== "image/png") throw new Error("撮影結果がPNGではありません。");
  return await createImageBitmap(blob);
}

async function detectRepetition(dataUrl, dimensions) {
  const image = await loadImage(dataUrl);
  try {
    const sampleWidth = 96;
    const sampleHeight = 64;
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    // Chromium can paint a screenshot in viewport-sized repeats even when the
    // reported visual viewport differs from the painted viewport height.
    const probeHeight = Math.min(512, Math.floor(image.height / 3));
    context.drawImage(image, 0, 0, image.width, probeHeight, 0, 0, sampleWidth, sampleHeight);
    const firstProbe = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    for (const offset of repetitionOffsets(image.height, dimensions.viewportHeight, dimensions.contentHeight)) {
      context.clearRect(0, 0, sampleWidth, sampleHeight);
      context.drawImage(image, 0, offset, image.width, probeHeight, 0, 0, sampleWidth, sampleHeight);
      const secondProbe = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      if (!bandsAreRepeated(firstProbe, secondProbe)) continue;
      const bands = repetitionBands(image.height, dimensions.viewportHeight, dimensions.contentHeight,
        offset - Math.round(dimensions.viewportHeight * image.height / dimensions.contentHeight));
      if (!bands) continue;
      context.clearRect(0, 0, sampleWidth, sampleHeight);
      context.drawImage(image, 0, 0, image.width, bands.height, 0, 0, sampleWidth, sampleHeight);
      const first = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      context.clearRect(0, 0, sampleWidth, sampleHeight);
      context.drawImage(image, 0, bands.offset, image.width, bands.height, 0, 0, sampleWidth, sampleHeight);
      const second = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      if (bandsAreRepeated(first, second)) return true;
    }
    return false;
  } finally {
    image.close();
  }
}

async function stitchTiles(tiles, dimensions) {
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  if (canvas.width !== dimensions.width || canvas.height !== dimensions.height) {
    throw new Error("ページが大きすぎるため分割画像を結合できませんでした。");
  }
  const context = canvas.getContext("2d");

  for (const tile of tiles) {
    const image = await loadImage(tile.dataUrl);
    try {
      const scaleX = image.width / tile.viewportWidth;
      const scaleY = image.height / tile.viewportHeight;
      context.drawImage(
        image,
        tile.sourceX * scaleX, tile.sourceY * scaleY,
        tile.width * scaleX, tile.height * scaleY,
        tile.x, tile.y, tile.width, tile.height
      );
    } finally {
      image.close();
    }
  }

  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("分割画像をPNGに変換できませんでした。");
  }
  return dataUrl;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "image-processor") return;

  if (["prepare-audio", "get-audio-status", "stop-audio", "release-audio"].includes(message.type)) {
    if (message.type === "stop-audio") audio.stop();
    if (message.type === "release-audio") audio.release(message.url);
    sendResponse({ ok: true, value: audio.status() });
    return;
  }
  if (message.type === "start-audio") {
    audio.start(message.streamId, message.page).then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  if (["prepare-sequence", "stop-sequence", "release-sequence"].includes(message.type)) {
    if (message.type === "stop-sequence") stopSequence();
    if (message.type === "release-sequence") releaseSequence(message.url);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "record-sequence") {
    recordSequence(message.streamId, message.options, message.page).then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  const operation = message.type === "detect-repetition"
    ? detectRepetition(message.dataUrl, message.dimensions)
    : message.type === "stitch-tiles"
      ? stitchTiles(message.tiles, message.dimensions)
      : Promise.reject(new Error("不明な画像処理です。"));

  operation.then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true;
});
