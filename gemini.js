// gemini.js
const { spawn } = require("child_process");
const path = require("path");

const WORKER = path.join(__dirname, "gemini_worker.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

const RETRY = { maxAttempts: 4, delayMs: 3000, backoff: 1.5 };

function runWorker(prompt, model) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (model) env.GEMINI_MODEL = model;

    const proc = spawn(PYTHON, [WORKER], { env });
    let out = "", err = "";
    proc.stdout.on("data", d => (out += d));
    proc.stderr.on("data", d => (err += d));
    proc.on("error", reject);
    proc.on("close", code => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`worker sem saída (code ${code}). stderr: ${err.slice(0, 500)}`));
      let res;
      try { res = JSON.parse(line); }
      catch { return reject(new Error(`saída inválida do worker: ${line.slice(0, 300)}`)); }
      if (res.ok) { if (res.proxy) console.log(`[gemini] via proxy ${res.proxy}`); resolve(res.text); }
      else { const e = new Error(res.error); e.fatal = !!res.fatal; reject(e); }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function askGemini(prompt, { model } = {}) {
  let lastErr;
  for (let i = 0; i < RETRY.maxAttempts; i++) {
    if (i > 0) {
      const delay = Math.floor(RETRY.delayMs * Math.pow(RETRY.backoff, i) + Math.random() * 1000);
      console.log(`[gemini] tentativa ${i + 1}/${RETRY.maxAttempts} em ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      return await runWorker(prompt, model);
    } catch (e) {
      lastErr = e;
      if (e.fatal) { console.error(`[gemini] erro fatal (não adianta retry): ${e.message}`); throw e; }
      console.warn(`[gemini] tentativa ${i + 1} falhou: ${e.message}`);
    }
  }
  throw new Error(`[gemini] todas as ${RETRY.maxAttempts} tentativas falharam. Último: ${lastErr?.message}`);
}

module.exports = { askGemini };

 askGemini("qual a capital do Brasil?").then(console.log).catch(console.error);