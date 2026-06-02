// gemini.js — cliente Node.js para a API oficial do Google Gemini
//
// Modelo padrão : gemini-2.5-flash-lite-preview-06-17
// Documentação  : https://ai.google.dev/api/generate-content
//
// Interface mantida: askGemini(prompt, opts) e askGeminiOnce(prompt, opts)

const https = require("https");

// ── Configurações ────────────────────────────────────────────────────────────

const API_KEY    = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const BASE_URL   = "generativelanguage.googleapis.com";

const RETRY_CONFIG = {
  maxAttempts  : 4,
  delayMs      : 3000,
  backoffFactor: 1.5,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcDelay(attempt) {
  const exponential = RETRY_CONFIG.delayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  const jitter      = Math.random() * 1000;
  return Math.floor(exponential + jitter);
}

/** HTTP 4xx (exceto 429) são erros fatais — retry não vai resolver. */
function isFatalStatus(status) {
  return status >= 400 && status < 500 && status !== 429;
}

// ── Chamada HTTP à API do Gemini ─────────────────────────────────────────────

function callGeminiAPI(prompt, model) {
  return new Promise((resolve, reject) => {
    const modelId  = model || DEFAULT_MODEL;
    const endpoint = `/v1beta/models/${modelId}:generateContent?key=${API_KEY}`;

    const body = JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: prompt }] }
      ],
      generationConfig: {
        temperature    : 1,
        topP           : 0.95,
        maxOutputTokens: 8192,
      },
    });

    const options = {
      hostname: BASE_URL,
      path    : endpoint,
      method  : "POST",
      headers : {
        "Content-Type"  : "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (isFatalStatus(res.statusCode)) {
          const err  = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.fatal  = true;
          err.status = res.statusCode;
          return reject(err);
        }

        if (res.statusCode !== 200) {
          const err  = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.status = res.statusCode;
          return reject(err);
        }

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return reject(new Error(`Resposta JSON inválida: ${data.slice(0, 300)}`));
        }

        // Extrai o texto gerado
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          // Possível bloqueio de safety ou resposta vazia
          const reason = json?.candidates?.[0]?.finishReason || "desconhecido";
          const err    = new Error(`Resposta vazia ou bloqueada (finishReason: ${reason})`);
          // SAFETY / RECITATION são fatais; tentar novamente não vai mudar nada
          err.fatal = ["SAFETY", "RECITATION"].includes(reason);
          return reject(err);
        }

        resolve(text);
      });
    });

    req.on("error", e => reject(new Error(`Erro de rede: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Uma única chamada sem retry.
 * Opções: { stream, onChunk, model }
 *
 * `stream` e `onChunk` são mantidos por compatibilidade com o código existente.
 * A API REST não entrega streaming real; o texto é reemitido em chunks após
 * a resposta completa chegar.
 */
async function askGeminiOnce(prompt, { stream = false, onChunk, model } = {}) {
  const text = await callGeminiAPI(prompt, model);

  if (stream && typeof onChunk === "function") {
    const CHUNK_SIZE = 60;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      onChunk(text.slice(i, i + CHUNK_SIZE));
    }
  }

  return text;
}

/**
 * Chamada com retry automático (backoff exponencial + jitter).
 * Aborta imediatamente em erros fatais (4xx, safety block, etc.).
 */
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
      if (err.fatal) {
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

// ── Uso direto pela linha de comando: node gemini.js "seu prompt" ─────────────
if (require.main === module) {
  const prompt = process.argv.slice(2).join(" ") || "qual a capital do Brasil?";

  askGemini(prompt)
    .then(r  => console.log("\n===== RESPOSTA =====\n" + r))
    .catch(e => { console.error("\n[gemini] erro final:", e.message); process.exit(1); });
}

// ── Exemplo de uso com streaming simulado ─────────────────────────────────────
// askGemini(prompt, {
//   stream : true,
//   onChunk: delta => process.stdout.write(delta),
// }).then(full => console.log("\n\ntotal:", full.length, "chars")).catch(console.error);