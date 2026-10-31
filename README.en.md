# Korochin PageShot

[日本語](README.md)

A Manifest V3 extension for Chrome / Edge that saves web pages as PNG images, copies screenshots directly to the clipboard, or captures short movements as a ZIP of sequential WebP / PNG frames. Screenshots exclude the browser frame, including the tab bar and address bar. No build step or `npm install` is required.

The extension's interface and status messages are currently in Japanese. Japanese button labels are included below where needed.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Save the visible area as PNG | Ctrl + Shift + Y | Command + Shift + Y |
| Save the full page as PNG | Ctrl + Shift + U | Command + Shift + U |
| Copy the visible area | Alt + Shift + Y | Option + Shift + Y |
| Copy the full page | Alt + Shift + U | Option + Shift + U |
| Copy the page title | Set manually | Set manually |
| Save a frame sequence as ZIP | Set manually | Set manually |

Use these shortcuts while the browser has focus. Screenshot copy shortcuts put the captured PNG directly on the clipboard without opening the popup or a save dialog. The page title action copies the current page's `document.title` as text. All actions are also available from the extension icon's popup.

## Installation

1. Enter `chrome://extensions/` in Chrome's address bar, or `edge://extensions/` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the **korochin-pageshot folder** containing this README and `manifest.json`.
5. Optionally pin PageShot to the toolbar from the extensions menu.
6. Open a regular web page and capture it using a shortcut or a popup button.

Chrome / Edge 118 or later is required. After updating the source files, click the reload button on the browser's extensions page.

## Saved files and clipboard results

Files are saved in the `screenshots` subfolder of your browser's configured downloads folder.

```text
screenshots/
├─ screenshot-viewport-20260909-152130-042.png
└─ screenshot-fullpage-20260909-152135-108.png
```

Timestamps use your computer's local time. If a filename already exists, the browser adds a number instead of overwriting it. The extension does not request a save dialog, but browser settings or management policies may still cause one to appear.

The extension icon's badge shows `…` while processing, `WAIT` during the capture countdown, `REC` while recording frames, `↓` when a download starts, `✓` when copying to the clipboard succeeds, and `!` on failure. Click the icon for details. The `↓` badge does not guarantee that saving has finished. Check your browser's downloads list (Ctrl + J on Windows) to confirm completion or interruption.

## Frame sequences: sharing motion references with AI

1. Click the extension icon in the tab you want to capture, then choose settings under **コマ送り画像** (Frame sequence). The defaults are **3 seconds, 10 fps, WebP, and a maximum width of 1280 px**.
2. Click **2秒後に連続撮影** (Start capturing in 2 seconds). The popup closes and capture starts after a two-second countdown, giving you time to interact with the animation or scroll the page.
3. Capture ends automatically after the selected duration. The extension saves `screenshot-sequence-<timestamp>.zip` in your downloads folder under `screenshots`.
4. To finish early, reopen the extension popup and click **途中で停止して保存** (Stop and save). You can also cancel during the countdown.

Available settings are 1 / 2 / 3 / 5 / 10 seconds, a target rate of 2 / 5 / 10 fps, WebP / PNG format, and a maximum width of 960 / 1280 / 1920 px. Settings are retained for the next capture and also apply when using a shortcut.

The ZIP contains:

- `frames/`: sequential images, with a frame number and milliseconds since capture started in each filename.
- `sheets/`: timestamped WebP contact sheets containing up to 10 frames each, ordered left to right and top to bottom (quality 0.82, two columns and up to five rows). Contact sheets use WebP even when individual frames use PNG.
- `manifest.json`: the page title and URL, capture settings, the actual extraction time of each frame, image dimensions, and the reason capture ended.
- `README.txt`: instructions for reading the images.

Start by sharing the contact sheets with the AI, then add original frames when finer detail is needed. For an agent that can access local files, you can provide the path to the extracted ZIP folder.

Only the visible area of the tab selected at the start is captured. Audio, offscreen page content, and interaction logs are not included. WebP uses lossy compression at quality 0.82; PNG is lossless. Images retain their aspect ratio and are scaled down only when they exceed the selected width or a height of 1920 px. Resizing the tab during capture may leave blank space within the fixed image dimensions.

The frame rate is a target. Browser rendering and system load may cause missing or duplicate frames; these are not precise video frame timestamps. The extension does not capture overdue frames in a burst. Instead, `elapsedMs` in `manifest.json` records each frame's actual extraction time. Keep the target tab visible and do not minimize its window while capturing. If tab sharing ends, the frames already captured are saved. Capture ends with an error if sequential frame images exceed 128 MB, to protect memory usage.

## Changing shortcuts

Click **ショートカットを変更** (Change shortcuts) in the popup, or open:

- Chrome: `chrome://extensions/shortcuts`
- Edge: `edge://extensions/shortcuts`

Default shortcuts may not be registered if they conflict with another extension or the operating system. If the popup shows **未設定** (Not set), assign a shortcut on this page. The popup displays the actual assigned shortcuts.

Chromium allows extensions to suggest default keys for up to four commands. As a result, the page title and frame sequence actions have no default shortcuts. Assign your preferred keys on the shortcuts page above.

## Capture methods and limitations

