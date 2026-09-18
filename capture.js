export const MODES = new Set(["viewport", "fullpage"]);
export const DESTINATIONS = new Set(["download", "clipboard"]);

export function filenameFor(mode, now = new Date()) {
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  return `screenshots/screenshot-${mode}-${date}-${time}.png`;
}

export function clipFor(metrics) {
  const rect = metrics.cssContentSize;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0) {
    throw new Error("ページのサイズを取得できませんでした。読み込み後に再試行してください。");
  }
  return { x: rect.x, y: rect.y, width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1 };
}

export function viewportFor(metrics, contentClip) {
  const viewport = metrics.cssVisualViewport;
  const width = Math.floor(viewport?.clientWidth);
  const height = Math.floor(viewport?.clientHeight);
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    width: Math.min(width, contentClip.width),
    height: Math.min(height, contentClip.height)
  };
}

export function tileClips(contentClip, viewport) {
  const tiles = [];
  for (let y = 0; y < contentClip.height; y += viewport.height) {
    for (let x = 0; x < contentClip.width; x += viewport.width) {
      const width = Math.min(viewport.width, contentClip.width - x);
      const height = Math.min(viewport.height, contentClip.height - y);
      tiles.push({
        x,
        y,
        width,
        height,
        clip: { x: contentClip.x + x, y: contentClip.y + y, width, height, scale: 1 }
      });
    }
  }
  return tiles;
}

export function overlappingTileClips(contentClip, viewport) {
  const overlap = Math.min(200, Math.floor(viewport.height / 4));
  const step = viewport.height - overlap;
  const lastStart = Math.max(0, contentClip.height - viewport.height);
  const starts = [0];
  for (let y = step; y < lastStart; y += step) starts.push(y);
  if (lastStart > 0) starts.push(lastStart);

  const tiles = [];
  for (let row = 0; row < starts.length; row++) {
    const y = row === 0 ? 0 : starts[row - 1] + viewport.height;
    const height = Math.min(contentClip.height, starts[row] + viewport.height) - y;
    if (height <= 0) continue;
    for (let x = 0; x < contentClip.width; x += viewport.width) {
      const width = Math.min(viewport.width, contentClip.width - x);
      tiles.push({
        x, y, width, height,
        captureY: contentClip.y + starts[row],
        clip: { x: contentClip.x + x, y: contentClip.y + y, width, height, scale: 1 }
      });
    }
  }
  return tiles;
}

async function evaluatePage(api, target, expression) {
  const response = await api.debugger.sendCommand(target, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true
  });
  if (response?.exceptionDetails || response?.result?.value === undefined) {
    throw new Error("ページのスクロール位置を取得できませんでした。");
  }
  return response.result.value;
}

function pngDimensions(base64) {
  const header = atob(base64.slice(0, 32));
  if (header.length < 24 || header.slice(0, 8) !== "\x89PNG\r\n\x1a\n") return null;
  const numberAt = (index) => (((header.charCodeAt(index) * 256 + header.charCodeAt(index + 1)) * 256 +
    header.charCodeAt(index + 2)) * 256 + header.charCodeAt(index + 3));
  return { width: numberAt(16), height: numberAt(20) };
}

async function capturePageTiles(api, target, contentClip, viewport) {
  const tiles = [];
  const original = await evaluatePage(api, target, "({ x: window.scrollX, y: window.scrollY })");
  try {
    for (const tile of overlappingTileClips(contentClip, viewport)) {
      const position = await evaluatePage(api, target, `new Promise(resolve => {
        window.scrollTo({ left: ${tile.clip.x}, top: ${tile.captureY}, behavior: 'instant' });
        setTimeout(() => resolve({ x: window.scrollX, y: window.scrollY }), 400);
      })`);
      if (![position.x, position.y].every(Number.isFinite) ||
          position.x > tile.clip.x + 1 || position.y > tile.clip.y + 1 ||
          position.x + viewport.width < tile.clip.x + tile.width - 1 ||
          position.y + viewport.height < tile.clip.y + tile.height - 1) {
        throw new Error("ページを必要な位置までスクロールできませんでした。ページ内の独立したスクロール枠には対応していません。");
      }
      let result;
      let capturePosition = position;
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await api.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "png", fromSurface: true, captureBeyondViewport: false
        });
        const after = await evaluatePage(api, target, "({ x: window.scrollX, y: window.scrollY })");
        if (Math.abs(after.x - capturePosition.x) <= 1 && Math.abs(after.y - capturePosition.y) <= 1) break;
        if (attempt === 1) throw new Error("撮影中にページのスクロール位置が変わりました。再試行してください。");
        capturePosition = await evaluatePage(api, target, `new Promise(resolve =>
          setTimeout(() => resolve({ x: window.scrollX, y: window.scrollY }), 400))`);
      }
      if (!result?.data) throw new Error("ページの分割画像を取得できませんでした。");
      if (capturePosition.x > tile.clip.x + 1 || capturePosition.y > tile.clip.y + 1 ||
          capturePosition.x + viewport.width < tile.clip.x + tile.width - 1 ||
          capturePosition.y + viewport.height < tile.clip.y + tile.height - 1) {
        throw new Error("撮影中にページの表示位置が変わりました。再試行してください。");
      }
      tiles.push({
        x: tile.x, y: tile.y, width: tile.width, height: tile.height,
        sourceX: tile.clip.x - capturePosition.x, sourceY: tile.clip.y - capturePosition.y,
        viewportWidth: viewport.width, viewportHeight: viewport.height,
        dataUrl: `data:image/png;base64,${result.data}`
      });
    }
  } finally {
    await evaluatePage(api, target,
      `(() => { window.scrollTo({ left: ${original.x}, top: ${original.y}, behavior: 'instant' }); return true; })()`);
  }
  return tiles;
}

