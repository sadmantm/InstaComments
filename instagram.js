const puppeteer = require('puppeteer');
const readline  = require('readline');
const fs        = require('fs');
const path      = require('path');

const SESSION_PATH       = path.resolve('./session.json');
const SESSION_REPLY_PATH = path.resolve('./session_reply.json');

const USER_DATA_DIR       = path.resolve('./chrome_profile');
const USER_DATA_DIR_REPLY = path.resolve('./chrome_profile_reply');

// ─── Selectors ────────────────────────────────────────────────────────────────

const SEL = {
  username:   'input[name="email"]',
  password:   'input[name="pass"]',
  loginBtn:   '[aria-label="Entrar"]',
  twoFaInput: 'input[name="verificationCode"]',
  successEl:  'svg[aria-label="Notificações"]',
  errorAlert: '#twoFactorErrorAlert',
};

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchBrowser(headless = false, userDataDir = USER_DATA_DIR) {
  return puppeteer.launch({
    headless: "new",
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
    defaultViewport: { width: 1280, height: 800 },
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

// ─── Helpers internos ─────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Login headless ───────────────────────────────────────────────────────────

/**
 * Faz login via terminal sem interface gráfica.
 * @param {'monitor' | 'reply'} profile
 */
async function login(profile = 'monitor') {
  const isReply     = profile === 'reply';
  const sessionPath = isReply ? SESSION_REPLY_PATH : SESSION_PATH;
  const userDataDir = isReply ? USER_DATA_DIR_REPLY : USER_DATA_DIR;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n🔐 Login headless no Instagram [perfil: ${profile}]\n`);

  const username = await ask(rl, '👤 Usuário / e-mail / celular: ');
  const password = await ask(rl, '🔑 Senha: ');

  const browser = await launchBrowser(true, userDataDir);
  const page    = await browser.newPage();

  try {
    // 1. Abrir página de login
    console.log('\n⏳ Abrindo página de login...');
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await sleep(2000);

    // Alguns viewports exibem botão "Log in" antes do formulário
    const logInBtn = await page.$('button[type="button"]').then(async btn => {
      if (!btn) return null;
      const txt = await btn.evaluate(el => el.innerText.trim());
      return txt === 'Log in' ? btn : null;
    }).catch(() => null);

    if (logInBtn) {
      console.log('🔘 Botão "Log in" detectado, clicando...');
      await logInBtn.click();
      await sleep(1000);
    }

    // 2. Preencher credenciais
    await page.waitForSelector(SEL.username, { timeout: 30_000, visible: true });
    await sleep(500);
    await page.type(SEL.username, username, { delay: 60 });

    await page.waitForSelector(SEL.password, { timeout: 10_000 });
    await page.type(SEL.password, password, { delay: 60 });

    await sleep(500);

    // 3. Clicar em Entrar
    await page.waitForSelector(SEL.loginBtn, { timeout: 10_000 });
    await page.click(SEL.loginBtn);
    console.log('🚀 Credenciais enviadas, aguardando resposta...');

    // 4. Aguarda sucesso OU tela de 2FA
    const result = await Promise.race([
      page.waitForSelector(SEL.successEl,  { timeout: 30_000 }).then(() => 'success'),
      page.waitForSelector(SEL.twoFaInput, { timeout: 30_000 }).then(() => '2fa'),
    ]).catch(() => 'timeout');

    if (result === 'success') {
      console.log('✅ Login bem-sucedido sem 2FA!');
      await saveSession(page, sessionPath);
      return;
    }

    if (result === 'timeout') {
      console.error('❌ Timeout: nem sucesso nem tela de 2FA detectados.');
      return;
    }

    // 5. Fluxo 2FA
    console.log('\n🔒 Verificação em 2 etapas detectada.');

    const desc = await page.$eval(
      '#verificationCodeDescription',
      el => el.textContent.trim()
    ).catch(() => '');

    const isSms = desc.toLowerCase().includes('sms');
    const isApp = desc.toLowerCase().includes('app');

    if (isSms) {
      console.log('📱 Método atual: SMS.');

      // Oferece trocar para app autenticador se o botão existir
      const switchToApp = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b => b.innerText.includes('app de autenticação')) ?? null;
      }).then(h => h?.asElement()).catch(() => null);

      if (switchToApp) {
        const choice = await ask(rl, '🔄 Usar app de autenticação em vez de SMS? (s/N): ');
        if (choice.trim().toLowerCase() === 's') {
          await switchToApp.click();
          await sleep(1000);
          console.log('📲 Trocado para app de autenticação.');
        } else {
          console.log('📱 Código enviado por SMS ao número cadastrado.');
        }
      }
    } else if (isApp) {
      console.log('📲 Método atual: app de autenticação.');

      // Oferece trocar para SMS se o botão existir
      const switchToSms = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b => b.innerText.trim() === 'SMS') ?? null;
      }).then(h => h?.asElement()).catch(() => null);

      if (switchToSms) {
        const choice = await ask(rl, '🔄 Receber código por SMS em vez do app? (s/N): ');
        if (choice.trim().toLowerCase() === 's') {
          await switchToSms.click();
          await sleep(1000);
          console.log('📱 Código SMS enviado ao número cadastrado.');
        } else {
          console.log('📲 Use seu app de autenticação para obter o código.');
        }
      }
    } else if (desc) {
      console.log(`ℹ️  ${desc}`);
    }

    let attempts = 0;
    while (attempts < 3) {
      const code = await ask(rl, '\n🔢 Digite o código de 6 dígitos: ');

      await page.click(SEL.twoFaInput, { clickCount: 3 });
      await page.type(SEL.twoFaInput, code.trim(), { delay: 80 });
      await sleep(300);

      // Clica em Confirmar buscando pelo texto (mais resiliente que seletor de classe)
      const confirmHandle = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('[role="button"]')];
        return btns.find(b => b.innerText.trim() === 'Confirmar') ?? null;
      });

      const el = confirmHandle && await confirmHandle.asElement();
      if (el) await el.click();
      else await page.keyboard.press('Enter');

      console.log('⏳ Verificando código...');

      const r2 = await Promise.race([
        page.waitForSelector(SEL.successEl, { timeout: 15_000 }).then(() => 'success'),
        page.waitForFunction(
          sel => {
            const node = document.querySelector(sel);
            return node && node.textContent.trim() !== 'SMS enviado.';
          },
          { timeout: 15_000 },
          SEL.errorAlert
        ).then(() => 'error'),
      ]).catch(() => 'timeout');

      if (r2 === 'success') {
        console.log('✅ Código correto! Login bem-sucedido.');
        await saveSession(page, sessionPath);
        return;
      }

      if (r2 === 'error') {
        const msg = await page.$eval(SEL.errorAlert, e => e.textContent.trim()).catch(() => '');
        console.error(`❌ Código inválido${msg ? ': ' + msg : ''}. Tente novamente.`);
        attempts++;
        continue;
      }

      // timeout — verifica se chegou na home mesmo assim
      const loggedIn = await page.$(SEL.successEl).then(e => !!e).catch(() => false);
      if (loggedIn) {
        console.log('✅ Login detectado.');
        await saveSession(page, sessionPath);
        return;
      }

      console.error('❌ Sem resposta clara do servidor.');
      attempts++;
    }

    console.error('🚫 Máximo de tentativas de 2FA atingido.');

  } catch (err) {
    console.error('💥 Erro inesperado:', err.message);
    try {
      const ss = path.resolve(`./error_${profile}_${Date.now()}.png`);
      await page.screenshot({ path: ss, fullPage: true });
      console.error(`📸 Screenshot salvo em: ${ss}`);
    } catch (_) {}
  } finally {
    rl.close();
    await browser.close();
  }
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

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'login-monitor') login('monitor');
  else if (cmd === 'login-reply') login('reply');
  else console.log('Uso: node instagram.js login-monitor  |  node instagram.js login-reply');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  launchBrowser,
  saveSession,
  loadSession,
  isLoggedIn,
  login,
  getSessionPage,
  SESSION_PATH,
  SESSION_REPLY_PATH,
  USER_DATA_DIR,
  USER_DATA_DIR_REPLY,
};