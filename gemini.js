// gemini.js — orquestrador Node para o worker Python (gemini_webapi + rotação de IP)
//
// Pré-requisitos:
//   pip install gemini_webapi
//   cookies.json   -> { "__Secure-1PSID": "...", "__Secure-1PSIDTS": "..." }
//   proxies.txt    -> um proxy residencial por linha (opcional; vazio = conexão direta)
//
// Mantém a mesma interface do arquivo antigo: askGemini(prompt, opts) e askGeminiOnce(prompt, opts).

const { spawn } = require("child_process");
const path = require("path");

const WORKER = path.join(__dirname, "gemini_worker.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

const RETRY_CONFIG = {
  maxAttempts: 4,
  delayMs: 3000,
  backoffFactor: 1.5,
  workerTimeoutMs: 120000, // mata o worker se travar
};

function calcDelay(attempt) {
  const exponential = RETRY_CONFIG.delayMs * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  const jitter = Math.random() * 1000;
  return Math.floor(exponential + jitter);
}

// Erros que NÃO se resolvem com retry (cookies inválidos, limite de uso, prompt vazio).
function isFatalError(err) {
  return err && err.fatal === true;
}

// Chama o worker Python uma vez. Resolve com o texto da resposta.
function runWorker(prompt, model) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (model) env.GEMINI_MODEL = model;

    const proc = spawn(PYTHON, [WORKER], { env });

    let out = "";
    let err = "";
    let finished = false;

    const killTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill("SIGKILL");
        reject(new Error(`worker excedeu ${RETRY_CONFIG.workerTimeoutMs}ms`));
      }
    }, RETRY_CONFIG.workerTimeoutMs);

    proc.stdout.on("data", d => (out += d.toString()));
    proc.stderr.on("data", d => (err += d.toString()));

    proc.on("error", e => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      reject(new Error(`não foi possível iniciar o worker (${PYTHON}): ${e.message}`));
    });

    proc.on("close", code => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      // Loga o stderr do worker (rotação de proxies etc.) sem poluir o stdout.
      if (err.trim()) {
        err.trim().split("\n").forEach(l => console.log(`[worker] ${l}`));
      }

      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        return reject(new Error(`worker sem saída (code ${code}). stderr: ${err.slice(0, 500)}`));
      }

      let res;
      try {
        res = JSON.parse(line);
      } catch {
        return reject(new Error(`saída inválida do worker: ${line.slice(0, 300)}`));
      }

      if (res.ok) {
        if (res.proxy) console.log(`[gemini] via proxy ${res.proxy}`);
        resolve(res.text);
      } else {
        const e = new Error(res.error || "erro desconhecido do worker");
        e.fatal = !!res.fatal;
        reject(e);
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Uma única tentativa. Suporta { stream, onChunk, model } por compatibilidade.
// Obs.: a API interna não faz streaming real — o texto chega inteiro e é
// reemitido em chunks para manter a interface antiga funcionando.
async function askGeminiOnce(prompt, { stream = false, onChunk, model } = {}) {
  const text = await runWorker(prompt, model);

  if (stream && typeof onChunk === "function" && text) {
    const CHUNK = 60;
    for (let i = 0; i < text.length; i += CHUNK) {
      onChunk(text.slice(i, i + CHUNK));
    }
  }

  if (!text) throw new Error("Resposta vazia");
  return text;
}

// Retry com backoff exponencial + jitter. Aborta cedo em erros fatais.
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
        console.error("[gemini] dica: cookies expirados? re-extraia o __Secure-1PSID / __Secure-1PSIDTS.");
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

// ── Uso direto pela linha de comando: node gemini.js "seu prompt" ───────────
if (require.main === module) {
  const prompt = process.argv.slice(2).join(" ") || "qual a capital do Brasil?";
  askGemini(prompt)
    .then(r => {
      console.log("\n===== RESPOSTA =====\n" + r);
    })
    .catch(e => {
      console.error("\n[gemini] erro final:", e.message);
      process.exit(1);
    });
}

// Modo streaming (interface preservada):
// askGemini(prompt, {
//   stream: true,
//   onChunk: (delta) => process.stdout.write(delta),
// }).then(full => console.log("\n\ntotal:", full.length, "chars")).catch(console.error);