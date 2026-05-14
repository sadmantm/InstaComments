const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const INPUT_SELS = [
  ".ql-editor",
  "rich-textarea .ql-editor",
  "[contenteditable='true']",
  "textarea",
];

const SEND_SELS = [
  "button.send-button[aria-label='Enviar mensagem']",
  "button.send-button",
  "button[aria-label='Enviar mensagem']",
  "button[aria-label='Enviar']",
  "button[aria-label='Send message']",
  "button[aria-label='Send']",
  "button[data-test-id='send-button']",
  "button:has(mat-icon[fonticon='send'])",
  "button:has(mat-icon[data-mat-icon-name='send'])",
];

const RESPONSE_SELS = [
  "message-content p",
  "message-content .markdown",
  "model-response p",
  "model-response .markdown",
  ".response-content p",
  ".chat-turn-container .response-text p",
  ".model-response-text p",
  ".model-response-text .markdown",
  "[data-response-index] p",
];

const SCREENSHOT_DIR = path.join(__dirname, "debug_screenshots");

const RETRY_CONFIG = {
  maxAttempts: 5,
  delayMs: 3000,        // Espera base entre tentativas (ms)
  backoffFactor: 1.5,   // Fator de backoff exponencial
};

function saveScreenshot(page, name) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);
    const file = path.join(SCREENSHOT_DIR, `${name}_${Date.now()}.png`);
    return page.screenshot({ path: file, fullPage: true }).then(() => {}).catch(() => {});
  } catch (_) {}
}

async function waitForSel(page, sels, timeout = 15000, label = "") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await page.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }, el);
          if (visible) return { sel, el };
        }
      } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Nenhum seletor encontrado`
  );
}

async function detectResponseSel(page) {
  return page.evaluate(() => {
    const ZERO_STATE_TAGS = ["zero-state-block-picker", "assistant-messages-primary", "zero-state"];
    const candidates = [
      ...document.querySelectorAll("*"),
    ].filter((el) => {
      const tag = el.tagName.toLowerCase();
      const cls = el.className || "";
      const text = el.innerText?.trim() || "";
      if (ZERO_STATE_TAGS.some(t => tag.includes(t) || el.closest(t))) return false;
      return (
        text.length > 20 &&
        (tag.includes("response") ||
          tag.includes("message") ||
          tag.includes("model") ||
          cls.includes("response") ||
          cls.includes("model") ||
          cls.includes("markdown"))
      );
    });

    if (!candidates.length) return null;

    const deepest = candidates.reduce((a, b) =>
      a.querySelectorAll("*").length < b.querySelectorAll("*").length ? b : a
    );

    const tag = deepest.tagName.toLowerCase();
    const cls = deepest.className?.split(" ").filter(Boolean)[0] || "";
    return cls ? `${tag}.${cls}` : tag;
  });
}

/**
 * Calcula o delay com backoff exponencial + jitter aleatório
 * para evitar thundering herd em múltiplas instâncias.
 */
function calcDelay(attempt) {
  const exponential = RETRY_CONFIG.delayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  const jitter = Math.random() * 1000; // até 1s extra aleatório
  return Math.floor(exponential + jitter);
}

/**
 * Erros que NÃO devem ser retentados (falha definitiva).
 */
function isFatalError(err) {
  return err.message?.includes("Gemini exige login");
}

async function askGeminiOnce(prompt) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--window-size=1280,900",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    if (
      page.url().includes("accounts.google.com") ||
      page.url().includes("signin")
    ) {
      await saveScreenshot(page, "02_login_required");
      await browser.close();
      throw new Error(
        "Gemini exige login. Faça login manual uma vez usando headless:false e salve os cookies."
      );
    }

    const { sel: inputSel } = await waitForSel(page, INPUT_SELS, 30000, "input");

    await page.click(inputSel);
    await new Promise((r) => setTimeout(r, 500));

    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await new Promise((r) => setTimeout(r, 300));

    const inserted = await page.evaluate((text) => {
      const editor = document.querySelector(".ql-editor");
      if (!editor) return false;
      editor.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      return true;
    }, prompt);

    if (!inserted) throw new Error("Não foi possível inserir texto no editor Quill");

    await page.waitForFunction(
      () => {
        const btn =
          document.querySelector("button.send-button[aria-label='Enviar mensagem']") ||
          document.querySelector("button.send-button");
        return btn && btn.getAttribute("aria-disabled") !== "true" && !btn.disabled;
      },
      { timeout: 10000 }
    ).catch(() => console.log("[gemini] timeout aguardando botão — tentando mesmo assim"));

    await new Promise((r) => setTimeout(r, 400));

    const fieldContent = await page.evaluate(() => {
      const editor = document.querySelector(".ql-editor");
      return editor ? editor.innerText.trim() : "";
    });
    if (!fieldContent || fieldContent.length < 3) throw new Error("Campo vazio após inserção — abortando envio");

    try {
      const { sel: sendSel } = await waitForSel(page, SEND_SELS, 5000, "send");
      await page.click(sendSel);
      console.log(`[gemini] mensagem enviada via botão`);
    } catch (_) {
      console.log("[gemini] botão não encontrado, usando Enter como fallback");
      await page.keyboard.press("Enter");
    }

    await new Promise((r) => setTimeout(r, 2000));

    let respSel;
    try {
      const result = await waitForSel(page, RESPONSE_SELS, 45000, "response");
      respSel = result.sel;
    } catch (e) {
      console.log("[gemini] seletores fixos falharam, tentando detecção automática...");
      await saveScreenshot(page, "fallback_detection");
      respSel = await detectResponseSel(page);
      if (!respSel) throw e;
      console.log(`[gemini] seletor detectado dinamicamente: ${respSel}`);
    }

    let lastText = "";
    let stableCount = 0;

    while (stableCount < 6) {
      await new Promise((r) => setTimeout(r, 1000));

      const currentText = await page.evaluate((sel) => {
        const els = document.querySelectorAll(sel);
        const last = els[els.length - 1];
        return last ? last.innerText.trim() : "";
      }, respSel);

      if (currentText && currentText === lastText) {
        stableCount++;
      } else {
        stableCount = 0;
        lastText = currentText;
      }
    }

    await browser.close();

    if (!lastText) throw new Error("Resposta vazia após streaming");
    return lastText;
  } catch (e) {
    await saveScreenshot(page, "error").catch(() => {});
    await browser.close();
    throw e;
  }
}

/**
 * Wrapper com retry automático.
 * - Até RETRY_CONFIG.maxAttempts tentativas
 * - Backoff exponencial com jitter entre tentativas
 * - Erros fatais (ex: login) interrompem imediatamente
 */
async function askGemini(prompt) {
  let lastError;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    const isFirstAttempt = attempt === 0;

    if (!isFirstAttempt) {
      const delay = calcDelay(attempt);
      console.log(
        `[gemini] tentativa ${attempt + 1}/${RETRY_CONFIG.maxAttempts} em ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const result = await askGeminiOnce(prompt);
      if (attempt > 0) {
        console.log(`[gemini] sucesso na tentativa ${attempt + 1}`);
      }
      return result;
    } catch (err) {
      lastError = err;

      if (isFatalError(err)) {
        console.error(`[gemini] erro fatal, abortando sem retry: ${err.message}`);
        throw err;
      }

      console.warn(`[gemini] tentativa ${attempt + 1} falhou: ${err.message}`);
    }
  }

  throw new Error(
    `[gemini] todas as ${RETRY_CONFIG.maxAttempts} tentativas falharam. Último erro: ${lastError?.message}`
  );
}

module.exports = { askGemini };