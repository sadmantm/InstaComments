const { GoogleGenerativeAI } = require("@google/generative-ai");

// ── Configuração ─────────────────────────────────────────────────────────────
// Modelo: gemini-2.0-flash — rápido, barato e capaz o suficiente para a maioria
// dos casos. Alternativa ainda mais econômica: "gemini-2.0-flash-lite"
// gemini-2.0-flash-lite: cota gratuita própria, mais econômico
// gemini-2.0-flash: mais capaz, cota separada
const MODEL_NAME = "gemini-2.0-flash-lite";

const RETRY_CONFIG = {
  maxAttempts: 5,
  delayMs: 3000,
  backoffFactor: 1.5,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function calcDelay(attempt) {
  const exponential = RETRY_CONFIG.delayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  const jitter = Math.random() * 1000;
  return Math.floor(exponential + jitter);
}

function isFatalError(err) {
  return (
    err.message?.includes("API_KEY_INVALID") ||
    err.message?.includes("PERMISSION_DENIED")
  );
}

// Extrai o retryDelay sugerido pelo servidor (ex: "50s" → 50000ms)
function parseRetryDelay(err) {
  const match = err.message?.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Variável de ambiente GEMINI_API_KEY não definida.");
  return new GoogleGenerativeAI(apiKey);
}

// ── Core: uma única chamada ──────────────────────────────────────────────────
async function askGeminiOnce(prompt, { stream = false, onChunk } = {}) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  if (stream && typeof onChunk === "function") {
    const result = await model.generateContentStream(prompt);

    let fullText = "";
    for await (const chunk of result.stream) {
      const delta = chunk.text();
      if (delta) {
        onChunk(delta);
        fullText += delta;
      }
    }

    if (!fullText) throw new Error("Resposta vazia após streaming.");
    return fullText;

  } else {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (!text) throw new Error("Resposta vazia.");
    return text;
  }
}

// ── Wrapper com retry + backoff ──────────────────────────────────────────────
async function askGemini(prompt, options = {}) {
  let lastError;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    if (attempt > 0) {
      const retryAfter = parseRetryDelay(lastError);
      const delay = retryAfter ?? calcDelay(attempt);
      console.log(`[gemini] tentativa ${attempt + 1}/${RETRY_CONFIG.maxAttempts} em ${delay}ms${retryAfter ? " (sugerido pelo servidor)" : ""}...`);
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
    }
  }

  throw new Error(
    `[gemini] todas as ${RETRY_CONFIG.maxAttempts} tentativas falharam. Último erro: ${lastError?.message}`
  );
}

module.exports = { askGemini, askGeminiOnce };

// ── Exemplos de uso ──────────────────────────────────────────────────────────

// Modo normal
// askGemini("Explique o que é memoização em JS.").then(console.log).catch(console.error);

// Modo streaming
// askGemini("Conte uma história curta.", {
//   stream: true,
//   onChunk: (delta) => process.stdout.write(delta),
// })
//   .then((full) => console.log(`\n\n[gemini] total: ${full.length} chars`))
//   .catch(console.error);