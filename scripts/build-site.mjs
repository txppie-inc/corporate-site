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

// Unpublished team-member cards must never reach the production build: the
// hidden attribute toggled by script.js at runtime is a display preference,
// not an access control, so anything gated by OPTIONAL_MEMBER_VISIBILITY is
// stripped from the shipped HTML (and its photo) here at build time.
// script.js owns OPTIONAL_MEMBER_VISIBILITY (it must run in the browser as a
// plain object literal); it is parsed from the built script.js so there is a
// single source of truth for publish/unpublish state.
const builtScript = await readFile(path.join(outputRoot, "script.js"), "utf8");
const visibilityMatch = builtScript.match(/OPTIONAL_MEMBER_VISIBILITY\s*=\s*(\{[\s\S]*?\});/);
if (!visibilityMatch) {
  throw new Error("Unable to locate OPTIONAL_MEMBER_VISIBILITY in script.js");
}
const OPTIONAL_MEMBER_VISIBILITY = new Function(`return (${visibilityMatch[1]});`)();
const unpublishedMembers = Object.entries(OPTIONAL_MEMBER_VISIBILITY)
  .filter(([, visible]) => !visible)
  .map(([member]) => member);

async function stripUnpublishedMembers(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await stripUnpublishedMembers(target);
    } else if (entry.name.endsWith(".html")) {
      let html = await readFile(target, "utf8");
      let changed = false;
      for (const member of unpublishedMembers) {
        const articlePattern = new RegExp(
          `<article\\b[^>]*\\bdata-optional-member="${member}"[^>]*>[\\s\\S]*?<\\/article>`,
          "g"
        );
        const strippedHtml = html.replace(articlePattern, "");
        if (strippedHtml !== html) {
          html = strippedHtml;
          changed = true;
        }
      }
      if (changed) await writeFile(target, html);
    }
  }
}

await stripUnpublishedMembers(outputRoot);

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

// Photos for unpublished members must not be copied into the deployed site.
for (const member of unpublishedMembers) {
  await rm(path.join(outputRoot, "img", `${member}.webp`), { force: true });
}

// 非公開メンバーはHTMLからも画像からも取り除いてあるので、識別子だけを配信物へ残す理由がない。
// 残すと「その名前の人物が未公開で控えている」ことがscript.jsから読み取れてしまう。
// 編集用の src/script.js は全員分を保持したまま、出力には公開中のものだけを書き出す。
const publishedVisibility = Object.fromEntries(
  Object.entries(OPTIONAL_MEMBER_VISIBILITY).filter(([, visible]) => visible)
);
await writeFile(
  path.join(outputRoot, "script.js"),
  builtScript.replace(visibilityMatch[1], () => JSON.stringify(publishedVisibility, null, 2))
);

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
