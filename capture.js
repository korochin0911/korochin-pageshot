export const MODES = new Set(["viewport", "fullpage"]);

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

export async function captureFullPage(api, tabId) {
  const target = { tabId };
  // Attach failures must not detach an existing session owned by DevTools/another extension.
  await api.debugger.attach(target, "1.3");
  let captureError;
  try {
    const metrics = await api.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const result = await api.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: clipFor(metrics)
    });
    if (!result?.data) throw new Error("ページの画像を取得できませんでした。");
    return `data:image/png;base64,${result.data}`;
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

export function createCaptureService(api, publishStatus, now = () => Date.now()) {
  let busy = false;
  let lastVisibleCapture = -Infinity;

  return async function capture(mode, requestedTab) {
    if (!MODES.has(mode)) return { ok: false, error: "不明な撮影モードです。" };
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
        dataUrl = await captureFullPage(api, tab.id);
      }
      const filename = filenameFor(mode);
      const downloadId = await api.downloads.download({
        url: dataUrl, filename, saveAs: false, conflictAction: "uniquify"
      });
      // This API resolves when a download starts; it does not guarantee completion.
      await publishStatus({ state: "started", mode, filename, downloadId, message: "PNGのダウンロードを開始しました。保存状況はブラウザのダウンロード一覧で確認できます。" });
      return { ok: true, downloadId, filename };
    } catch (error) {
      const message = explainError(error);
      await publishStatus({ state: "error", mode, message });
      return { ok: false, error: message };
    } finally {
      busy = false;
    }
  };
}
