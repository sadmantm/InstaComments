const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const INPUT_SELS = [
  ".ql-editor",
  "rich-textarea .ql-editor",
  "[contenteditable='true']",
  "textarea",
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
  delayMs: 3000,
  backoffFactor: 1.5,
};

function saveScreenshot(page, name) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);
    const file = path.join(SCREENSHOT_DIR, `${name}_${Date.now()}.png`);
    return page.screenshot({ path: file, fullPage: true }).then(() => {}).catch(() => {});
  } catch (_) {}
}

function calcDelay(attempt) {
  const exponential = RETRY_CONFIG.delayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  const jitter = Math.random() * 1000;
  return Math.floor(exponential + jitter);
}

function isFatalError(err) {
  return err.message?.includes("Gemini exige login");
}

function extractText(container) {
  const lines = [];
  for (const el of container.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === "div" && el.classList.contains("attachment-container")) continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    if (["h1","h2","h3","h4"].includes(tag)) {
      lines.push(`\n${text}\n`);
    } else if (["ul","ol"].includes(tag)) {
      for (const li of el.querySelectorAll("li")) {
        const t = (li.innerText || "").trim();
        if (t) lines.push(`* ${t}`);
      }
    } else if (tag === "blockquote") {
      lines.push(`> ${text}`);
    } else if (tag === "table") {
      const rows = el.querySelectorAll("tr");
      rows.forEach((row, i) => {
        const cells = Array.from(row.querySelectorAll("th, td"))
          .map(c => (c.innerText || "").trim());
        lines.push("| " + cells.join(" | ") + " |");
        if (i === 0) lines.push("| " + cells.map(() => "---").join(" | ") + " |");
      });
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n").trim();
}

async function askGeminiOnce(prompt, { stream = false, onChunk } = {}) {
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
  page.on("request", req => {
    if (["image", "media", "font", "stylesheet"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (page.url().includes("accounts.google.com") || page.url().includes("signin")) {
      await saveScreenshot(page, "02_login_required");
      await browser.close();
      throw new Error(
        "Gemini exige login. Faça login manual uma vez usando headless:false e salve os cookies."
      );
    }

    await page.waitForSelector(INPUT_SELS.join(", "), { timeout: 30000 });

    // ── Foco REAL e confiável no editor (clique do Puppeteer = isTrusted) ────
    const editorHandle = await page.$(".ql-editor");
    if (!editorHandle) throw new Error("Campo de input (.ql-editor) não encontrado");
    await editorHandle.click();
    await new Promise(r => setTimeout(r, 150));

    // ── Insere o texto (execCommand é rápido para prompts grandes) ───────────
    const inserted = await page.evaluate(text => {
      const editor =
        document.querySelector(".ql-editor") ||
        document.querySelector("[contenteditable='true']");
      if (!editor) return false;
      editor.focus();
      const range = document.createRange();
      const sel   = window.getSelection();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, prompt);

    if (!inserted) throw new Error("Não foi possível inserir texto no editor");

    // Confirma que o texto apareceu no DOM
    await page.waitForFunction(
      () => {
        const editor =
          document.querySelector(".ql-editor") ||
          document.querySelector("[contenteditable='true']");
        return editor && editor.innerText.trim().length > 2;
      },
      { timeout: 3000 }
    ).catch(() => { throw new Error("Campo vazio após inserção — abortando envio"); });

    // ── "Toque" CONFIÁVEL: força o Quill a registrar o conteúdo no modelo ────
    //    interno e habilitar o botão de envio. Digita um espaço e apaga.
    await editorHandle.click();                 // garante foco antes de teclar
    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.press("End");           // caret no fim do texto
    await page.keyboard.type(" ");              // input confiável (isTrusted)
    await page.keyboard.press("Backspace");     // remove o espaço (net zero)
    await new Promise(r => setTimeout(r, 150));

    // ── Envio: Enter NATIVO (trusted). O rich-textarea tem enterkeyhint=send ─
    await page.keyboard.press("Enter");

    // Detecta se o envio realmente começou: editor esvaziou OU a resposta surgiu
    const started = await page.waitForFunction(() => {
      const editor = document.querySelector(".ql-editor");
      const cleared = editor && editor.innerText.trim().length === 0;
      const responding = document.querySelector(
        '.model-response-text, message-content, button[data-test-id="copy-button"]'
      );
      return Boolean(cleared || responding);
    }, { timeout: 4000 }).then(() => true).catch(() => false);

    // ── Fallback: clique REAL no botão de enviar (ElementHandle.click) ───────
    if (!started) {
      const sendBtn = await page.$([
        'button[data-test-id="send-button"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Enviar mensagem"]',
        'button.send-button',
        'button[mattooltip="Submit"]',
        'button[mattooltip="Enviar"]',
      ].join(", "));

      if (sendBtn) {
        const disabled = await sendBtn.evaluate(b => b.disabled || b.getAttribute("aria-disabled") === "true");
        if (disabled) {
          // último recurso: re-foca e tenta Enter de novo
          await editorHandle.click();
          await new Promise(r => setTimeout(r, 100));
          await page.keyboard.press("Enter");
          console.log("[gemini] botão desabilitado — reenvio via Enter nativo");
        } else {
          await sendBtn.click();
          console.log("[gemini] envio via clique real no botão");
        }
      } else {
        throw new Error("Falha ao enviar: Enter nativo não disparou e botão não encontrado");
      }
    } else {
      console.log("[gemini] envio confirmado (Enter nativo)");
    }

    // Pausa para o DOM iniciar a resposta
    await new Promise(r => setTimeout(r, 500));

    // ── Aguarda a resposta ───────────────────────────────────────────────────
    console.log("[gemini] gerando resposta...");

    let lastText = "";

    await saveScreenshot(page, "Gerando");

    if (stream && typeof onChunk === "function") {
      await page.exposeFunction("__geminiChunk__", onChunk);

      await page.evaluate(() => {
        const getContainer = () => document.querySelector(".model-response-text .markdown");
        const poll = setInterval(() => {
          const container = getContainer();
          if (!container) return;
          clearInterval(poll);
          let lastSent = "";
          const observer = new MutationObserver(() => {
            const lines = [];
            for (const el of container.children) {
              const tag  = el.tagName.toLowerCase();
              const text = (el.innerText || "").trim();
              if (!text) continue;
              if (["h1","h2","h3","h4"].includes(tag)) {
                lines.push(`\n${text}\n`);
              } else if (["ul","ol"].includes(tag)) {
                for (const li of el.querySelectorAll("li")) {
                  const t = (li.innerText || "").trim();
                  if (t) lines.push(`* ${t}`);
                }
              } else if (tag === "blockquote") {
                lines.push(`> ${text}`);
              } else {
                lines.push(text);
              }
            }
            const current = lines.join("\n").trim();
            if (current && current !== lastSent) {
              const delta = current.slice(lastSent.length);
              if (delta) window.__geminiChunk__(delta);
              lastSent = current;
            }
          });
          observer.observe(container, { childList: true, subtree: true, characterData: true });
        }, 100);
      });

      await page.waitForSelector('button[data-test-id="copy-button"]', { timeout: 120000 });
      console.log("[gemini] geração concluída");

      lastText = await page.evaluate(fnSrc => {
        const extractText = new Function("container", fnSrc);
        const container = document.querySelector(".model-response-text .markdown");
        return container ? extractText(container) : "";
      }, extractText.toString().replace(/^function extractText\(container\)\s*\{/, "").replace(/\}$/, ""));

    } else {
      await page.waitForSelector('button[data-test-id="copy-button"]', { timeout: 120000 });
      console.log("[gemini] geração concluída");

      lastText = await page.evaluate(() => {
        const container = document.querySelector(".model-response-text .markdown");
        if (!container) return "";
        const lines = [];
        for (const el of container.children) {
          const tag  = el.tagName.toLowerCase();
          const text = el.innerText.trim();
          if (!text) continue;
          if (["h1","h2","h3","h4"].includes(tag)) {
            lines.push(`\n${text}\n`);
          } else if (["ul","ol"].includes(tag)) {
            for (const li of el.querySelectorAll("li")) {
              const t = li.innerText.trim();
              if (t) lines.push(`* ${t}`);
            }
          } else if (tag === "blockquote") {
            lines.push(`> ${text}`);
          } else {
            lines.push(text);
          }
        }
        return lines.join("\n").trim();
      });
    }

    await browser.close();

    if (!lastText) throw new Error("Resposta vazia após extração");
    return lastText;

  } catch (e) {
    await saveScreenshot(page, "error").catch(() => {});
    await browser.close();
    throw e;
  }
}

async function askGemini(prompt, options = {}) {
  let lastError;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = calcDelay(attempt);
      console.log(`[gemini] tentativa ${attempt + 1}/${RETRY_CONFIG.maxAttempts} em ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await askGeminiOnce(prompt, options);
      if (attempt > 0) console.log(`[gemini] sucesso na tentativa ${attempt + 1}`);
      return result;
    } catch (err) {
      lastError = err;
      if (isFatalError(err)) {
        console.error(`[gemini] erro fatal, abortando sem retry: ${err.message}`);
        throw err;
      }
      console.warn(`[gemini] tentativa ${attempt + 1} falhou: ${err.message}`);
      await saveScreenshot(null, "retry_failed").catch(() => {});
    }
  }

  throw new Error(
    `[gemini] todas as ${RETRY_CONFIG.maxAttempts} tentativas falharam. Último erro: ${lastError?.message}`
  );
}

module.exports = { askGemini, askGeminiOnce };

// Modo normal (padrão)
//askGemini("prompt").then(console.log).catch(console.error);

// Modo streaming — recebe chunks em tempo real
//askGemini(prompt, {
 //stream: true,
// onChunk: (delta) => process.stdout.write(delta),
//})
//  .then((full) => {
//    console.log("\n\n[gemini] resposta completa recebida, total:", full.length, "chars");
//  })
//  .catch(console.error);