async function captureExpandedViewport(api, target, contentClip, viewport, imageProcessor) {
  // A real viewport tall enough to contain the document avoids seams and sticky
  // overlays on pages that Chromium cannot render correctly beyond the viewport.
  if (contentClip.x !== 0 || contentClip.y !== 0 ||
      contentClip.width > viewport.width + 1 || contentClip.height > 8000 ||
      contentClip.width * contentClip.height > 20_000_000) return null;

  let original;
  let overridden = false;
  try {
    original = await evaluatePage(api, target, "({ x: window.scrollX, y: window.scrollY })");
    await api.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: contentClip.width, height: contentClip.height,
      deviceScaleFactor: 1, mobile: false
    });
    overridden = true;
    await evaluatePage(api, target, "new Promise(resolve => setTimeout(() => resolve(true), 500))");
    const metrics = await api.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const expandedClip = clipFor(metrics);
    if (expandedClip.x !== 0 || expandedClip.y !== 0 ||
        Math.abs(expandedClip.width - contentClip.width) > 16 ||
        Math.abs(expandedClip.height - contentClip.height) > contentClip.height * 0.1 ||
        expandedClip.height > 8000 ||
        expandedClip.width * expandedClip.height > 20_000_000 ||
        !Number.isFinite(metrics.cssVisualViewport?.clientHeight) ||
        metrics.cssVisualViewport.clientHeight < expandedClip.height - 1) return null;

    const result = await api.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false,
      clip: expandedClip
    });
    if (!result?.data) return null;
    const dimensions = pngDimensions(result.data);
    if (!dimensions || dimensions.width < expandedClip.width ||
        Math.abs(dimensions.width / expandedClip.width -
          dimensions.height / expandedClip.height) > 0.02) return null;
    const dataUrl = `data:image/png;base64,${result.data}`;
    const repeated = await imageProcessor.hasRepeatedViewport(dataUrl, {
      contentHeight: expandedClip.height,
      viewportHeight: viewport.height
    });
    return repeated ? null : dataUrl;
  } catch {
    return null;
  } finally {
    if (overridden) {
      await api.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride");
      await evaluatePage(api, target,
        `(() => { window.scrollTo({ left: ${original.x}, top: ${original.y}, behavior: 'instant' }); return true; })()`);
    }
  }
}

export async function captureFullPage(api, tabId, imageProcessor = null) {
  const target = { tabId };
  // Attach failures must not detach an existing session owned by DevTools/another extension.
  await api.debugger.attach(target, "1.3");
  let captureError;
  try {
    const metrics = await api.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const contentClip = clipFor(metrics);
    const viewport = viewportFor(metrics, contentClip);
    const result = await api.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: contentClip
    });
    if (!result?.data) throw new Error("ページの画像を取得できませんでした。");
    const dataUrl = `data:image/png;base64,${result.data}`;

    if (imageProcessor && viewport && contentClip.height >= viewport.height * 1.8) {
      const repeated = await imageProcessor.hasRepeatedViewport(dataUrl, {
        contentHeight: contentClip.height,
        viewportHeight: viewport.height
      });
      if (contentClip.height <= viewport.height * 3) {
        if (repeated) await imageProcessor.onFallback?.();
        const expanded = await captureExpandedViewport(api, target, contentClip, viewport, imageProcessor);
        if (expanded) return expanded;
      }
      if (repeated) {
        if (contentClip.height > viewport.height * 3) await imageProcessor.onFallback?.();
        const refreshedMetrics = await api.debugger.sendCommand(target, "Page.getLayoutMetrics");
        const refreshedClip = clipFor(refreshedMetrics);
        const refreshedViewport = viewportFor(refreshedMetrics, refreshedClip);
        if (!refreshedViewport) throw new Error("表示領域のサイズを取得できませんでした。");
        const tiles = await capturePageTiles(api, target, refreshedClip, refreshedViewport);
        return await imageProcessor.stitch(tiles, {
          width: refreshedClip.width,
          height: refreshedClip.height
        });
      }
    }
    return dataUrl;
  } catch (error) {
    captureError = error;
    throw error;
  } finally {
    try {
      await api.debugger.detach(target);
    } catch (error) {
      // The user can cancel debugging or close the tab while capture is in progress.
      if (!captureError && !/not attached|No tab with given id|No target with given id/i.test(String(error))) {
        throw new Error(`デバッガーを切断できませんでした。ブラウザのデバッグ通知からキャンセルしてください。${error.message || error}`);
      }
    }
  }
}

