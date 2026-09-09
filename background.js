import { createCaptureService, DESTINATIONS, MODES } from "./capture.js";
import { copyPngToClipboard } from "./clipboard.js";

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
      reasons: ["BLOBS"],
      justification: "異常な全体画像を検出し、分割撮影したPNGを結合するため"
    }).finally(() => { creatingOffscreenDocument = undefined; });
  }
  await creatingOffscreenDocument;
}

async function processImage(type, payload) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({ target: "image-processor", type, ...payload });
  if (!result?.ok) throw new Error(result?.error || "画像を処理できませんでした。");
  return result.value;
}

const imageProcessor = {
  hasRepeatedViewport: (dataUrl, dimensions) => processImage("detect-repetition", { dataUrl, dimensions }),
  stitch: (tiles, dimensions) => processImage("stitch-tiles", { tiles, dimensions }),
  onFallback: () => publishStatus({
    state: "capturing",
    mode: "fullpage",
    message: "ページ構成に合わせて分割撮影しています…"
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
  const badge = { capturing: "…", started: "↓", copied: "✓", error: "!" }[status.state];
  // UI failures should not prevent capturing or leave the capture lock held.
  await Promise.allSettled([
    chrome.storage.session.set({ captureStatus: { ...status, updatedAt: Date.now() } }),
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color: status.state === "error" ? "#b42318" : "#136f63" }),
    chrome.action.setTitle({ title: `Korochin PageShot — ${status.message}` })
  ]);
}

const capture = createCaptureService(chrome, publishStatus, () => Date.now(), copyImageToClipboard, imageProcessor);

chrome.commands.onCommand.addListener((command, tab) => {
  const action = {
    "capture-viewport": ["viewport", "download"],
    "capture-fullpage": ["fullpage", "download"],
    "copy-viewport": ["viewport", "clipboard"],
    "copy-fullpage": ["fullpage", "clipboard"]
  }[command];
  if (action) void capture(action[0], tab, action[1]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message?.type !== "capture" || !MODES.has(message.mode) || !DESTINATIONS.has(message.destination)) return;
  // Keep the popup open until the operation finishes so errors are visible.
  // Extension popups are browser UI, outside the captured page surface.
  capture(message.mode, undefined, message.destination).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
