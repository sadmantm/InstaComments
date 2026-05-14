const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SESSION_PATH       = path.resolve('./session.json');
const SESSION_REPLY_PATH = path.resolve('./session_reply.json');

const USER_DATA_DIR       = path.resolve('./chrome_profile');
const USER_DATA_DIR_REPLY = path.resolve('./chrome_profile_reply');

// ─── Launch ──────────────────────────────────────────────────────────────────

async function launchBrowser(headless = false, userDataDir = USER_DATA_DIR) {
  return puppeteer.launch({
    headless: false,
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

// ─── Session helpers ─────────────────────────────────────────────────────────

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

  const session = { cookies, localStorage };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
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

// ─── Manual login ─────────────────────────────────────────────────────────────

/**
 * @param {'monitor' | 'reply'} profile  Qual perfil de sessão fazer login
 */
async function manualLogin(profile = 'monitor') {
  const isReply     = profile === 'reply';
  const sessionPath = isReply ? SESSION_REPLY_PATH : SESSION_PATH;
  const userDataDir = isReply ? USER_DATA_DIR_REPLY : USER_DATA_DIR;

  console.log(`🚀 Abrindo browser para login manual [perfil: ${profile}]...`);
  const browser = await launchBrowser(false, userDataDir);
  const page    = await browser.newPage();

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });

  console.log('👤 Faça o login manualmente no browser aberto.');
  console.log('⏳ Aguardando redirecionamento após login...\n');

  await page.waitForFunction(
    () => !window.location.href.includes('/accounts/login/'),
    { timeout: 120_000 }
  );

  console.log('✅ Login detectado!');
  await page.waitForNetworkIdle({ idleTime: 2000 }).catch(() => {});
  await saveSession(page, sessionPath);
  await browser.close();
}

// ─── Get session page ─────────────────────────────────────────────────────────

/**
 * Abre uma sessão autenticada.
 * @param {'monitor' | 'reply'} profile
 */
async function getSessionPage(profile = 'monitor') {
  const isReply     = profile === 'reply';
  const sessionPath = isReply ? SESSION_REPLY_PATH : SESSION_PATH;
  const userDataDir = isReply ? USER_DATA_DIR_REPLY : USER_DATA_DIR;

  const browser = await launchBrowser(true, userDataDir);
  const page    = await browser.newPage();

  const loaded = await loadSession(page, sessionPath);
  if (!loaded) {
    console.error(`❌ Sem sessão salva para [${profile}]. Rode: node instagram.js login-${profile}`);
    await browser.close();
    return null;
  }

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error(`❌ Sessão [${profile}] expirada. Rode: node instagram.js login-${profile}`);
    await browser.close();
    return null;
  }

  console.log(`🟢 Sessão [${profile}] aberta com sucesso.`);
  return { browser, page };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const [,, command] = process.argv;

if (command === 'login' || command === 'login-monitor') {
  manualLogin('monitor').catch(console.error);
} else if (command === 'login-reply') {
  manualLogin('reply').catch(console.error);
} else if (command === 'check' || command === 'check-monitor') {
  getSessionPage('monitor').then(async (r) => { if (r) await r.browser.close(); }).catch(console.error);
} else if (command === 'check-reply') {
  getSessionPage('reply').then(async (r) => { if (r) await r.browser.close(); }).catch(console.error);
}

module.exports = {
  launchBrowser,
  saveSession,
  loadSession,
  isLoggedIn,
  getSessionPage,
  manualLogin,
};