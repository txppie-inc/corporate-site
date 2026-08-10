import { access, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(projectRoot, "docs");
const siteOrigin = "https://txp.co.jp";
const htmlFiles = [];

async function collectHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectHtml(target);
    else if (entry.name.endsWith(".html")) htmlFiles.push(target);
  }
}

await collectHtml(siteRoot);

const issues = new Set();
const htmlByFile = new Map();
const canonicalUrls = new Set();
const stylesheet = await readFile(path.join(siteRoot, "styles.css"));
const stylesheetVersion = createHash("sha256").update(stylesheet).digest("hex").slice(0, 12);
const expectedStylesheetHref = `/styles.css?v=${stylesheetVersion}`;

function routeForFile(file) {
  const relative = path.relative(siteRoot, file).split(path.sep).join("/");
  if (relative === "index.html") return "/";
  return `/${relative.replace(/index\.html$/, "")}`;
}

function textContent(markup) {
  return markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

for (const file of htmlFiles) {
  htmlByFile.set(file, await readFile(file, "utf8"));
}

for (const file of htmlFiles) {
  const html = htmlByFile.get(file);
  const relativeFile = path.relative(siteRoot, file);

  if (!/<html\b[^>]*\blang="[^"]+"/i.test(html)) issues.add(`${relativeFile}: missing html lang`);
  if (!/<title>[^<]+<\/title>/i.test(html)) issues.add(`${relativeFile}: missing title`);
  if (!/<meta\b[^>]*name="description"[^>]*content="[^"]+"/i.test(html)) issues.add(`${relativeFile}: missing meta description`);
  if (!html.includes(`href="${expectedStylesheetHref}"`)) {
    issues.add(`${relativeFile}: stylesheet cache key is missing or stale`);
  }
  if (html.includes("ソリューション</a>")) {
    issues.add(`${relativeFile}: service navigation must use サービス consistently`);
  }
  const mobileNavigation = html.match(/<nav\b[^>]*id="mobile-navigation"[^>]*>([\s\S]*?)<\/nav>/i)?.[1];
  if (mobileNavigation && /\bhreflang=/.test(mobileNavigation)) {
    issues.add(`${relativeFile}: mobile navigation duplicates the persistent language switch`);
  }

  if (relativeFile !== "404.html") {
    const expectedCanonical = `${siteOrigin}${routeForFile(file)}`;
    const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
    if (!canonical) issues.add(`${relativeFile}: missing canonical link`);
    else if (canonical !== expectedCanonical) issues.add(`${relativeFile}: canonical ${canonical} should be ${expectedCanonical}`);
    if (canonicalUrls.has(canonical)) issues.add(`${relativeFile}: duplicate canonical ${canonical}`);
    canonicalUrls.add(canonical);
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  for (const id of new Set(ids)) {
    if (ids.filter((candidate) => candidate === id).length > 1) issues.add(`${relativeFile}: duplicate id #${id}`);
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\ssrc="[^"]+"/i.test(match[0]) && !/\ssrcset="[^"]+"/i.test(match[0])) issues.add(`${relativeFile}: image missing src or srcset`);
    if (!/\salt="[^"]*"/i.test(match[0])) issues.add(`${relativeFile}: image missing alt`);
    if (!/\swidth="\d+"/i.test(match[0]) || !/\sheight="\d+"/i.test(match[0])) {
      issues.add(`${relativeFile}: image missing intrinsic width or height`);
    }
  }

  for (const match of html.matchAll(/<a\b[^>]*\btarget="_blank"[^>]*>/gi)) {
    if (!/\brel="[^"]*noopener[^"]*"/i.test(match[0])) issues.add(`${relativeFile}: target=_blank link missing noopener`);
  }

  if (relativeFile.startsWith(`en${path.sep}`)) {
    if (!/<link\b[^>]*hreflang="ja"/i.test(html)) issues.add(`${relativeFile}: missing Japanese hreflang`);
    if (!/<link\b[^>]*hreflang="en"/i.test(html)) issues.add(`${relativeFile}: missing English hreflang`);
  }

  for (const match of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(match[1]);
    } catch {
      issues.add(`${relativeFile}: invalid JSON-LD`);
    }
  }

  for (const match of html.matchAll(/<time\b[^>]*datetime="([^"]+)"/gi)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(match[1]) || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) {
      issues.add(`${relativeFile}: invalid time datetime ${match[1]}`);
    }
  }

  for (const match of html.matchAll(/(?:href|src)="(\/[^\"]+)"/g)) {
    const [pathAndQuery, fragment] = match[1].split("#", 2);
    const urlPath = pathAndQuery.split("?")[0];
    if (!urlPath || urlPath.startsWith("//")) continue;

    let target = path.join(siteRoot, urlPath);
    if (urlPath.endsWith("/")) target = path.join(target, "index.html");

    try {
      await access(target);
    } catch {
      issues.add(`${relativeFile} -> ${urlPath}: missing local target`);
      continue;
    }

    if (fragment && target.endsWith(".html")) {
      const targetHtml = htmlByFile.get(target) ?? await readFile(target, "utf8");
      const escapedFragment = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\sid="${escapedFragment}"`).test(targetHtml)) {
        issues.add(`${relativeFile} -> ${urlPath}#${fragment}: missing anchor`);
      }
    }
  }
}

