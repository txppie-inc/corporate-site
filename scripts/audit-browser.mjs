import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = Number(process.env.AUDIT_PORT || 4187);
const debuggingPort = Number(process.env.AUDIT_DEBUG_PORT || 9224);
const baseUrl = `http://127.0.0.1:${port}`;
const defaultPaths = [
  "/",
  "/company/",
  "/service/",
  "/news/",
  "/news/2026-05-26-ecosystem-link-50/",
  "/site-policy/",
  "/en/",
  "/en/company/",
  "/en/news/",
  "/en/service/",
  "/en/site-policy/",
  "/audit-missing-page/"
];
const defaultViewports = [
  { width: 320, height: 800 },
  { width: 375, height: 900 },
  { width: 820, height: 1000 },
  { width: 1440, height: 1100 }
];
const paths = process.env.AUDIT_PATHS ? process.env.AUDIT_PATHS.split(",") : defaultPaths;
const screenshotDirectory = process.env.AUDIT_SCREENSHOT_DIR
  ? path.resolve(projectRoot, process.env.AUDIT_SCREENSHOT_DIR)
  : null;
const requestedWidths = process.env.AUDIT_WIDTHS?.split(",").map(Number).filter(Number.isFinite);
const viewports = requestedWidths
  ? requestedWidths.map((width) => defaultViewports.find((viewport) => viewport.width === width) || {
      width,
      height: width <= 400 ? 900 : width <= 820 ? 1000 : 1100
    })
  : defaultViewports;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Preview server did not start.");
}

