import { bandsAreRepeated } from "./image-analysis.js";

async function loadImage(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.type !== "image/png") throw new Error("撮影結果がPNGではありません。");
  return await createImageBitmap(blob);
}

async function detectRepetition(dataUrl, dimensions) {
  const image = await loadImage(dataUrl);
  try {
    const bandHeight = Math.round(dimensions.viewportHeight * image.height / dimensions.contentHeight);
    if (bandHeight <= 0 || image.height < bandHeight * 1.8) return false;

    const sampleWidth = 96;
    const sampleHeight = 64;
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, image.width, bandHeight, 0, 0, sampleWidth, sampleHeight);
    const first = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    context.clearRect(0, 0, sampleWidth, sampleHeight);
    context.drawImage(image, 0, bandHeight, image.width, bandHeight, 0, 0, sampleWidth, sampleHeight);
    const second = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    return bandsAreRepeated(first, second);
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
      context.drawImage(image, tile.x, tile.y, tile.width, tile.height);
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
