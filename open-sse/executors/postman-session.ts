import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

const DEFAULT_WORKSPACE_URL =
  "https://epsiloncryptoai-7880991.postman.co/workspace/280d1867-5a3e-41c7-8465-9e4b0edf866f?sideView=agentMode";

function parseCookies(raw: string): ParsedCookie[] {
  let cleaned = raw.trim().replace(/^cookie:\s*/i, "");

  // Support JSON array format (e.g. exported from Chrome DevTools / Cookie-Editor / EditThisCookie)
  if (cleaned.startsWith("[")) {
    try {
      const parsedJson = JSON.parse(cleaned);
      if (Array.isArray(parsedJson)) {
        return parsedJson
          .filter((item) => item && typeof item === "object" && item.name && item.value)
          .map((item) => ({
            name: String(item.name).trim(),
            value: String(item.value).trim(),
            domain: item.domain ? String(item.domain).trim() : undefined,
            path: item.path ? String(item.path).trim() : "/",
          }));
      }
    } catch {
      // Fallback to standard semicolon parsing if JSON.parse fails
    }
  }

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

async function ensureAgentEditorVisible(page: Page, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new Error("Page was closed during navigation.");
    if (page.url().includes("/login")) {
      throw new Error(
        "Postman session expired or redirected to login. Please refresh your postman.sid cookie."
      );
    }

    const editor = await page.$(
      '[contenteditable="true"], .ai-chat-input-container [contenteditable]'
    );
    if (editor) return;

    // Try clicking sidebar Agent / Postbot button to expand sideView
    try {
      await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll("button, [role='button'], [data-testid*='agent']")
        );
        const agentBtn = buttons.find(
          (b) =>
            b.getAttribute("aria-label")?.toLowerCase().includes("agent") ||
            b.getAttribute("aria-label")?.toLowerCase().includes("postbot") ||
            b.getAttribute("data-testid")?.toLowerCase().includes("agent") ||
            b.textContent?.toLowerCase().includes("agent") ||
            b.textContent?.toLowerCase().includes("postbot")
        );
        if (agentBtn) (agentBtn as HTMLElement).click();
      });
    } catch {
      // ignore
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timeout ${timeoutMs}ms exceeded waiting for Postman Agent chat editor.`);
}

export async function getOrInitPostmanPage(
  cookieStr: string,
  workspaceUrl?: string
): Promise<Page> {
  const targetUrl = workspaceUrl || DEFAULT_WORKSPACE_URL;

  if (pageInstance && !pageInstance.isClosed() && currentCookie === cookieStr) {
    if (currentWorkspaceUrl !== targetUrl) {
      currentWorkspaceUrl = targetUrl;
      await pageInstance.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await ensureAgentEditorVisible(pageInstance, 20000);
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

    const defaultDomains = Array.from(
      new Set([
        ".postman.co",
        ".postman.com",
        ".getpostman.com",
        "identity.getpostman.com",
        hostDomain,
      ])
    );

    for (const c of parsed) {
      for (const d of defaultDomains) {
        await contextInstance.addCookies([
          {
            name: c.name,
            value: c.value,
            domain: d,
            path: c.path || "/",
            secure: true,
          },
        ]);
      }
    }

    pageInstance = await contextInstance.newPage();
    await pageInstance.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });

    await ensureAgentEditorVisible(pageInstance, 30000);

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
      const modelBtn = document.querySelector(
        ".ai-chat-input-bottom-section button.MenuButton__StyledMenuButton-sc-3281258f-0"
      ) as HTMLElement | null;

      if (!modelBtn) return;
      const currentText = modelBtn.innerText?.trim() || "";
      if (currentText.toLowerCase().includes(modelName.toLowerCase())) {
        return;
      }

      modelBtn.click();
      await new Promise((r) => setTimeout(r, 400));

      const menuItems = Array.from(
        document.querySelectorAll(
          '.szh-menu-container [role="menuitem"], .szh-menu__item, [role="menuitem"]'
        )
      ) as HTMLElement[];

      const targetItem = menuItems.find((b) =>
        b.innerText?.toLowerCase().includes(modelName.toLowerCase())
      );

      if (targetItem) {
        targetItem.click();
      } else {
        const autoItem = menuItems.find((b) => b.innerText?.toLowerCase().includes("auto"));
        if (autoItem) {
          autoItem.click();
        } else {
          document.body.click();
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

    const editorSelector = '[contenteditable="true"]';
    await page.waitForSelector(editorSelector, { state: "visible", timeout: 15000 });
    const editor = await page.$(editorSelector);
    if (!editor) throw new Error("Postman Agent editor not found");

    // Select target model
    await selectTargetModel(page, modelName);

    // Record initial count of message groups
    const prevGroupCount = await page.$$eval(".ai-chat-message-group", (els) => els.length);

    // Focus & insert text safely
    await editor.focus();
    await page.evaluate((text) => {
      const el = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
      if (!el) return;
      el.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, text);
    }, prompt);

    await page.waitForTimeout(300);

    // Click explicit send button
    const sendBtn = await page.$(".ai-chat-input-send-button");
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Wait for response text in .ai-chat-message-group to generate and finish
    let responseText = "";
    const start = Date.now();
    let lastText = "";
    let stableTicks = 0;

    while (Date.now() - start < 45000) {
      if (signal?.aborted) {
        throw new Error("Request aborted by client during generation.");
      }

      await page.waitForTimeout(800);
      const state = await page.evaluate((prev) => {
        const groups = Array.from(document.querySelectorAll(".ai-chat-message-group"));
        if (groups.length <= prev) return { hasNewGroup: false, text: "", isDone: false };

        const lastGroup = groups[groups.length - 1] as HTMLElement;
        const agentMsg = lastGroup.querySelector(".ai-chat-agent-message") as HTMLElement | null;
        const text = agentMsg?.innerText?.trim() || "";
        const isGenerating = document.body.innerText.includes("Generating...");

        return {
          hasNewGroup: true,
          text,
          isDone: !isGenerating && text.length > 0,
        };
      }, prevGroupCount);

      if (state && state.hasNewGroup && state.text.length > 0) {
        if (state.isDone) {
          if (state.text === lastText) {
            stableTicks++;
            if (stableTicks >= 2) {
              responseText = state.text;
              break;
            }
          } else {
            lastText = state.text;
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
