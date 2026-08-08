# アクセス解析

本サイトは Cloudflare Web Analytics でアクセスを計測しています。このファイルは、
何をどう入れているか、運用上どこに注意が要るかをまとめたものです。

## 概要

| 項目 | 内容 |
|---|---|
| サービス | Cloudflare Web Analytics（Cloudflare, Inc.） |
| サイトトークン | `aac8da8284204ddb9a07cde023fc1166` |
| 読み込み元 | `https://static.cloudflareinsights.com/beacon.min.js` |
| 挿入対象 | 全HTMLページ（現在25ページ） |
| 挿入位置 | 各ページの `</head>` 直前 |
| Cookie | 使用しない |

トークンは現行サイト（`txp.co.jp`）と同一のものを引き継いでいます。計測を途切れさせない
ためで、新規に発行し直してはいません。

## なぜこの構成なのか

### Cloudflare Web Analytics を選んでいる理由

リニューアル前のサイトが既に使用しており、それを継続しています。Cookieを使わないため、
Cookie同意バナーを設けずに計測できます。

### ビルド時に挿入している理由

このサイトには共通パーツを差し込む仕組みがなく、25ページそれぞれが独立したHTMLです。
タグを手で貼ると、**1ページでも貼り忘れるとそのページへの直接流入が計測から漏れます**。
ニュース記事は検索や外部リンクから直接開かれることが多いため、実害が出ます。

そこでビルドスクリプトが全HTMLへ機械的に挿入する形にしています。新しいページを追加しても
自動で入ります。

なお現行サイトはReactのSPAで、タグが入っているのはトップと英語トップの2ファイルだけです。
静的サイトではこの方式が使えないため、上記の対応が必要になりました。

## 実装

[`scripts/build-site.mjs`](scripts/build-site.mjs) の `injectAnalytics()` が担当します。

```js
const ANALYTICS_TAG =
  '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ' +
  'data-cf-beacon=\'{"token": "aac8da8284204ddb9a07cde023fc1166"}\'></script>';
```

`docs/` 配下のHTMLを走査し、`</head>` の直前へ挿入します。**`</head>` を持たないHTMLが
あった場合はビルドを失敗させます。**計測漏れが静かに発生するより、ビルドを止めたほうが
安全なためです。

ビルド時に挿入したページ数がログに出ます。

```
Built 10 source entries and public assets in .../docs (analytics injected into 25 pages)
```

`src/` 側のHTMLにはタグを持たせていません。編集元にタグが入っていないのは意図的で、
挿入箇所を1つに保つためです。

## 収集される情報

Cloudflare Web Analytics は、閲覧数、参照元、利用端末やブラウザの種類など、個人を直接
特定しない形のアクセス情報を取得します。Cookieは使用せず、利用者を複数のサイトにまたがって
追跡する情報も収集しません。

詳細は [Cloudflare のプライバシーポリシー](https://www.cloudflare.com/privacypolicy/) を
参照してください。

## 利用者への開示

サイトポリシーの **06「アクセス解析について」** で開示しています。

- 日本語: `src/site-policy/index.html`
- 英語: `src/en/site-policy/index.html`

文面は現行サイトのサイトポリシーを踏襲しています。Cloudflareのプライバシーポリシーへの
リンクのみ追加しました。

本サイトから自動的に外部へ情報が送信されるのは、**現時点で Cloudflare Web Analytics だけ**
です。フォントは以前 Google Fonts から読み込んでいましたが、閲覧者の情報がGoogleへ渡るのを
避けるため自サイト配信へ切り替えました（`public/fonts/`）。この状態を保っている限り、
サイトポリシーの記載とサイトの実態は一致します。

**新しい外部サービス（埋め込み動画、地図、チャット、広告タグ等）を追加する場合は、
サイトポリシーの追記が必要かを必ず確認してください。**

## 運用上の注意

### 検証サイトのアクセスも計測される

`https://txppie-inc.github.io/corporate-site/` へのアクセスも、本番と同じトークンで
記録されます。Cloudflareのダッシュボードではホスト名で区別できるため、本番（`txp.co.jp`）
と切り分けて確認できます。

完全に分けたい場合は、検証用に別トークンを発行し、`BASE_PATH` の有無で切り替える実装に
変更する必要があります。

### 現行サイトと数値が混ざる

現行サイト（`txp.co.jp`、旧React版）も同じトークンを使っています。切り替えが完了するまで、
両サイトのアクセスが同一のダッシュボードに集計されます。

### CloudFront 移行時のCSP

CloudFrontでコンテンツセキュリティポリシー（CSP）を設定する場合、
**`https://static.cloudflareinsights.com` を `script-src` に許可しないとタグがブロック
されます。**

削除済みの `netlify.toml` に書かれていたCSPは `script-src 'self'` だったため、そのまま
流用すると計測が止まります。移行時に必ず見直してください。

## 変更するには

### トークンを差し替える

`scripts/build-site.mjs` の `ANALYTICS_TAG` を書き換えてビルドすれば、全ページに反映されます。

### 解析をやめる

`ANALYTICS_TAG` の挿入処理を外し、**サイトポリシー06の記載も併せて削除してください。**
実態と記載が食い違う状態を作らないようにします。

### 別の解析サービスに変える

Google Analytics 等はCookieを使用するため、サイトポリシーの記載変更に加え、Cookie同意の
取得が必要かどうかの検討が必要になります。Cloudflare Web Analytics と同じ扱いにはできません。

## 確認方法

配信されているページにタグが入っているかは、次で確認できます。

```sh
# ローカルのビルド出力（25 と出れば全ページに入っている）
grep -rlc cloudflareinsights docs --include='*.html' | wc -l

# 公開中のサイト（1 と出れば入っている）
curl -s https://txppie-inc.github.io/corporate-site/ | grep -c cloudflareinsights
```

計測データそのものは Cloudflare のダッシュボードで確認します。
