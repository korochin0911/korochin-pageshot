import { createCaptureService, DESTINATIONS, MODES } from "./capture.js";
import { copyDocumentTitleToClipboard, copyPngToClipboard } from "./clipboard.js";
import { createExclusiveRunner, DEFAULT_SEQUENCE_OPTIONS } from "./sequence.js";
import { createSequenceService } from "./sequence-service.js";
import { createAudioService } from "./audio-service.js";

const OFFSCREEN_DOCUMENT = "offscreen.html";
let creatingOffscreenDocument;

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["BLOBS", "USER_MEDIA"],
      justification: "撮影画像の検出・結合、連番画像・ZIP生成とタブ音声の録音のため"
    }).finally(() => { creatingOffscreenDocument = undefined; });
  }
  await creatingOffscreenDocument;
}

async function processImage(type, payload) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({ target: "image-processor", type, ...payload });
  if (!result?.ok) throw new Error(result?.error || "画像・音声を処理できませんでした。");
  return result.value;
}

const imageProcessor = {
  hasRepeatedViewport: (dataUrl, dimensions) => processImage("detect-repetition", { dataUrl, dimensions }),
  stitch: (tiles, dimensions) => processImage("stitch-tiles", { tiles, dimensions }),
  onFallback: () => publishStatus({
    state: "capturing",
    mode: "fullpage",
    message: "ページ構成に合わせて再撮影しています…"
  })
};

async function copyImageToClipboard(dataUrl, tab) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: copyPngToClipboard,
    args: [dataUrl]
  });
  if (!result?.ok) throw new Error(result?.error || "クリップボードにコピーできませんでした。");
}

async function publishStatus(status) {
  const badge = { capturing: "…", preparing: "…", countdown: "WAIT", recording: "REC", packaging: "…", cancelled: "", started: "↓", copied: "✓", error: "!" }[status.state] ?? "";
  // UI failures should not prevent capturing or leave the capture lock held.
  await Promise.allSettled([
    chrome.storage.session.set({ captureStatus: { ...status, updatedAt: Date.now() } }),
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color: status.state === "error" || (status.mode === "audio" && status.state === "recording") ? "#b42318" : "#136f63" }),
    chrome.action.setTitle({ title: `Korochin PageShot — ${status.message}` })
  ]);
}

const capture = createCaptureService(chrome, publishStatus, () => Date.now(), copyImageToClipboard, imageProcessor);
const runExclusive = createExclusiveRunner();
// A recording outlives the service worker. Consult its offscreen owner instead
// of relying solely on an in-memory lock after the worker wakes up again.
const exclusive = (operation) => runExclusive(async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)] });
  if (contexts.length && await processImage("get-audio-status", {})) {
    return { ok: false, error: "音声録音を処理中です。停止・保存後に再試行してください。" };
  }
  return operation();
});
const sequence = createSequenceService(chrome, publishStatus, processImage);
const audio = createAudioService(chrome, publishStatus, processImage);

chrome.downloads.onChanged.addListener((delta) => {
  if (["complete", "interrupted"].includes(delta.state?.current)) {
    void sequence.releaseDownload(delta.id).catch(console.error);
    void audio.releaseDownload(delta.id).catch(console.error);
  }
});

async function copyPageTitle(requestedTab) {
  try {
    const tab = requestedTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error("タイトルを取得するタブが見つかりません。");
    await publishStatus({ state: "capturing", operation: "copy-title", message: "ページタイトルを取得しています…" });
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: copyDocumentTitleToClipboard
    });
    if (!result?.ok) throw new Error(result?.error || "ページタイトルをコピーできませんでした。");
    await publishStatus({
      state: "copied", operation: "copy-title", message: `ページタイトルをコピーしました。\n${result.title}`
    });
    return { ok: true, title: result.title };
  } catch (error) {
    const detail = error?.message || String(error);
    const message = `ページタイトルをコピーできませんでした。通常のWebページで再試行してください。\n${detail}`;
    await publishStatus({ state: "error", operation: "copy-title", message });
    return { ok: false, error: message };
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  const action = {
    "capture-viewport": ["viewport", "download"],
    "capture-fullpage": ["fullpage", "download"],
    "copy-viewport": ["viewport", "clipboard"],
    "copy-fullpage": ["fullpage", "clipboard"]
  }[command];
  if (action) void exclusive(() => capture(action[0], tab, action[1]));
  if (command === "copy-title") void exclusive(() => copyPageTitle(tab));
  if (command === "capture-sequence") {
    void exclusive(async () => {
      const stored = await chrome.storage.local.get("sequenceOptions");
      return sequence.run(stored.sequenceOptions ?? DEFAULT_SEQUENCE_OPTIONS, tab);
    }).catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromOffscreen = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  if (fromOffscreen && message?.target === "audio-result") {
    audio.save(message.result).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (fromOffscreen && ["sequence-status", "audio-status"].includes(message?.target)) {
    publishStatus(message.status).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message?.type === "audio-start") {
    exclusive(() => audio.start()).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "audio-stop") {
    processImage("stop-audio", {}).then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "sequence-stop") {
    processImage("stop-sequence", {}).then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "sequence-start") {
    exclusive(() => sequence.run(message.options)).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "copy-title") {
    exclusive(() => copyPageTitle()).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type !== "capture" || !MODES.has(message.mode) || !DESTINATIONS.has(message.destination)) return;
  // Keep the popup open until the operation finishes so errors are visible.
  // Extension popups are browser UI, outside the captured page surface.
  exclusive(() => capture(message.mode, undefined, message.destination)).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
