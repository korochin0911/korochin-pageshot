export const DEFAULT_SEQUENCE_OPTIONS = Object.freeze({ seconds: 3, fps: 10, format: "webp", maxWidth: 1280 });

export function sequenceOptions(input = {}) {
  const options = { ...DEFAULT_SEQUENCE_OPTIONS, ...input };
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 10 ||
      ![2, 5, 10].includes(options.fps) || !["webp", "png"].includes(options.format) ||
      ![960, 1280, 1920].includes(options.maxWidth)) {
    throw new Error("連続撮影の設定が正しくありません。");
  }
  return { seconds: options.seconds, fps: options.fps, format: options.format, maxWidth: options.maxWidth };
}

export function fittedSize(width, height, maxWidth, maxHeight = 1920) {
  if (!(width > 0 && height > 0)) throw new Error("タブの映像サイズを取得できませんでした。");
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Advance to a future slot: delayed encoding must never create a burst of duplicate catch-up frames.
export function nextFrameAt(elapsedMs, fps) {
  return (Math.floor(elapsedMs * fps / 1000) + 1) * 1000 / fps;
}

export function frameName(index, elapsedMs, format) {
  return `frames/frame-${String(index + 1).padStart(4, "0")}-${String(Math.round(elapsedMs)).padStart(6, "0")}ms.${format}`;
}

export function createExclusiveRunner() {
  let busy = false;
  return async (operation) => {
    if (busy) return { ok: false, error: "別の撮影・コピーを処理中です。完了後に再試行してください。" };
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  };
}
