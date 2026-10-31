import { DEFAULT_SEQUENCE_OPTIONS, sequenceOptions } from "./sequence.js";

const statusElement = document.querySelector("#status");
const buttons = [...document.querySelectorAll(".capture")];
const startButton = document.querySelector("#sequence-start");
const stopButton = document.querySelector("#sequence-stop");
const audioStartButton = document.querySelector("#audio-start");
const audioStopButton = document.querySelector("#audio-stop");
const audioElapsed = document.querySelector("#audio-elapsed");
const settings = [...document.querySelectorAll(".sequence-settings select")];
let currentStatus;

function updateElapsed() {
  if (currentStatus?.mode !== "audio" || currentStatus.state !== "recording") return;
  const seconds = Math.max(0, Math.floor((Date.now() - currentStatus.startedAt) / 1000));
  audioElapsed.textContent = `録音中 ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
setInterval(updateElapsed, 1000);

function showStatus(status) {
  if (!status) return;
  currentStatus = status;
  statusElement.textContent = status.message;
  statusElement.classList.toggle("error", status.state === "error");
  const busy = ["capturing", "preparing", "countdown", "recording", "packaging"].includes(status.state);
  [...buttons, ...settings].forEach((item) => { item.disabled = busy; });
  stopButton.hidden = status.mode !== "sequence" || !["countdown", "recording"].includes(status.state);
  stopButton.textContent = status.state === "countdown" ? "撮影をキャンセル" : "途中で停止して保存";
  audioStopButton.hidden = status.mode !== "audio" || status.state !== "recording";
  audioElapsed.hidden = audioStopButton.hidden;
  updateElapsed();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.captureStatus) showStatus(changes.captureStatus.newValue);
});

for (const button of buttons.filter((item) => item !== startButton && item !== audioStartButton)) {
  button.addEventListener("click", async () => {
    buttons.forEach((item) => { item.disabled = true; });
    const copiesTitle = button.dataset.action === "copy-title";
    showStatus({ state: "capturing", message: copiesTitle ? "ページタイトルを取得しています…" : "撮影しています…" });
    try {
      const request = chrome.runtime.sendMessage(copiesTitle ? { type: "copy-title" } : {
        type: "capture", mode: button.dataset.mode, destination: button.dataset.destination
      });
      if (copiesTitle || button.dataset.destination === "clipboard") {
        // Return focus to the page so the injected Clipboard API call is allowed.
        request.catch(() => {});
        window.close();
        return;
      }
      const result = await request;
      if (!result?.ok) showStatus({ state: "error", message: result?.error || "撮影を開始できませんでした。" });
    } catch (error) {
      showStatus({ state: "error", message: `拡張を再読み込みして再試行してください。\n${error.message}` });
    } finally {
      showStatus(currentStatus);
    }
  });
}

function selectedOptions() {
  return sequenceOptions({
    seconds: Number(document.querySelector("#sequence-seconds").value),
    fps: Number(document.querySelector("#sequence-fps").value),
    format: document.querySelector("#sequence-format").value,
    maxWidth: Number(document.querySelector("#sequence-width").value)
  });
}

for (const setting of settings) {
  setting.addEventListener("change", () => {
    chrome.storage.local.set({ sequenceOptions: selectedOptions() }).catch((error) => showStatus({ state: "error", message: error.message }));
  });
}

startButton.addEventListener("click", async () => {
  try {
    const options = selectedOptions();
    showStatus({ state: "preparing", message: "連続撮影を準備しています…" });
    await chrome.storage.local.set({ sequenceOptions: options });
    // The offscreen document owns the capture after this popup closes.
    chrome.runtime.sendMessage({ type: "sequence-start", options }).catch(() => {});
    window.close();
  } catch (error) { showStatus({ state: "error", message: error.message }); }
});

audioStartButton.addEventListener("click", async () => {
  showStatus({ state: "preparing", mode: "audio", message: "音声録音を準備しています…" });
  try {
    const result = await chrome.runtime.sendMessage({ type: "audio-start" });
    if (!result?.ok) throw new Error(result?.error || "音声録音を開始できませんでした。");
  } catch (error) { showStatus({ state: "error", message: error.message }); }
});

audioStopButton.addEventListener("click", async () => {
  audioStopButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "audio-stop" });
    if (!result?.ok) throw new Error(result?.error || "録音を停止できませんでした。");
  } catch (error) { showStatus({ state: "error", message: error.message }); }
  finally { audioStopButton.disabled = false; }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "sequence-stop" });
    if (!result?.ok) throw new Error(result?.error || "停止できませんでした。");
  } catch (error) { showStatus({ state: "error", message: error.message }); }
  finally { stopButton.disabled = false; }
});

document.querySelector("#shortcuts").addEventListener("click", () => {
  const scheme = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
  chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` }).catch((error) => {
    showStatus({ state: "error", message: error.message });
  });
});

try {
  const [commands, stored, preferences] = await Promise.all([
    chrome.commands.getAll(), chrome.storage.session.get("captureStatus"), chrome.storage.local.get("sequenceOptions")
  ]);
  let options;
  try { options = sequenceOptions(preferences.sequenceOptions); }
  catch { options = DEFAULT_SEQUENCE_OPTIONS; }
  document.querySelector("#sequence-seconds").value = options.seconds;
  document.querySelector("#sequence-fps").value = options.fps;
  document.querySelector("#sequence-format").value = options.format;
  document.querySelector("#sequence-width").value = options.maxWidth;
  for (const command of ["capture-viewport", "copy-viewport", "capture-fullpage", "copy-fullpage", "copy-title", "capture-sequence"]) {
    document.querySelector(`#${command}-key`).textContent = commands.find((item) => item.name === command)?.shortcut || "未設定";
  }
  if (!currentStatus) showStatus(stored.captureStatus);
} catch (error) {
  showStatus({ state: "error", message: error.message });
}
