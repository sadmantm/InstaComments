// Interface mantida: askGemini(prompt, opts) e askGeminiOnce(prompt, opts)

const https = require("https");

// ── Configurações ────────────────────────────────────────────────────────────

const API_KEY    = "";
const DEFAULT_MODEL = "gemini-2.5-flash";
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

/**
 * Extrai o campo `resposta` de um texto que deveria ser JSON.
 * Tenta parse direto; se falhar (JSON truncado), tenta recuperar a string
 * do campo resposta via regex. Retorna null se não conseguir nada utilizável.
 */
function extractResposta(text) {
  if (!text) return null;

  // 1. Parse limpo
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.resposta === "string" && obj.resposta.trim()) {
      return obj.resposta.trim();
    }
  } catch (_) { /* segue pro fallback */ }

  // 2. JSON truncado: tenta extrair o valor de "resposta" mesmo sem fechar
  //    Captura tudo entre "resposta":" e a próxima aspa não-escapada OU o fim.
  const m = text.match(/"resposta"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m && m[1]) {
    // Desescapa sequências básicas (\" \\ \n)
    const recovered = m[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
      .trim();
    if (recovered) return recovered;
  }

  return null;
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
        temperature     : 0.9,
        topP            : 0.95,
        maxOutputTokens : 2048,        // folga p/ não truncar o JSON (estrutura + emojis)
        responseMimeType: "application/json",
        responseSchema  : {
          type: "object",
          properties: {
            resposta: { type: "string" }
          },
          required: ["resposta"]
        }
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

        const candidate    = json?.candidates?.[0];
        const finishReason  = candidate?.finishReason || "desconhecido";
        const text          = candidate?.content?.parts?.[0]?.text;

        if (!text) {
          const err = new Error(`Resposta vazia ou bloqueada (finishReason: ${finishReason})`);
          err.fatal = ["SAFETY", "RECITATION"].includes(finishReason);
          return reject(err);
        }

        // Se foi truncado por limite de tokens, NÃO é fatal — retry pode resolver
        if (finishReason === "MAX_TOKENS") {
          // Ainda assim, tenta recuperar o que veio; se recuperar algo válido, usa.
          const partial = extractResposta(text);
          if (partial) return resolve(partial);
          return reject(new Error(`Geração truncada (MAX_TOKENS) sem resposta recuperável.`));
        }

        const finalReply = extractResposta(text);
        if (!finalReply) {
          // NUNCA resolve com JSON cru. Rejeita pra disparar retry.
          return reject(new Error(`Não foi possível extrair "resposta" do JSON: ${text.slice(0, 200)}`));
        }

        resolve(finalReply);
      });
    });

    req.on("error", e => reject(new Error(`Erro de rede: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// ── API pública ───────────────────────────────────────────────────────────────

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

if (require.main === module) {
  const prompt = process.argv.slice(2).join(" ") || "qual a capital do Brasil?";

  askGemini(prompt)
    .then(r  => console.log("\n===== RESPOSTA =====\n" + r))
    .catch(e => { console.error("\n[gemini] erro final:", e.message); process.exit(1); });
}