const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const SESSION_PATH       = path.resolve('./session.json');
const SESSION_REPLY_PATH = path.resolve('./session_reply.json');

const USER_DATA_DIR         = path.resolve('./chrome_profile');
const USER_DATA_DIR_REPLY   = path.resolve('./chrome_profile_reply');
const USER_DATA_DIR_LOGIN   = path.resolve('./chrome_profile_login');  // temporário

const CDP_PORT = 9222;

let remoteLoginBrowser = null;
let remoteLoginPage    = null;

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchBrowser(headless = false, userDataDir = USER_DATA_DIR) {
  return puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--start-maximized',
    ],
    defaultViewport: null,
  });
}

// ─── Session helpers ──────────────────────────────────────────────────────────

async function saveSession(page, sessionPath = SESSION_PATH) {
  const cookies = await page.cookies();
  const localStorage = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  });
  fs.writeFileSync(sessionPath, JSON.stringify({ cookies, localStorage }, null, 2));
  console.log(`✅ Sessão salva em: ${sessionPath}`);
}

async function loadSession(page, sessionPath = SESSION_PATH) {
  if (!fs.existsSync(sessionPath)) {
    console.log(`⚠️  Nenhuma sessão encontrada em: ${sessionPath}`);
    return false;
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  await page.goto('https://www.instagram.com', { waitUntil: 'networkidle2' });
  await page.setCookie(...session.cookies);
  await page.evaluate((ls) => {
    for (const [key, value] of Object.entries(ls)) {
      window.localStorage.setItem(key, value);
    }
  }, session.localStorage);
  return true;
}

async function isLoggedIn(page) {
  await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
  const loginBtn = await page.$('a[href="/accounts/login/"]');
  return !loginBtn;
}

// ─── Verifica se ambas as sessões existem ─────────────────────────────────────

function sessionsExist() {
  return fs.existsSync(SESSION_PATH) && fs.existsSync(SESSION_REPLY_PATH);
}

// ─── Login remoto via CDP (frontend faz login no browser do servidor) ─────────

async function launchRemoteLogin() {
  if (remoteLoginBrowser) return;

  remoteLoginBrowser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR_LOGIN,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-debugging-address=0.0.0.0',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  remoteLoginPage = (await remoteLoginBrowser.pages())[0];
  await remoteLoginPage.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'networkidle2',
  });

  console.log(`[remote-login] Browser aberto. CDP em ws://localhost:${CDP_PORT}`);
}

// Aguarda o usuário concluir o login e salva as DUAS sessões
async function waitForLoginAndSave() {
  if (!remoteLoginPage) throw new Error('Browser remoto não iniciado.');

  // Aguarda redirect pós-login (max 5 min)
  await remoteLoginPage.waitForFunction(
    () => !window.location.href.includes('/accounts/login/'),
    { timeout: 300_000 }
  );

  await remoteLoginPage.waitForNetworkIdle({ idleTime: 2000 }).catch(() => {});

  // Salva sessão do monitor
  await saveSession(remoteLoginPage, SESSION_PATH);

  // Salva sessão do reply (mesmos cookies — mesmo login)
  await saveSession(remoteLoginPage, SESSION_REPLY_PATH);

  console.log('[remote-login] Ambas as sessões salvas (monitor + reply).');

  // Limpa perfil temporário
  try { fs.rmSync(USER_DATA_DIR_LOGIN, { recursive: true, force: true }); } catch (_) {}

  await remoteLoginBrowser.close();
  remoteLoginBrowser = null;
  remoteLoginPage    = null;
}

// ─── Get session page ─────────────────────────────────────────────────────────

async function getSessionPage(profile = 'monitor') {
  const isReply     = profile === 'reply';
  const sessionPath = isReply ? SESSION_REPLY_PATH : SESSION_PATH;
  const userDataDir = isReply ? USER_DATA_DIR_REPLY : USER_DATA_DIR;

  const browser = await launchBrowser(true, userDataDir);
  const page    = await browser.newPage();

  const loaded = await loadSession(page, sessionPath);
  if (!loaded) {
    console.error(`❌ Sem sessão salva para [${profile}].`);
    await browser.close();
    return null;
  }

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error(`❌ Sessão [${profile}] expirada.`);
    await browser.close();
    return null;
  }

  console.log(`🟢 Sessão [${profile}] aberta com sucesso.`);
  return { browser, page };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const [,, command] = process.argv;

if (command === 'check' || command === 'check-monitor') {
  getSessionPage('monitor').then(async (r) => { if (r) await r.browser.close(); }).catch(console.error);
} else if (command === 'check-reply') {
  getSessionPage('reply').then(async (r) => { if (r) await r.browser.close(); }).catch(console.error);
}

module.exports = {
  launchBrowser,
  saveSession,
  loadSession,
  isLoggedIn,
  sessionsExist,
  getSessionPage,
  launchRemoteLogin,
  waitForLoginAndSave,
  CDP_PORT,
};