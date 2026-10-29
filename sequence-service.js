import { filenameFor } from "./capture.js";
import { sequenceOptions } from "./sequence.js";

export function createSequenceService(api, publish, processImage) {
  async function releaseDownload(id) {
    const key = `sequenceDownload-${id}`;
    const stored = await api.storage.session.get(key);
    if (stored[key]) {
      await processImage("release-sequence", { url: stored[key] });
      await api.storage.session.remove(key);
    }
  }

  async function run(input, requestedTab) {
    let archiveUrl, downloadId;
    try {
      const options = sequenceOptions(input);
      const tab = requestedTab ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error("撮影するタブが見つかりません。");
      await publish({ state: "preparing", mode: "sequence", message: "連続撮影を準備しています…" });
      // First create the receiver, then obtain and immediately consume the short-lived stream ID.
      await processImage("prepare-sequence", {});
      const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const result = await processImage("record-sequence", {
        streamId, options, page: { title: tab.title ?? "", url: tab.url ?? "" }
      });
      if (result.cancelled) {
        await publish({ state: "cancelled", mode: "sequence", message: "連続撮影をキャンセルしました。" });
        return { ok: true, cancelled: true };
      }
      archiveUrl = result.url;
      const filename = filenameFor("sequence").replace(/\.png$/, ".zip");
      downloadId = await api.downloads.download({ url: archiveUrl, filename, saveAs: false, conflictAction: "uniquify" });
      await api.storage.session.set({ [`sequenceDownload-${downloadId}`]: archiveUrl });
      // A small archive can finish before storage.set or the downloads listener runs.
      const [download] = await api.downloads.search({ id: downloadId });
      if (download && download.state !== "in_progress") await releaseDownload(downloadId);
      await publish({
        state: "started", mode: "sequence",
        message: `${result.frameCount}コマと時刻付き一覧のZIP保存を開始しました。${result.stopReason === "stream-ended" ? "\nタブの共有終了までの画像を保存しました。" : ""}\n${filename}`
      });
      return { ok: true, downloadId, filename };
    } catch (error) {
      // Do not revoke an in-progress download's URL; its completion listener owns it.
      if (archiveUrl && downloadId === undefined) {
        await processImage("release-sequence", { url: archiveUrl }).catch(() => {});
      }
      const message = `連続撮影できませんでした。通常のWebページで再試行してください。\n${error?.message || String(error)}`;
      await publish({ state: "error", mode: "sequence", message });
      return { ok: false, error: message };
    }
  }

  return { run, releaseDownload };
}
