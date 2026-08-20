import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

function parseCookies(raw: string) {
  let cleaned = raw.trim().replace(/^cookie:\s*/i, "");
  if (!cleaned.includes("=")) {
    return [{ name: "postman.sid", value: cleaned }];
  }

  const cookieMap = new Map<string, string>();
  for (const pair of cleaned.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    let value = pair.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name) cookieMap.set(name, value);
  }

  return Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value }));
}

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let pageInstance: Page | null = null;
let currentCookie: string = "";
let currentWorkspaceUrl: string = "";
let isNavigating = false;
let requestQueue: Promise<void> = Promise.resolve();

export async function cleanupBrowser(): Promise<void> {
  if (pageInstance) {
    try {
      await pageInstance.close();
    } catch {
      // ignore
    }
    pageInstance = null;
  }
  if (contextInstance) {
    try {
      await contextInstance.close();
    } catch {
      // ignore
    }
    contextInstance = null;
  }
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // ignore
    }
    browserInstance = null;
  }
  currentCookie = "";
  currentWorkspaceUrl = "";
}

const handleExit = async (signal?: string) => {
  try {
    await Promise.race([cleanupBrowser(), new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    // ignore
  } finally {
    if (signal) {
      process.exit(0);
    }
  }
};
process.once("beforeExit", () => handleExit());
process.once("SIGINT", () => handleExit("SIGINT"));
process.once("SIGTERM", () => handleExit("SIGTERM"));

export async function getOrInitPostmanPage(
  cookieStr: string,
  workspaceUrl?: string
): Promise<Page> {
  const targetUrl = workspaceUrl || "https://go.postman.co/home?sideView=agentMode";

  if (pageInstance && !pageInstance.isClosed() && currentCookie === cookieStr) {
    if (currentWorkspaceUrl !== targetUrl) {
      currentWorkspaceUrl = targetUrl;
      await pageInstance.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await pageInstance.waitForSelector('[contenteditable="true"]', { timeout: 15000 });
    }
    return pageInstance;
  }

  if (isNavigating) {
    while (isNavigating) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (pageInstance && !pageInstance.isClosed()) return pageInstance;
  }

  isNavigating = true;
  try {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
      contextInstance = null;
      pageInstance = null;
    }

    currentCookie = cookieStr;
    currentWorkspaceUrl = targetUrl;

    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    contextInstance = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
    });

    const parsed = parseCookies(cookieStr);
    const domainMatches = targetUrl.match(/https?:\/\/([^/?#]+)/i);
    const hostDomain = domainMatches ? `.${domainMatches[1]}` : ".postman.co";

    const domains = Array.from(
      new Set([
        ".postman.co",
        ".postman.com",
        ".getpostman.com",
        "identity.getpostman.com",
        hostDomain,
      ])
    );

    for (const d of domains) {
      await contextInstance.addCookies(
        parsed.map((c) => ({
          name: c.name,
          value: c.value,
          domain: d,
          path: "/",
          secure: true,
        }))
      );
    }

    pageInstance = await contextInstance.newPage();
    await pageInstance.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });

    try {
      await pageInstance.waitForSelector('[contenteditable="true"]', { timeout: 20000 });
    } catch (selectorErr) {
      if (pageInstance.url().includes("/login")) {
        throw new Error(
          "Postman session expired or redirected to login. Please refresh your postman.sid cookie."
        );
      }
      throw selectorErr;
    }

    return pageInstance;
  } catch (err) {
    await cleanupBrowser();
    throw err;
  } finally {
    isNavigating = false;
  }
}

async function selectTargetModel(page: Page, targetModelName: string): Promise<void> {
  try {
    await page.evaluate(async (modelName) => {
      const container =
        document.querySelector('[contenteditable="true"]')?.closest(".ai-chat-input-container") ||
        document.body;
      const btns = Array.from(container.querySelectorAll("button"));
      const currentModelBtn = btns.find(
        (b) =>
          b.textContent?.includes("Auto") ||
          b.textContent?.includes("GPT-") ||
          b.textContent?.includes("Claude") ||
          b.textContent?.includes("Thinking")
      );

      if (
        currentModelBtn &&
        !currentModelBtn.textContent?.toLowerCase().includes(modelName.toLowerCase())
      ) {
        currentModelBtn.click();
        await new Promise((r) => setTimeout(r, 300));
        const targetItem = Array.from(document.querySelectorAll("button, [role='menuitem']")).find(
          (b) => b.textContent?.toLowerCase().includes(modelName.toLowerCase())
        );
        if (targetItem) {
          (targetItem as HTMLElement).click();
        }
      }
    }, targetModelName);
  } catch {
    // ignore
  }
}

export async function askPostmanAgent(
  prompt: string,
  cookieStr: string,
  modelName: string = "Claude Opus 4.8",
  workspaceUrl?: string,
  signal?: AbortSignal
): Promise<string> {
  let release: () => void = () => {};
  const currentLock = new Promise<void>((res) => {
    release = res;
  });
  const prevQueue = requestQueue;
  requestQueue = requestQueue.catch(() => {}).then(() => currentLock);

  try {
    await prevQueue.catch(() => {});

    if (signal?.aborted) {
      throw new Error("Request was aborted by client before execution.");
    }

    const page = await getOrInitPostmanPage(cookieStr, workspaceUrl);

    const editor = await page.$('[contenteditable="true"]');
    if (!editor) throw new Error("Postman Agent editor not found");

    // Select target model
    await selectTargetModel(page, modelName);

    const prevCount = await page.$$eval(".ai-chat-agent-message", (els) => els.length);

    // Focus & insert text safely using execCommand
    await editor.click({ force: true });
    await page.evaluate((text) => {
      const el = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
      if (!el) return;
      el.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, text);
    }, prompt);

    await page.waitForTimeout(200);

    // Click explicit send button .ai-chat-input-send-button
    await page.evaluate(() => {
      const sendBtn = document.querySelector(".ai-chat-input-send-button") as HTMLElement | null;
      if (sendBtn) {
        sendBtn.click();
      } else {
        const btns = Array.from(document.querySelectorAll(".ai-chat-input-container button"));
        const lastBtn = btns[btns.length - 1] as HTMLElement | null;
        if (lastBtn) lastBtn.click();
      }
    });

    // Wait for new agent message element to stream and stabilize (up to 45s timeout)
    let responseText = "";
    const start = Date.now();
    let lastText = "";
    let stableTicks = 0;

    while (Date.now() - start < 45000) {
      if (signal?.aborted) {
        throw new Error("Request aborted by client during generation.");
      }

      await page.waitForTimeout(800);
      const messages = await page.$$eval(".ai-chat-agent-message", (els) =>
        els.map((e) => (e as HTMLElement).innerText.trim())
      );

      if (messages.length > prevCount) {
        const latestMsg = messages[messages.length - 1];
        if (latestMsg && latestMsg.length > 0) {
          if (latestMsg === lastText) {
            stableTicks++;
            if (stableTicks >= 4) {
              // Stable for 3.2s
              responseText = latestMsg;
              break;
            }
          } else {
            lastText = latestMsg;
            stableTicks = 0;
          }
        }
      }
    }

    return responseText || lastText;
  } catch (err) {
    if (pageInstance?.isClosed()) {
      await cleanupBrowser();
    }
    throw err;
  } finally {
    release();
  }
}