export function explainError(error) {
  const detail = error?.message || String(error);
  if (/clipboard|クリップボード|NotAllowedError/i.test(detail)) {
    return `クリップボードにコピーできませんでした。拡張を再読み込みして再試行してください。\n${detail}`;
  }
  if (/another debugger|already attached/i.test(detail)) {
    return "開発者ツール、または別の拡張がデバッグ接続中です。接続を閉じてから再試行してください。";
  }
  if (/Cannot access|not allowed|permission|chrome:\/\/|edge:\/\//i.test(detail)) {
    return `このページでは撮影が許可されていません。通常のWebページで試してください。file:// の場合は拡張の「ファイルの URL へのアクセスを許可する」を確認してください。\n${detail}`;
  }
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(detail)) {
    return "撮影間隔が短すぎます。少し待ってから再試行してください。";
  }
  return `撮影できませんでした。ページ全体の場合は開発者ツールを閉じ、長いページでは表示領域の撮影もお試しください。\n${detail}`;
}

export function createCaptureService(api, publishStatus, now = () => Date.now(), copyImage = null, imageProcessor = null) {
  let busy = false;
  let lastVisibleCapture = -Infinity;

  return async function capture(mode, requestedTab, destination = "download") {
    if (!MODES.has(mode)) return { ok: false, error: "不明な撮影モードです。" };
    if (!DESTINATIONS.has(destination)) return { ok: false, error: "不明な出力先です。" };
    if (busy) return { ok: false, error: "撮影処理中です。完了してから再試行してください。" };
    busy = true;
    try {
      const tab = requestedTab ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!Number.isInteger(tab?.id) || tab.id < 0 || !Number.isInteger(tab.windowId)) {
        throw new Error("撮影するタブが見つかりません。");
      }
      await publishStatus({ state: "capturing", mode, message: mode === "viewport" ? "表示領域を撮影しています…" : "ページ全体を撮影しています…" });
      let dataUrl;
      if (mode === "viewport") {
        // captureVisibleTab accepts a window ID, not a tab ID. Never capture a switched tab.
        const [activeTab] = await api.tabs.query({ active: true, windowId: tab.windowId });
        if (activeTab?.id !== tab.id) throw new Error("タブが切り替わったため撮影を中止しました。撮影するタブで再試行してください。");
        if (now() - lastVisibleCapture < 600) throw new Error("撮影間隔が短すぎます。少し待ってから再試行してください。");
        lastVisibleCapture = now();
        dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      } else {
        dataUrl = await captureFullPage(api, tab.id, imageProcessor);
      }
      if (destination === "clipboard") {
        if (!copyImage) throw new Error("クリップボード機能を利用できません。");
        await copyImage(dataUrl, tab);
        await publishStatus({ state: "copied", mode, destination, message: "PNGをクリップボードにコピーしました。" });
        return { ok: true, destination };
      }

      const filename = filenameFor(mode);
      const downloadId = await api.downloads.download({
        url: dataUrl, filename, saveAs: false, conflictAction: "uniquify"
      });
      // This API resolves when a download starts; it does not guarantee completion.
      await publishStatus({ state: "started", mode, destination, filename, downloadId, message: "PNGのダウンロードを開始しました。保存状況はブラウザのダウンロード一覧で確認できます。" });
      return { ok: true, destination, downloadId, filename };
    } catch (error) {
      const message = explainError(error);
      await publishStatus({ state: "error", mode, message });
      return { ok: false, error: message };
    } finally {
      busy = false;
    }
  };
}
