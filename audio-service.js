import { filenameFor } from "./capture.js";

export function createAudioService(api, publish, processAudio) {
  async function releaseDownload(id) {
    const key = `audioDownload-${id}`;
    const stored = await api.storage.session.get(key);
    if (stored[key]) {
      await processAudio("release-audio", { url: stored[key] });
      await api.storage.session.remove(key);
    }
  }

  async function start(requestedTab) {
    try {
      const tab = requestedTab ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error("録音するタブが見つかりません。");
      await publish({ state: "preparing", mode: "audio", message: "音声録音を準備しています…" });
      await processAudio("prepare-audio", {});
      const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await processAudio("start-audio", { streamId, page: { title: tab.title ?? "" } });
      return { ok: true };
    } catch (error) {
      const message = `音声録音を開始できませんでした。通常のWebページで再試行してください。\n${error?.message || String(error)}`;
      await publish({ state: "error", mode: "audio", message });
      return { ok: false, error: message };
    }
  }

  async function save(result) {
    let downloadId;
    try {
      const filename = filenameFor("audio", new Date(result.startedAt)).replace(/screenshot-audio-/, "audio-").replace(/\.png$/, ".webm");
      downloadId = await api.downloads.download({ url: result.url, filename, saveAs: false, conflictAction: "uniquify" });
      await api.storage.session.set({ [`audioDownload-${downloadId}`]: result.url });
      const [download] = await api.downloads.search({ id: downloadId });
      if (download && download.state !== "in_progress") await releaseDownload(downloadId);
      const reason = {
        "stream-ended": "\nタブの共有終了までの音声を保存しました。",
        "duration-limit": "\n60分に達したため自動停止しました。",
        "size-limit": "\n音声が128MBに達したため自動停止しました。",
        "recorder-error": "\n録音エラーが発生するまでの音声を保存しました。"
      }[result.stopReason] || "";
      await publish({ state: "started", mode: "audio", message: `音声のWebM保存を開始しました。${reason}${result.warning ? `\n${result.warning}` : ""}\n${filename}` });
      return { ok: true, downloadId, filename };
    } catch (error) {
      if (downloadId === undefined) await processAudio("release-audio", { url: result.url }).catch(() => {});
      const message = `音声を保存できませんでした。\n${error?.message || String(error)}`;
      await publish({ state: "error", mode: "audio", message });
      return { ok: false, error: message };
    }
  }

  return { start, save, releaseDownload };
}
