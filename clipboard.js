export async function copyPngToClipboard(dataUrl, dependencies = {}) {
  try {
    const fetcher = dependencies.fetcher ?? globalThis.fetch;
    const clipboard = dependencies.clipboard ?? globalThis.navigator?.clipboard;
    const ClipboardItemCtor = dependencies.ClipboardItemCtor ?? globalThis.ClipboardItem;
    if (!clipboard?.write || !ClipboardItemCtor || !fetcher) {
      throw new Error("クリップボードAPIを利用できません。");
    }

    // A popup click returns focus to the page just after the popup closes.
    if (!dependencies.skipFocusCheck && globalThis.document) {
      for (let attempt = 0; attempt < 20 && !document.hasFocus(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!document.hasFocus()) throw new Error("コピー先のページにフォーカスがありません。");
    }

    const response = await fetcher(dataUrl);
    const blob = await response.blob();
    if (blob.type !== "image/png") throw new Error("撮影結果がPNGではありません。");
    await clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function copyDocumentTitleToClipboard(dependencies = {}) {
  try {
    const pageDocument = dependencies.document ?? globalThis.document;
    const clipboard = dependencies.clipboard ?? globalThis.navigator?.clipboard;
    const title = pageDocument?.title ?? "";
    if (!title) throw new Error("このページにはタイトルがありません。");
    if (!clipboard?.writeText) throw new Error("クリップボードAPIを利用できません。");

    if (!dependencies.skipFocusCheck) {
      for (let attempt = 0; attempt < 20 && !pageDocument.hasFocus(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!pageDocument.hasFocus()) throw new Error("コピー元のページにフォーカスがありません。");
    }

    await clipboard.writeText(title);
    return { ok: true, title };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