async function waitForChrome() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json`);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error("Chrome debugging endpoint did not start.");
}

const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "txppie-browser-audit-"));
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: projectRoot,
  env: { ...process.env, SITE_ROOT: "docs", PORT: String(port) },
  stdio: "ignore"
});
let chrome;

try {
  await waitForServer();
  chrome = spawn(chromeBinary, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    "about:blank"
  ], { stdio: "ignore" });

  const targets = await waitForChrome();
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("Chrome page target was not found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  const eventWaiters = new Map();
  let runtimeErrors = [];

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }

    if (message.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(message.params.exceptionDetails.text);
    }

    const waiters = eventWaiters.get(message.method);
    if (waiters?.length) waiters.shift()(message.params);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const nextEvent = (method, timeout = 10000) => new Promise((resolve, reject) => {
    const waiters = eventWaiters.get(method) || [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
    waiters.push((params) => {
      clearTimeout(timer);
      resolve(params);
    });
    eventWaiters.set(method, waiters);
  });

  await send("Page.enable");
  await send("Runtime.enable");

  const issues = [];
  for (const pathname of paths) {
    console.log(`Auditing ${pathname}`);
    for (const viewport of viewports) {
      runtimeErrors = [];
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 820
      });

      const loaded = nextEvent("Page.domContentEventFired");
      const navigation = await send("Page.navigate", { url: `${baseUrl}${pathname}` });
      if (navigation.errorText) {
        issues.push(`${pathname} @ ${viewport.width}px: ${navigation.errorText}`);
        continue;
      }
      await loaded;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const readyState = await send("Runtime.evaluate", {
          returnByValue: true,
          expression: "document.readyState"
        });
        if (readyState.result.value === "complete") break;
        await delay(100);
      }
      await delay(350);

      const result = await send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const interactionIssues = [];
          const menuButton = document.querySelector('[data-menu-button]');
          const mobileNav = document.querySelector('[data-mobile-nav]');
          const clippedHeadings = [...document.querySelectorAll('.issue-heading-line, .message-copy h2 span')]
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => element.textContent.trim());
          if (clippedHeadings.length) interactionIssues.push('clipped headings: ' + clippedHeadings.join(' / '));
          const languageSwitch = document.querySelector('.language-switch');
          if (languageSwitch) {
            const languageStyle = getComputedStyle(languageSwitch);
            const languageRect = languageSwitch.getBoundingClientRect();
            if (languageStyle.display === 'none' || languageStyle.visibility === 'hidden' || languageRect.left < 0 || languageRect.right > window.innerWidth) {
              interactionIssues.push('language switch is not fully visible');
            }
            const languageContentOverflows = languageSwitch.scrollWidth > languageSwitch.clientWidth + 1
              || [...languageSwitch.children].some((child) => {
                const rect = child.getBoundingClientRect();
                return rect.left < languageRect.left - 1 || rect.right > languageRect.right + 1 || rect.top < languageRect.top - 1 || rect.bottom > languageRect.bottom + 1;
              });
            if (languageContentOverflows) interactionIssues.push('language switch content overflows its capsule');
            if (languageSwitch.textContent.replace(/\\s/g, '') !== 'JPEN') {
              interactionIssues.push('language switch label is unclear');
            }
            const currentLanguage = languageSwitch.querySelector('[aria-current]');
            const expectedCurrent = document.documentElement.lang === 'en' ? 'EN' : 'JP';
            if (!currentLanguage || currentLanguage.textContent.trim() !== expectedCurrent) {
              interactionIssues.push('language switch does not mark the current language');
            }
            if (window.innerWidth <= 820 && menuButton) {
              const menuRect = menuButton.getBoundingClientRect();
              if (languageRect.right > menuRect.left) interactionIssues.push('language switch overlaps the menu button');
            }
          } else if (!document.body.classList.contains('error-page')) {
            interactionIssues.push('language switch is missing');
          }
          if (window.innerWidth <= 820 && menuButton && mobileNav) {
            if (menuButton.getAttribute('aria-expanded') !== 'false' || !mobileNav.inert || mobileNav.getAttribute('aria-hidden') !== 'true') {
              interactionIssues.push('mobile menu has an invalid initial state');
            }
            menuButton.click();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (menuButton.getAttribute('aria-expanded') !== 'true' || mobileNav.inert || mobileNav.getAttribute('aria-hidden') !== 'false' || !mobileNav.contains(document.activeElement)) {
              interactionIssues.push('mobile menu did not open accessibly');
            }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (menuButton.getAttribute('aria-expanded') !== 'false' || !mobileNav.inert || mobileNav.getAttribute('aria-hidden') !== 'true' || document.activeElement !== menuButton) {
              interactionIssues.push('mobile menu did not close accessibly with Escape');
            }
          } else if (window.innerWidth > 820 && menuButton && getComputedStyle(menuButton).display !== 'none') {
            interactionIssues.push('mobile menu button is visible on desktop');
          }

          const samePageLink = [...document.querySelectorAll('a[href^="#"]')]
            .find((link) => link.hash.length > 1 && document.getElementById(decodeURIComponent(link.hash.slice(1))));
          if (samePageLink) {
            samePageLink.click();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (location.hash !== samePageLink.hash) interactionIssues.push('same-page link did not update the URL hash');
            history.replaceState(null, '', location.pathname + location.search);
          }

          const step = Math.max(500, window.innerHeight * 0.8);
          for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
            window.scrollTo(0, y);
            window.dispatchEvent(new Event('scroll'));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }
          window.scrollTo(0, document.documentElement.scrollHeight);
          window.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.race([
            Promise.all([...document.images]
              .filter((image) => image.src)
              .map((image) => image.decode?.().catch(() => undefined))),
            new Promise((resolve) => setTimeout(resolve, 1200))
          ]);
          await new Promise((resolve) => setTimeout(resolve, 350));
          // Lazy-loaded images and web fonts can change the page height after the first pass.
          for (let attempt = 0; attempt < 4; attempt += 1) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            window.dispatchEvent(new Event('scroll'));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) break;
          }
          const root = document.documentElement;
          const inlineScrollBehavior = root.style.scrollBehavior;
          root.style.scrollBehavior = 'auto';
          document.activeElement?.blur();
          window.scrollTo(0, 0);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.scrollTo(999999, 0);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const horizontalScroll = Math.round(window.scrollX);
          window.scrollTo(0, 0);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          root.style.scrollBehavior = inlineScrollBehavior;
          const brokenImages = [...document.images]
            .filter((image) => image.src && (!image.complete || image.naturalWidth === 0))
            .map((image) => image.src);
          const hiddenReveals = [...document.querySelectorAll('.reveal')]
            .filter((element) => getComputedStyle(element).opacity === '0')
            .map((element) => ({
              className: element.className,
              top: Math.round(element.getBoundingClientRect().top),
              pageTop: Math.round(element.getBoundingClientRect().top + window.scrollY)
            }));
          const unnamedControls = [...document.querySelectorAll('a[href], button')]
            .filter((element) => {
              const text = element.textContent.trim();
              const label = element.getAttribute('aria-label');
              const imageAlt = element.querySelector('img')?.alt;
              return !text && !label && !imageAlt;
            })
            .map((element) => element.outerHTML.slice(0, 120));
          const overflowingElements = root.scrollWidth - root.clientWidth > 1
            ? [...document.body.querySelectorAll('*')]
                .map((element) => ({ element, rect: element.getBoundingClientRect() }))
                .filter(({ rect }) => rect.right > root.clientWidth + 1 || rect.left < -1)
                .sort((a, b) => (b.rect.right - root.clientWidth) - (a.rect.right - root.clientWidth))
                .slice(0, 8)
                .map(({ element, rect }) => ({
                  element: element.outerHTML.slice(0, 140),
                  left: Math.round(rect.left),
                  right: Math.round(rect.right),
                  width: Math.round(rect.width)
                }))
            : [];

          return {
            statusTitle: document.title,
            overflow: root.scrollWidth - root.clientWidth,
            horizontalScroll,
            overflowingElements,
            brokenImages,
            hiddenReveals,
            unnamedControls,
            interactionIssues
          };
        })()`
      });

      const audit = result.result.value;
      const label = `${pathname} @ ${viewport.width}px`;
      if (screenshotDirectory) {
        const screenshot = await send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 78,
          captureBeyondViewport: process.env.AUDIT_SCREENSHOT_VIEWPORT !== "1"
        });
        const pageName = pathname === "/" ? "home" : pathname.replace(/^\/+|\/+$/g, "").replaceAll("/", "-");
        await writeFile(path.join(screenshotDirectory, `${pageName}-${viewport.width}.jpg`), Buffer.from(screenshot.data, "base64"));
      }
      if (audit.horizontalScroll > 1) issues.push(`${label}: horizontal scroll by ${audit.horizontalScroll}px (visual overflow ${audit.overflow}px); ${JSON.stringify(audit.overflowingElements)}`);
      const unavailableImages = [];
      for (const imageUrl of audit.brokenImages) {
        try {
          const response = await fetch(imageUrl);
          if (!response.ok) unavailableImages.push(`${imageUrl} (${response.status})`);
        } catch {
          unavailableImages.push(imageUrl);
        }
      }
      if (unavailableImages.length) issues.push(`${label}: broken images ${unavailableImages.join(", ")}`);
      if (audit.hiddenReveals.length) issues.push(`${label}: reveal elements remained hidden ${JSON.stringify(audit.hiddenReveals)}`);
      if (audit.unnamedControls.length) issues.push(`${label}: unnamed controls ${audit.unnamedControls.join(", ")}`);
      if (audit.interactionIssues.length) issues.push(`${label}: interaction issues ${audit.interactionIssues.join(", ")}`);
      for (const error of runtimeErrors) issues.push(`${label}: JavaScript exception ${error}`);
    }
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true
  });
  await send("Emulation.setScriptExecutionDisabled", { value: true });
  const noScriptLoaded = nextEvent("Page.domContentEventFired");
  await send("Page.navigate", { url: `${baseUrl}/?noscript-audit=1` });
  await noScriptLoaded;
  const noScriptResult = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      hiddenReveals: [...document.querySelectorAll('.reveal')].filter((element) => getComputedStyle(element).opacity === '0').length,
      menuButtonDisplay: getComputedStyle(document.querySelector('[data-menu-button]')).display,
      mobileNavDisplay: getComputedStyle(document.querySelector('[data-mobile-nav]')).display,
      mobileNavPosition: getComputedStyle(document.querySelector('[data-mobile-nav]')).position
    })`
  });
  const noScriptAudit = noScriptResult.result.value;
  if (noScriptAudit.hiddenReveals || noScriptAudit.menuButtonDisplay !== "none" || noScriptAudit.mobileNavDisplay === "none" || noScriptAudit.mobileNavPosition !== "static") {
    issues.push(`JavaScript-disabled fallback is invalid: ${JSON.stringify(noScriptAudit)}`);
  }
  await send("Emulation.setScriptExecutionDisabled", { value: false });

  socket.close();
  if (issues.length) {
    console.error(`Browser audit issues:\n${issues.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Browser-audited ${paths.length} page templates at ${viewports.length} viewport widths; no layout, image or JavaScript issues found.`);
  }
} finally {
  server.kill("SIGTERM");
  chrome?.kill("SIGTERM");
  if (chrome && chrome.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      delay(2000)
    ]);
  }
  await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
