# TxPPIE corporate website

TxPPIEのコーポレートサイトです。編集用ソース、静的アセット、GitHub Pagesの公開物を分離して管理します。

## フォルダ構成

```text
src/      HTML・CSS・JavaScript・ニュースデータなどの編集元
public/   画像・アイコン・CNAMEなど無加工で配信するファイル
scripts/  ビルドと検査スクリプト
docs/     自動生成されるGitHub Pages公開物
```

外部依存パッケージはありません。ビルドはNode.jsの標準機能だけで動きます。

## ローカル確認

```sh
npm install
npm run dev
```

ブラウザで `http://localhost:4173` を開いてください。主要な編集対象は `src/index.html`、`src/styles.css`、`src/script.js` です。

## ビルドと確認

```sh
npm run build
npm run check
npm run audit:browser
npm run preview
```

`docs/` には公開に必要なファイルと、GitHub Pages用の `CNAME` / `.nojekyll` だけが出力されます。

`npm run audit:browser` は、Chromeを使って主要テンプレートを320pxから1440pxまで実表示し、横スクロール、画像、JavaScript、表示アニメーション、モバイルメニュー、ページ内リンク、JavaScript無効時の表示を検査します。macOS以外では `CHROME_BIN` にChromeの実行ファイルを指定してください。

## GitHub Pages への公開

`main` ブランチへの push で `.github/workflows/deploy.yml` が起動し、ビルドした `docs/` を公開します。GitHubの Settings → Pages の Source は「GitHub Actions」を選択してください。カスタムドメインは `public/CNAME` で管理します。

独自ドメイン直下ではなくサブパス配下（`https://<user>.github.io/<repo>/` など）へ公開する場合は、参照パスが自動で調整されます。公開先のURLはワークフローが判定するため、設定は不要です。

## 更新時の確認箇所

- ニュースの一覧データは `src/news/news-data.json` に集約しています。記事ページは `src/news/<記事ID>/index.html` にあります。
- 英語版は `src/en/` にあります。日本語版と同じく、トップ、会社概要、VoiceAtlas、ニュース、サイトポリシーを個別ページで管理します。
- **このリポジトリは公開されています。未発表の人事・提携などの情報をコミットしないでください。**メンバーカードは公表後に追加します。`src/script.js` 冒頭の `OPTIONAL_MEMBER_VISIBILITY` を `true` にしたカードだけが公開され、`false` のものはビルド時にHTML・画像ごと出力から除かれますが、これは配信物を守る仕組みであって、ソースの内容は誰でも読めます。
- 会社情報・所在地・連絡先を変更する場合は、会社概要、ポリシー、全ページ共通フッターも同時に更新してください。
- SNS共有画像は `public/assets/og-txppie.png`（1200×630px）です。