const sitemap = await readFile(path.join(siteRoot, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
for (const canonical of canonicalUrls) {
  if (!sitemapUrls.includes(canonical)) issues.add(`sitemap.xml: missing ${canonical}`);
}
for (const sitemapUrl of sitemapUrls) {
  if (!canonicalUrls.has(sitemapUrl)) issues.add(`sitemap.xml: URL has no canonical page ${sitemapUrl}`);
}
if (new Set(sitemapUrls).size !== sitemapUrls.length) issues.add("sitemap.xml: duplicate URLs");

const newsData = JSON.parse(await readFile(path.join(projectRoot, "src", "news", "news-data.json"), "utf8"));
const newsIndex = htmlByFile.get(path.join(siteRoot, "news", "index.html"));
const homePage = htmlByFile.get(path.join(siteRoot, "index.html"));
const englishNewsIndex = htmlByFile.get(path.join(siteRoot, "en", "news", "index.html"));
const englishHomePage = htmlByFile.get(path.join(siteRoot, "en", "index.html"));
for (let index = 0; index < newsData.length; index += 1) {
  const item = newsData[index];
  const previous = newsData[index - 1];
  if (previous && previous.date < item.date) issues.add(`news-data.json: ${item.slug} is out of descending date order`);
  if (item.display !== item.date.replaceAll("-", ".")) issues.add(`news-data.json: ${item.slug} display date does not match date`);

  const detailPath = path.join(siteRoot, "news", item.slug, "index.html");
  const detailPage = htmlByFile.get(detailPath);
  // 掲載先が外部にある記事は、一覧からそちらへ直接送るので自社ページを持たない。
  // 内容を載せる場所が他に無い記事だけ、受け皿として個別ページを用意する。
  if (item.source) {
    if (detailPage) issues.add(`${item.slug}: article page is unused because news-data.json has a source URL`);
  } else if (!detailPage) {
    issues.add(`news-data.json: missing article page for ${item.slug}`);
  }
  if (detailPage) {
    const matchingArticleDate = [...detailPage.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/gi)]
      .some((match) => match[1] === item.date && textContent(match[2]) === item.display);
    if (!matchingArticleDate) {
      issues.add(`${item.slug}: article date differs from news-data.json`);
    }
    const articleTitle = detailPage.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (!articleTitle || textContent(articleTitle) !== item.title) {
      issues.add(`${item.slug}: article title differs from news-data.json`);
    }
  }
  const japaneseNewsHref = item.source || `/news/${item.slug}/`;
  const japaneseStaticEntry = `<article class="is-static"><time datetime="${item.date}">${item.display}</time>`;
  if (item.listingLink === false) {
    if (!newsIndex.includes(japaneseStaticEntry)) {
      issues.add(`news/index.html: missing non-linked entry for ${item.slug}`);
    }
    if (newsIndex.includes(`href="${japaneseNewsHref}"`)) {
      issues.add(`news/index.html: non-linked entry still has a destination for ${item.slug}`);
    }
  } else if (!newsIndex.includes(`href="${japaneseNewsHref}"`)) {
    issues.add(`news/index.html: missing destination for ${item.slug}`);
  }
  if (index < 3 && item.listingLink !== false && !homePage.includes(`href="${japaneseNewsHref}"`)) {
    issues.add(`index.html: latest news destination is missing ${item.slug}`);
  }

  if (!englishNewsIndex.includes(`<time datetime="${item.date}">${item.display}</time>`)) {
    issues.add(`en/news/index.html: missing date for ${item.slug}`);
  }
  const englishStaticEntry = `<article class="is-static"><time datetime="${item.date}">${item.display}</time>`;
  if (item.listingLink === false && !englishNewsIndex.includes(englishStaticEntry)) {
    issues.add(`en/news/index.html: missing non-linked entry for ${item.slug}`);
  }
  if (item.listingLink === false && item.source && englishNewsIndex.includes(`href="${item.source}"`)) {
    issues.add(`en/news/index.html: non-linked entry still has a destination for ${item.slug}`);
  }
  if (item.listingLink !== false && item.source && !englishNewsIndex.includes(`href="${item.source}"`)) {
    issues.add(`en/news/index.html: missing source for ${item.slug}`);
  }
  if (index < 3) {
    if (!englishHomePage.includes(`<time datetime="${item.date}">${item.display}</time>`)) {
      issues.add(`en/index.html: latest news date is missing ${item.slug}`);
    }
    if (item.listingLink !== false && item.source && !englishHomePage.includes(`href="${item.source}"`)) {
      issues.add(`en/index.html: latest news source is missing ${item.slug}`);
    }
  }
}

const newsCountsByYear = new Map();
for (const item of newsData) {
  const year = item.date.slice(0, 4);
  newsCountsByYear.set(year, [...(newsCountsByYear.get(year) || []), item]);
}
for (const [year, items] of newsCountsByYear) {
  if (!englishNewsIndex.includes(`<a href="#year-${year}">${year} <span>${String(items.length).padStart(2, "0")}</span></a>`)
      && !englishNewsIndex.includes(`<a class="is-current" href="#year-${year}">${year} <span>${String(items.length).padStart(2, "0")}</span></a>`)) {
    issues.add(`en/news/index.html: ${year} year count should be ${items.length}`);
  }
  if (!englishNewsIndex.includes(`<span>${items.length} ARTICLES</span>`)) {
    issues.add(`en/news/index.html: ${year} article heading count should be ${items.length}`);
  }
}

if (issues.size > 0) {
  console.error(`Site validation issues:\n${[...issues].join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${htmlFiles.length} HTML files; links, anchors, metadata, news synchronization and accessibility basics are valid.`);
}
