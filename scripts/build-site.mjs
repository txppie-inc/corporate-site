import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const publicRoot = path.join(projectRoot, "public");
const outputRoot = path.join(projectRoot, "docs");

// 公開に必要なファイルだけを選び、PDF・開発サーバー・編集用ファイルを配信対象から外す。
const publicEntries = [
  "404.html",
  "company",
  "en",
  "fonts.css",
  "index.html",
  "news",
  "script.js",
  "service",
  "site-policy",
  "styles.css"
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const entry of publicEntries) {
  await cp(path.join(sourceRoot, entry), path.join(outputRoot, entry), {
    recursive: true
  });
}

// ヘッダーとフッターは全ページ共通なので src/partials に1枚ずつ置き、ここで差し込む。
// 各ページに実体をコピーしていた頃は、同じはずの記述が少しずつずれて
// aria-current の抜けや英語版だけ問い合わせ欄が無いといった不具合が生まれていた。
// ページごとに変わるのは現在地マーカーと言語切替のリンク先だけで、どちらもパスから決まる。
const partials = {};
for (const lang of ["ja", "en"]) {
  for (const kind of ["header", "footer"]) {
    partials[`${kind}.${lang}`] = (
      await readFile(path.join(sourceRoot, "partials", `${kind}.${lang}.html`), "utf8")
    ).trimEnd();
  }
}

function pageContext(route) {
  const english = route === "/en/" || route.startsWith("/en/");
  const root = english ? "/en/" : "/";
  const isHome = route === root;
  const section = route.slice(root.length).split("/")[0];
  const inNav = ["company", "service", "news"].includes(section);
  return {
    lang: english ? "en" : "ja",
    root,
    // トップページではブランドとモバイルナビ先頭がページ内アンカーになる。
    home: isHome ? "#top" : root,
    scrolled: !isHome,
    // フッターの「PAGE TOP」は各ページ自身の先頭要素を指す。
    pageTop: isHome ? "#top" : section === "site-policy" ? "#policy-top" : "#main",
    // ヘッダーのナビにはサイトポリシーが無く、トップはページ内アンカー。
    // フッターには両方あり、トップは絶対パスで並んでいる。指す先が違うので分けて持つ。
    currentHeader: isHome ? "#top" : inNav ? `${root}${section}/` : null,
    currentFooter: isHome ? root : inNav || section === "site-policy" ? `${root}${section}/` : null,
    alt: isHome ? (english ? "/" : "/en/") : english ? `/${section}/` : `/en/${section}/`
  };
}

function renderPartial(kind, context) {
  const html = partials[`${kind}.${context.lang}`]
    .replaceAll("{{ALT}}", context.alt)
    .replaceAll("{{HOME}}", context.home)
    .replaceAll("{{ROOT}}", context.root)
    .replaceAll("{{PAGETOP}}", context.pageTop)
    .replaceAll("{{SCROLLED}}", context.scrolled ? " is-scrolled" : "");
  const current = kind === "header" ? context.currentHeader : context.currentFooter;
  if (!current) return html;
  // 現在地の印。ヘッダーは class を href の前、フッターは後ろに置く既存の書き方に揃える。
  // href だけを持つリンク＝ナビ項目に限定する。ブランドロゴは aria-label を伴うため対象外。
  return html.replaceAll(`<a href="${current}">`, () =>
    kind === "header"
      ? `<a class="is-current" href="${current}" aria-current="page">`
      : `<a href="${current}" class="is-current" aria-current="page">`
  );
}

async function applyPartials(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await applyPartials(target);
    } else if (entry.name.endsWith(".html")) {
      const html = await readFile(target, "utf8");
      if (!html.includes("<!--#header-->")) continue;
      const route = `/${path.relative(outputRoot, target).replace(/index\.html$/, "")}`;
      const context = pageContext(route);
      await writeFile(
        target,
        html
          .replace("<!--#header-->", () => renderPartial("header", context))
          .replace("<!--#footer-->", () => renderPartial("footer", context))
      );
    }
  }
}

await applyPartials(outputRoot);

