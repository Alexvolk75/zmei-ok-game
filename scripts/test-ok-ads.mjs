import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const GAME_URL = "https://ok.ru/app/512004943697";
const COOKIE_FILE = "C:\\Users\\Cyber\\Desktop\\cookie\\0005_79531324643.txt";
const OUT_DIR = path.join(process.cwd(), "ok-test-results");

const profiles = [
  {
    name: "android-442-nexus4",
    use: {
      viewport: { width: 384, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 4.4.2; Nexus 4 Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/34.0.1847.114 Mobile Safari/537.36",
    },
  },
  {
    name: "ipad-ios6",
    use: {
      viewport: { width: 768, height: 1024 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5376e Safari/8536.25",
    },
  },
  {
    name: "iphone-ios6",
    use: {
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5376e Safari/8536.25",
    },
  },
  {
    name: "lumia-920-wp8",
    use: {
      viewport: { width: 384, height: 640 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch; NOKIA; Lumia 920)",
    },
  },
];

function loadCookies() {
  const raw = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : "Lax",
  }));
}

async function probeProfile(profile) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...profile.use,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    extraHTTPHeaders: { "Accept-Language": "ru-RU,ru;q=0.9" },
  });

  await context.addCookies(loadCookies());
  const page = await context.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

  let adStatus = null;
  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame()) return;
    try {
      await frame.waitForFunction(() => typeof window.__vkEntryAd !== "undefined" || document.getElementById("adStatus"), { timeout: 15000 }).catch(() => {});
      adStatus = await frame.evaluate(() => {
        const el = document.getElementById("adStatus");
        return {
          adStatus: el ? el.textContent : null,
          entryAd: window.__vkEntryAd || null,
          env: window.__vkAdEnv || null,
          hasVkBridge: typeof window.vkBridge !== "undefined",
          hasFapi: typeof window.FAPI !== "undefined",
        };
      });
    } catch {}
  });

  await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(12000);

  const mainInfo = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    loggedIn: !document.body?.innerText?.includes("Войти") && !document.body?.innerText?.includes("войти в ОК"),
  }));

  if (!adStatus) {
    for (const frame of page.frames()) {
      try {
        const info = await frame.evaluate(() => {
          const el = document.getElementById("adStatus");
          if (!el && typeof window.__vkEntryAd === "undefined") return null;
          return {
            adStatus: el ? el.textContent : null,
            entryAd: window.__vkEntryAd || null,
            env: window.__vkAdEnv || null,
            hasVkBridge: typeof window.vkBridge !== "undefined",
            hasFapi: typeof window.FAPI !== "undefined",
            href: location.href,
          };
        });
        if (info) {
          adStatus = info;
          break;
        }
      } catch {}
    }
  }

  const shot = path.join(OUT_DIR, `${profile.name}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  await browser.close();

  return {
    profile: profile.name,
    userAgent: profile.use.userAgent,
    mainInfo,
    adStatus,
    logs: logs.filter((l) => /реклам|ads|FAPI|vkBridge|error|ShowNative/i.test(l)).slice(-20),
    screenshot: shot,
  };
}

mkdirSync(OUT_DIR, { recursive: true });

console.log("Installing/using Playwright chromium if needed...");
const results = [];
for (const p of profiles) {
  console.log(`\n=== ${p.name} ===`);
  try {
    const r = await probeProfile(p);
    results.push(r);
    console.log(JSON.stringify({ profile: r.profile, mainInfo: r.mainInfo, adStatus: r.adStatus, logs: r.logs }, null, 2));
  } catch (e) {
    results.push({ profile: p.name, error: String(e) });
    console.error(p.name, e.message || e);
  }
}

const summaryPath = path.join(OUT_DIR, "summary.json");
await import("node:fs/promises").then((fs) => fs.writeFile(summaryPath, JSON.stringify(results, null, 2)));
console.log(`\nSaved: ${summaryPath}`);
