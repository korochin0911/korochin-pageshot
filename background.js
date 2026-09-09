import { createCaptureService, MODES } from "./capture.js";

async function publishStatus(status) {
  const badge = { capturing: "…", started: "↓", error: "!" }[status.state];
  // UI failures should not prevent capturing or leave the capture lock held.
  await Promise.allSettled([
    chrome.storage.session.set({ captureStatus: { ...status, updatedAt: Date.now() } }),
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color: status.state === "error" ? "#b42318" : "#136f63" }),
    chrome.action.setTitle({ title: `Korochin PageShot — ${status.message}` })
  ]);
}

const capture = createCaptureService(chrome, publishStatus);

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = { "capture-viewport": "viewport", "capture-fullpage": "fullpage" }[command];
  if (mode) void capture(mode, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message?.type !== "capture" || !MODES.has(message.mode)) return;
  // Keep the popup open until the operation finishes so errors are visible.
  // Extension popups are browser UI, outside the captured page surface.
  capture(message.mode).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
