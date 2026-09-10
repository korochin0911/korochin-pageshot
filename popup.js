const statusElement = document.querySelector("#status");
const buttons = [...document.querySelectorAll(".capture")];

function showStatus(status) {
  if (!status) return;
  statusElement.textContent = status.message;
  statusElement.classList.toggle("error", status.state === "error");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.captureStatus) showStatus(changes.captureStatus.newValue);
});

for (const button of buttons) {
  button.addEventListener("click", async () => {
    buttons.forEach((item) => { item.disabled = true; });
    const copiesTitle = button.dataset.action === "copy-title";
    showStatus({ message: copiesTitle ? "ページタイトルを取得しています…" : "撮影しています…" });
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
      buttons.forEach((item) => { item.disabled = false; });
    }
  });
}

document.querySelector("#shortcuts").addEventListener("click", () => {
  const scheme = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
  chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` }).catch((error) => {
    showStatus({ state: "error", message: error.message });
  });
});

try {
  const [commands, stored] = await Promise.all([
    chrome.commands.getAll(), chrome.storage.session.get("captureStatus")
  ]);
  for (const command of ["capture-viewport", "copy-viewport", "capture-fullpage", "copy-fullpage", "copy-title"]) {
    document.querySelector(`#${command}-key`).textContent = commands.find((item) => item.name === command)?.shortcut || "未設定";
  }
  showStatus(stored.captureStatus);
} catch (error) {
  showStatus({ state: "error", message: error.message });
}