// CSSの内容からバージョンを生成し、更新時に古いスタイルがブラウザへ残らないようにする。
const stylesheet = await readFile(path.join(sourceRoot, "styles.css"));
const stylesheetVersion = createHash("sha256").update(stylesheet).digest("hex").slice(0, 12);

async function versionStylesheets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await versionStylesheets(target);
    } else if (entry.name.endsWith(".html")) {
      const html = await readFile(target, "utf8");
      const versionedHtml = html.replaceAll(
        /\/styles\.css\?v=[^"']+/g,
        `/styles.css?v=${stylesheetVersion}`
      );
      await writeFile(target, versionedHtml);
    }
  }
}

await versionStylesheets(outputRoot);

// アクセス解析。Cookieを使わないCloudflare Web Analyticsを全ページに入れる。
// 共通パーツを差し込む仕組みがないため、ここで一括して挿入する。1ページでも
// 抜けるとそのページへの直接流入が計測から漏れるので、head の無いHTMLは失敗させる。
// Cloudflareのダッシュボードが出すスニペットをそのまま使う。差し替える場合も原文のまま貼る。
const ANALYTICS_TAG =
  `<!-- Cloudflare Web Analytics -->` +
  `<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' ` +
  `data-cf-beacon='{"token": "3c1ad1e05d054c37aed076b2865554ec"}'></script>` +
  `<!-- End Cloudflare Web Analytics -->`;

async function injectAnalytics(directory) {
  let injected = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      injected += await injectAnalytics(target);
    } else if (entry.name.endsWith(".html")) {
      const html = await readFile(target, "utf8");
      if (!html.includes("</head>")) {
        throw new Error(`Unable to inject analytics: ${target} has no </head>`);
      }
      await writeFile(target, html.replace("</head>", `${ANALYTICS_TAG}</head>`));
      injected += 1;
    }
  }
  return injected;
}

const analyticsPages = await injectAnalytics(outputRoot);

// Images, icons and GitHub Pages metadata are copied without transformation.
for (const entry of await readdir(publicRoot)) {
  await cp(path.join(publicRoot, entry), path.join(outputRoot, entry), {
    recursive: true
  });
}

// Editorial source data is validated during the build but is not a public asset.
await rm(path.join(outputRoot, "news", "news-data.json"), { force: true });

// 本番の txp.co.jp はドメイン直下なので、HTMLはルート絶対パス（/assets/... など）で
// 参照している。GitHub Pages のプロジェクトサイトのようにサブパス配下へ検証公開する
// ときだけ BASE_PATH でその参照をずらす。BASE_PATH 未指定＝本番と同じ出力。
const basePath = (process.env.BASE_PATH ?? "").trim().replace(/\/+$/, "");
if (basePath && !basePath.startsWith("/")) {
  throw new Error(`BASE_PATH must start with "/" (received: ${process.env.BASE_PATH})`);
}

async function applyBasePath(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await applyBasePath(target);
    } else if (entry.name.endsWith(".html")) {
      const html = await readFile(target, "utf8");
      // href="//example.com" のプロトコル相対URLは書き換えない。
      await writeFile(target, html.replaceAll(/\b(href|src)="\/(?!\/)/g, `$1="${basePath}/`));
    } else if (entry.name.endsWith(".css")) {
      const css = await readFile(target, "utf8");
      await writeFile(
        target,
        css
          // 表示制御に使っている [href="/company/"] のような属性セレクタもURLに追随させる。
          .replaceAll(/\[href="\/(?!\/)/g, `[href="${basePath}/`)
          // 自サイトから配信するフォント（url(/fonts/...)）も同様にずらす。
          .replaceAll(/url\(\/(?!\/)/g, `url(${basePath}/`)
      );
    }
  }
}

if (basePath) {
  await applyBasePath(outputRoot);
  // 独自ドメインは本番リポジトリのものなので、サブパス公開では CNAME を出さない。
  await rm(path.join(outputRoot, "CNAME"), { force: true });
  console.log(`Rewrote root-absolute references to ${basePath}/ and removed CNAME`);
}

console.log(
  `Built ${publicEntries.length} source entries and public assets in ${outputRoot}` +
    ` (analytics injected into ${analyticsPages} pages)`
);