- **Visible area**: uses `chrome.tabs.captureVisibleTab()` to capture the part of the page visible at the current scroll position.
- **Frame sequence**: sends the tab's video stream to an offscreen document through `tabCapture`, then converts frames to images using Canvas. This avoids the normal `captureVisibleTab` limit of two calls per second and does not insert capture UI into the page. No additional external libraries are used.
- **Full page**: temporarily attaches to the target tab through `chrome.debugger`, then passes `cssContentSize` from `Page.getLayoutMetrics` as the `clip` for `Page.captureScreenshot`. This includes content outside the viewport in both directions. At browser zoom levels other than 100%, the extension captures overlapping viewport images and stitches them together to avoid repeated image content caused by scaling. At 100% zoom, for short pages or pages where repeated content is detected, it attempts to temporarily expand the viewport to the full page height within size limits. If that is unavailable, it scrolls through the page, captures overlapping viewport images, and stitches them together. The original viewport and scroll position are restored afterward.
- During full-page capture, the browser shows a notification that a debugger is attached. If capture conflicts with Developer Tools or another debugging extension, close them before capturing.
- Scroll through the page first to load lazy-loaded images. The extension does not automatically expand unloaded infinite-scroll content, rows absent from the DOM in virtualized lists, or all content inside independently scrollable containers.
- Very long pages may exceed the browser's image size or memory limits. Use visible-area capture if this happens.
- The appearance of videos, animations, fixed elements, and dynamic layouts depends on the browser's rendering.
- Switching to another capture method happens automatically. During tiled capture, the page's scroll position changes temporarily, and fixed elements may appear in multiple places. An error is shown if the page cannot scroll to the required position.
- Browser internal pages, extension stores, and PDF viewers have restrictions depending on the capture method. Start with a regular HTTP / HTTPS page. For local HTML files, enable **Allow access to file URLs** on the extension's details page.
- Repeated clicks are prevented from starting duplicate operations. Visible-area captures require an interval of at least 600 milliseconds to respect the API rate limit.

## Permissions and data

| Permission | Purpose |
| --- | --- |
| activeTab | Capture the visible area of the tab where the user invokes the extension |
| clipboardWrite | Write a captured PNG or page title to the clipboard |
| downloads | Save PNG images and frame sequence ZIPs to the downloads folder |
| tabCapture | Create frame sequences from a tab's video stream, started by a user action |
| debugger | Capture the full page |
| offscreen | Detect and stitch repeated image content, capture frame sequences, and create contact sheets and ZIPs |
| scripting | Run image and title clipboard API calls on the active page when using shortcuts |
| storage | Keep operation results and references to ZIPs being saved in session storage, and save frame sequence settings locally |

`debugger` is a powerful permission, and the browser displays a warning during installation. It is used only for capture operations. The extension makes no requests to external servers, uses no analytics services, and has no persistent content scripts. Images are passed to the downloads API or the operating system's clipboard and are not saved in history storage. Frame sequence ZIPs are temporarily kept in memory until the download completes or is interrupted. Capture metadata in each ZIP includes the page title and URL.

## Verification

Run these commands with Node.js 18 or later. No external dependencies are required.

```powershell
npm.cmd test
npm.cmd run check
```

Automated tests mock the APIs to verify capture mode separation, the target window, CSS dimensions, repeated-content detection, tile bounds and fallback to image stitching, debugger cleanup, repeated and concurrent requests, and save errors. Frame sequence tests use mocks to verify target timing and frame skipping under load, timestamped contact sheets, early stopping, ZIP structure and CRC, and resource release after save failures. Check image quality in a real browser as follows:

1. Open `tests/fixture.html` in the browser and allow local file access for the extension.
2. Scroll partway down the page and capture the visible area. Confirm that the image excludes the browser frame and the offscreen beginning and end of the page.
3. Capture the full page from the same position. Confirm that the image includes `START`, `END`, and the markers on the right edge, and that the original scroll position is preserved.
4. Set browser zoom to 75% and 125% and try both capture modes at each level. Confirm that full-page images have no repeated content, clipping, or blank margins.
5. Try the popup buttons and shortcuts for both saving and copying. After copying, confirm that the image can be pasted into an image-capable application and that the correct target is captured across different windows.
6. Assign a shortcut for copying the page title. Run it and paste into a text editor; the result should be `PageShot キャプチャ確認ページ`.
7. Confirm that the debugger notification disappears after full-page capture and that the popup explains failures.
8. Capture a moving page with the settings **3 seconds, 10 fps, WebP**. Confirm that the ZIP contains approximately 30 frames and three contact sheets, with matching order, timestamps, and motion. Also confirm that frame capture cannot run at the same time as a regular screenshot.
9. Try PNG, different settings, the shortcut, cancellation during the countdown, stopping during capture, and closing the target tab. Confirm that settings persist when reopening the popup and that tab sharing stops after capture ends.

## ZIP packages for GitHub Releases

Generate a ZIP containing only the files needed to run the extension:

```powershell
npm.cmd run package
```

The output is `dist/korochin-pageshot-v1.2.1.zip`. The ZIP contains a versioned top-level folder. After extracting it, select that folder with **Load unpacked** in Chrome / Edge. Tests, GitHub Actions, and development files are excluded.

On GitHub, pushing a tag whose version matches `manifest.json` runs tests and syntax checks, then automatically creates a release with the ZIP attached.

```powershell
git tag v1.2.1
git push origin v1.2.1
```

If the tag version does not match `manifest.json`, the workflow fails to prevent an incorrect release. Before the next release, update `manifest.json` and `package.json` to the same version.

## Official references

- [Tabs API / captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
- [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [CDP Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)
- [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Tab Capture / Offscreen recording](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)
