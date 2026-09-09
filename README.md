# Korochin PageShot

Chrome / Edge のWebページをPNG保存する Manifest V3 拡張です。タブバー、アドレスバーなど、ブラウザの外枠は入りません。ビルドや npm install は不要です。

| 撮影方法 | Windows / Linux | macOS |
| --- | --- | --- |
| 現在見えている領域 | Ctrl + Shift + Y | Command + Shift + Y |
| 画面外を含むページ全体 | Ctrl + Shift + U | Command + Shift + U |

ブラウザにフォーカスがある状態で使います。拡張アイコンのポップアップからも両方を実行できます。

## インストール

1. Chrome では `chrome://extensions/`、Edge では `edge://extensions/` をアドレスバーに入力します。
2. 「デベロッパー モード」（Edge は「開発者モード」）を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」（Edge は「展開して読み込み」）を選びます。
4. この README と `manifest.json` がある **korochin-pageshot フォルダ**を指定します。
5. 必要に応じて、拡張メニューから PageShot をツールバーに固定します。
6. 通常のWebページを開き、ショートカットかポップアップのボタンで撮影します。

Chrome / Edge 118 以降を対象にしています。ソース更新後は拡張管理画面の再読み込みボタンを押してください。

## 保存先と結果

ブラウザで設定したダウンロードフォルダ内の `screenshots` に保存します。

```text
screenshots/
├─ screenshot-viewport-20260909-152130-042.png
└─ screenshot-fullpage-20260909-152135-108.png
```

日時はPCのローカル時刻です。同名の場合はブラウザが連番を付けるため、既存ファイルを上書きしません。拡張から保存ダイアログは要求しませんが、ブラウザ設定や管理ポリシーによっては表示される場合があります。

アイコンのバッジは `…` が処理中、`↓` がダウンロード開始、`!` が失敗です。結果の詳細はアイコンを押して確認できます。`↓` は保存完了を保証する表示ではありません。保存の完了や中断はブラウザのダウンロード一覧（Windows は Ctrl + J）で確認してください。

## ショートカットの変更

ポップアップの「ショートカットを変更」、または以下の画面で変更できます。

- Chrome: `chrome://extensions/shortcuts`
- Edge: `edge://extensions/shortcuts`

他の拡張やOSと競合すると初期ショートカットが登録されないことがあります。ポップアップに「未設定」と出た場合は、この画面で割り当ててください。ポップアップには実際の割り当てが表示されます。

## 撮影方式と制約

- **表示領域**: `chrome.tabs.captureVisibleTab()` を使い、現在のスクロール位置で見えているページ部分を保存します。
- **ページ全体**: 撮影するタブに `chrome.debugger` で一時接続し、`Page.getLayoutMetrics` の `cssContentSize` を `Page.captureScreenshot` の `clip` に指定します。横方向・縦方向の画面外も含みます。`captureBeyondViewport: true` で撮影し、成功・失敗どちらの場合も切断を試みます。ページのスクロール位置やウィンドウサイズは変更しません。
- 全体撮影中、ブラウザ上部にデバッグ接続の通知が出ます。開発者ツールや別のデバッグ拡張と競合する場合は、それらを閉じてから撮影してください。
- 遅延読み込み画像は先にスクロールして読み込んでください。無限スクロールで未取得の内容、仮想リストでDOMに存在しない行、独立したスクロール枠の内部全体は自動展開しません。
- 非常に長いページは、ブラウザの画像サイズ・メモリ制限により失敗する場合があります。その場合は表示領域の撮影を利用してください。
- 動画・アニメーション・固定要素・動的レイアウトの写り方は、ブラウザのレンダリングに依存します。
- ブラウザの内部ページ、拡張ストア、PDFビューアーなどは撮影方式によって制限があります。まず通常の HTTP / HTTPS ページで使用してください。ローカルHTMLは拡張の詳細画面で「ファイルの URL へのアクセスを許可する」を有効にします。
- 連打による重複処理を防ぎます。表示領域の撮影はAPIの回数制限に合わせて600ミリ秒以上の間隔が必要です。

## 権限とデータ

| 権限 | 用途 |
| --- | --- |
| activeTab | ユーザー操作時のタブで表示領域を撮影 |
| downloads | PNGをダウンロードフォルダへ保存 |
| debugger | ページ全体のキャプチャ |
| storage | 直近の実行結果をブラウザのセッション内に保持 |

`debugger` は強い権限で、インストール時にブラウザが警告を表示します。撮影操作時だけ使用します。外部サーバーへの通信、解析サービス、常駐コンテンツスクリプトはありません。画像はダウンロードAPIに渡し、履歴ストレージには保存しません。

## 検証

Node.js 18 以降で、外部依存なしに実行できます。

```powershell
npm.cmd test
npm.cmd run check
```

自動テストではAPIをモックし、撮影モードの分離、対象ウィンドウ、CSS寸法、デバッグ接続の後始末、連打・並行実行、保存エラーを検証します。実ブラウザでの画像品質は以下で確認してください。

1. `tests/fixture.html` をブラウザで開き、ローカルファイルアクセスを許可します。
2. ページ途中までスクロールし、表示領域を撮影します。画像にブラウザ外枠や画面外の先頭・末尾がないことを確認します。
3. 同じ位置でページ全体を撮影します。画像に「START」「END」と右端のマーカーが含まれ、元のスクロール位置が保たれることを確認します。
4. ブラウザのズームを80%・125%に変更して両方撮影し、切れや余白を確認します。
5. 両方のポップアップボタンとショートカットを試します。異なるウィンドウでも対象が正しいことを確認します。
6. 全体撮影後にデバッグ通知が消えること、失敗時にポップアップに理由が出ることを確認します。

## 公式リファレンス

- [Tabs API / captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
- [Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [CDP Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)
- [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
