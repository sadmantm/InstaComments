//instagram.js
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
  loginBtn:   'button[type="submit"], [role="button"][aria-label="Log In"], [role="button"][aria-label="Entrar"]',
  twoFaInput: 'input[name="verificationCode"]',
  successEl:  'svg[aria-label="Home"], svg[aria-label="Início"], svg[aria-label="Notifications"], svg[aria-label="Notificações"]',
  errorAlert: '#twoFactorErrorAlert',
};

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchBrowser(headless = true, userDataDir = USER_DATA_DIR) {
  const isWindows = process.platform === 'win32';

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1280,800',
  ];

  // --single-process e --no-zygote são flags Linux/Docker
  // No Windows causam crash imediato do frame
  if (!isWindows) {
    args.push('--no-zygote', '--single-process');
  }

  return puppeteer.launch({
    headless: headless ? 'new' : false,
    userDataDir,
    args,
    defaultViewport: { width: 1280, height: 800 },
    // No Windows o Puppeteer às vezes não acha o Chrome — garante o caminho
    // Se der erro de executablePath, descomente e ajuste:
    // executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

  const username = await ask(rl, '👤 Usuário / e-mail / celular: ');
  const password = await ask(rl, '🔑 Senha: ');

  const browser = await launchBrowser(true, userDataDir);
  const page    = await browser.newPage();

  try {
    // 1. Abrir página de login
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await sleep(2000);

    // Alguns viewports exibem botão "Log in" antes do formulário
    const logInBtn = await page.evaluateHandle(() => {
      const btns = [...document.querySelectorAll('button[type="button"]')];
      return btns.find(b => /^(log\s*in|entrar)$/i.test(b.innerText.trim())) ?? null;
    }).then(h => h?.asElement()).catch(() => null);

    if (logInBtn) {
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
      page.waitForSelector(SEL.successEl, { timeout: 30_000 }).then(() => 'success'),
    
      page.waitForSelector(SEL.twoFaInput, { timeout: 30_000 }).then(() => '2fa'),
    
      page.waitForFunction(() => {
        // Log do link de reset
        const resetLink = document.querySelector('a[href*="/accounts/password/reset/"]');
        if (resetLink) {
          console.__orig?.call(console, '[CRED_CHECK] reset link encontrado:', resetLink.href);
          return true;
        }
      
        // Log do texto bruto da página
        const text = document.body?.innerText || '';
        console.__orig?.call(console, '[CRED_CHECK] innerText (primeiros 300):', text.slice(0, 300));
      
        return (
          text.includes('login information you entered is incorrect') ||
          text.includes('informações de login que você inseriu estão incorretas') ||
          text.includes('password you entered is incorrect') ||
          text.includes('your password was incorrect')
        );
      }, { timeout: 30_000 }).then(() => 'wrong_credentials'),
      
    ]).catch(() => 'timeout');
    
    if (result === 'success') {
      console.log('✅ Login bem-sucedido sem 2FA!');
      await saveSession(page, sessionPath);
      return;
    }
    
    if (result === 'wrong_credentials') {
      console.error('❌ Credenciais inválidas. Verifique usuário, e-mail, número ou senha.');
      return;
    }
    
    if (result === 'timeout') {
      console.error('❌ Timeout: nem sucesso, nem tela de 2FA, nem erro de credenciais foram detectados.');
      return;
    }

    if (result === 'success') {
      console.log('✅ Login bem-sucedido sem 2FA!');
      await saveSession(page, sessionPath);
      return;
    }

    if (result === 'wrong_credentials') {
      console.error('❌ Credenciais inválidas. Verifique usuário e senha.');
      return;
    }

    if (result === 'timeout') {
      console.error('❌ Timeout: nem sucesso nem tela de 2FA detectados.');
      return;
    }


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
        return btns.find(b => /authenticat(ion app|or app|ção)/i.test(b.innerText)) ?? null;
      }).then(h => h?.asElement()).catch(() => null);

      if (switchToApp) {
        const choice = await ask(rl, '🔄 Usar app de autenticação em vez de SMS? (s/N): ');
        if (choice.trim().toLowerCase() === 's') {
          await switchToApp.click();
          await sleep(1000);
          console.log('📲 Trocado para app de autenticação.');
        } else {
          console.log('📱 Código enviado por SMS.');
        }
      }
    } else if (isApp) {
      console.log('📲 Método atual: app de autenticação.');

      // Oferece trocar para SMS se o botão existir
      const switchToSms = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b => /^(sms|text message)$/i.test(b.innerText.trim())) ?? null;
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

      // Clica em Confirm/Confirmar buscando pelo texto (EN e PT)
      const confirmHandle = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('[role="button"]')];
        return btns.find(b => /^(confirm|confirmar)$/i.test(b.innerText.trim())) ?? null;
      });

      const el = confirmHandle && await confirmHandle.asElement();
      if (el) await el.click();
      else await page.keyboard.press('Enter');

      // Detecta sucesso pelo SVG de home (qualquer idioma) ou pela URL
      await page.waitForFunction(
        sel => !!document.querySelector(sel) || window.location.pathname === '/',
        { timeout: 15_000 },
        SEL.successEl
      ).catch(() => {});

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
async function getSessionPage(profile = 'monitor', opts = {}) {
  const isReply = profile === 'reply';

  const sessionPath =
    opts.sessionPath ||
    (isReply ? SESSION_REPLY_PATH : SESSION_PATH);

  const userDataDir =
    opts.userDataDir ||
    (isReply ? USER_DATA_DIR_REPLY : USER_DATA_DIR);

  const browser = await launchBrowser(true, userDataDir);
  const page = await browser.newPage();

  const loaded = await loadSession(page, sessionPath);
  if (!loaded) {
    console.error(`❌ Sem sessão salva para [${profile}] em: ${sessionPath}`);
    await browser.close();
    return null;
  }

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error(`❌ Sessão [${profile}] expirada em: ${sessionPath}`);
    await browser.close();
    return null;
  }

  console.log(`🟢 Sessão [${profile}] aberta com sucesso: ${sessionPath}`);
  return { browser, page };
}

// ─── Multi-user session helpers ───────────────────────────────────────────────

/**
 * Mapa interno de sessões pendentes de 2FA.
 * Chave: `${userId}:${profile}`
 */
const _pendingMap = new Map();

/**
 * Inicia login para um perfil de um usuário específico,
 * usando caminhos de sessão/userDataDir fornecidos externamente.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {'monitor'|'reply'} opts.profile
 * @param {string} opts.sessionPath   - caminho absoluto para o session.json do usuário
 * @param {string} opts.userDataDir   - caminho absoluto para o chrome profile do usuário
 * @returns {Promise<{requires2FA: boolean, profile: string}>}
 */
async function loginProfile({ userId, username, password, profile, sessionPath, userDataDir }) {
  const prevKey = `${userId}:${profile}`;
  const prev = _pendingMap.get(prevKey);
  if (prev) { try { await prev.browser.close(); } catch (_) {} _pendingMap.delete(prevKey); }

  console.log(`[${profile}] launchBrowser userDataDir=${userDataDir}`);
  const browser = await launchBrowser(true, userDataDir);

  // Detecta se o browser caiu sozinho
  browser.on('disconnected', () => {
    console.error(`[${profile}] ⚠️  Browser DISCONNECTED inesperadamente`);
  });

  const pages = await browser.pages();
  const page  = pages[0] || await browser.newPage();

  // Captura erros de frame/página
  page.on('error',           err => console.error(`[${profile}] page error: ${err.message}`));
  page.on('framedetached',   frm => console.warn (`[${profile}] frame detached: ${frm.url()}`));
  page.on('framenavigated',  frm => console.log  (`[${profile}] frame navigated: ${frm.url()}`));

  try {
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await sleep(2000);
    const logInBtn = await page.evaluateHandle(() => {
      const btns = [...document.querySelectorAll('button[type="button"]')];
      return btns.find(b => /^(log\s*in|entrar)$/i.test(b.innerText.trim())) ?? null;
    }).then(h => h?.asElement()).catch(() => null);
    if (logInBtn) { await logInBtn.click(); await sleep(1000); }

  
    await page.waitForSelector(SEL.username, { timeout: 30_000, visible: true });

    await sleep(300);
    await page.type(SEL.username, username, { delay: 55 });

    await page.waitForSelector(SEL.password, { timeout: 10_000 });
    console.log(`[${profile}] STEP 4 OK`);

    await page.type(SEL.password, password, { delay: 55 });
    await sleep(400);

    await page.waitForSelector(SEL.loginBtn, { timeout: 10_000 });

    await page.click(SEL.loginBtn);
    console.log(`[${profile}] STEP 6 OK — aguardando outcome...`);

    const outcome = await Promise.race([
      page.waitForSelector(SEL.successEl,  { timeout: 30_000 }).then(() => 'success'),
      page.waitForSelector(SEL.twoFaInput, { timeout: 30_000 }).then(() => '2fa'),

      new Promise((resolve) => {
        let stopped = false;
        const poll = async () => {
          while (!stopped) {
            try {
              const found = await page.evaluate(() => {
                const text = document.body?.innerText || '';
                return (
                  text.includes('login information you entered is incorrect') ||
                  text.includes('informações de login que você inseriu estão incorretas') ||
                  text.includes('The login information you entered is incorrect') ||
                  text.includes('As informações de login que você inseriu estão incorretas')
                );
              });
              if (found) { stopped = true; resolve('wrong_credentials'); return; }
            } catch (_) {}
            await sleep(500);
          }
        };
        poll();
        setTimeout(() => { stopped = true; }, 31_000);
      }),
    ]).catch(err => {
      console.error(`[${profile}] race erro: ${err.message}`);
      return 'timeout';
    });

    if (outcome === 'wrong_credentials') {
      await browser.close();
      throw Object.assign(new Error('Credenciais inválidas.'), { code: 'WRONG_CREDENTIALS' });
    }
    if (outcome === 'timeout') {
      await browser.close();
      throw Object.assign(new Error(`[${profile}] Sem resposta do Instagram.`), { code: 'TIMEOUT' });
    }
    if (outcome === '2fa') {
      _pendingMap.set(prevKey, { browser, page, sessionPath, username });
      return { requires2FA: true, profile };
    }

    // success
    await saveSession(page, sessionPath);
    await browser.close();
    return { requires2FA: false, profile };

  } catch (err) {
    console.error(`[${profile}] FALHOU no step — ${err.message}`);
    console.error(`[${profile}] stack: ${err.stack?.split('\n')[1]}`);

    if (err.code !== 'WRONG_CREDENTIALS') {
      try { await browser.close(); } catch (_) {}
    }
    _pendingMap.delete(prevKey);
    throw err;
  }
}


/**
 * Faz login nos dois perfis (monitor + reply) para um usuário.
 * Retorna `{ requires2FA: true }` se qualquer um precisar de 2FA.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {function} opts.getSessionPath  - (userId, profile) => string
 * @param {function} opts.getUserDataDir  - (userId, profile) => string
 */
async function connectUser({ userId, username, password, getSessionPath, getUserDataDir }) {
  // 1. Login do perfil monitor
  const monitorResult = await loginProfile({
    userId, username, password,
    profile: 'monitor',
    sessionPath: getSessionPath(userId, 'monitor'),
    userDataDir: getUserDataDir(userId, 'monitor'),
  });

  // 2. Se monitor precisar de 2FA, para aqui e aguarda verify2FAUser ser chamado
  //    O caller deve verificar requires2FA e só continuar após resolver
  if (monitorResult.requires2FA) {
    // Armazena credenciais para reuso no reply após o 2FA
    _pendingMap.set(`${userId}:_credentials`, { username, password, getSessionPath, getUserDataDir });
    return { requires2FA: true, pendingProfile: 'monitor', username };
  }

  // 3. Monitor ok sem 2FA — login do reply imediatamente
  const replyResult = await loginProfile({
    userId, username, password,
    profile: 'reply',
    sessionPath: getSessionPath(userId, 'reply'),
    userDataDir: getUserDataDir(userId, 'reply'),
  });

  if (replyResult.requires2FA) {
    _pendingMap.set(`${userId}:_credentials`, { username, password, getSessionPath, getUserDataDir });
    return { requires2FA: true, pendingProfile: 'reply', username };
  }

  return { requires2FA: false, username };
}


/**
 * Verifica o código 2FA para um perfil específico de um usuário.
 *
 * @param {string} userId
 * @param {'monitor'|'reply'} profile
 * @param {string} code
 */
async function verify2FAProfile(userId, profile, code) {
  const key     = `${userId}:${profile}`;
  const session = _pendingMap.get(key);
  if (!session) throw new Error(`Nenhuma sessão 2FA pendente para [${profile}].`);

  const { browser, page, sessionPath } = session;

  try {
    await page.click(SEL.twoFaInput, { clickCount: 3 });
    await page.type(SEL.twoFaInput, code.trim(), { delay: 70 });
    await sleep(300);

    const confirmEl = await page.evaluateHandle(() => {
      const b = [...document.querySelectorAll('[role="button"]')];
      return b.find(x => /^(confirm|confirmar)$/i.test(x.innerText.trim())) ?? null;
    }).then(h => h?.asElement()).catch(() => null);

    if (confirmEl) await confirmEl.click();
    else await page.keyboard.press('Enter');

    const r = await Promise.race([
      page.waitForSelector(SEL.successEl, { timeout: 15_000 }).then(() => 'success'),
      page.waitForFunction(
        sel => { const n = document.querySelector(sel); return n && n.textContent.trim() !== 'SMS enviado.'; },
        { timeout: 15_000 }, SEL.errorAlert
      ).then(() => 'error'),
    ]).catch(() => 'timeout');

    if (r === 'error') {
      const msg = await page.$eval(SEL.errorAlert, e => e.textContent.trim()).catch(() => '');
      // NÃO fecha o browser — permite nova tentativa
      throw Object.assign(new Error(msg || `[${profile}] Código inválido ou expirado.`), { code: 'INVALID_2FA' });
    }

    if (r === 'timeout') {
      const ok = await page.$(SEL.successEl).then(e => !!e).catch(() => false);
      if (!ok) throw Object.assign(new Error(`[${profile}] Tempo esgotado.`), { code: 'TIMEOUT' });
    }

    await saveSession(page, sessionPath);
    _pendingMap.delete(key);
    await browser.close();

  } catch (err) {
    // Só limpa se não for erro de código inválido (para permitir nova tentativa)
    if (err.code !== 'INVALID_2FA') {
      try { await browser.close(); } catch (_) {}
      _pendingMap.delete(key);
    }
    throw err;
  }
}

/**
 * Verifica 2FA nos dois perfis simultaneamente.
 *
 * @param {string} userId
 * @param {string} code
 * @returns {Promise<{ok: boolean, username: string|null}>}
 */
async function verify2FAUser(userId, code) {
  const hasMon   = _pendingMap.has(`${userId}:monitor`);
  const hasReply = _pendingMap.has(`${userId}:reply`);

  if (!hasMon && !hasReply) throw new Error('Nenhuma sessão 2FA pendente. Reinicie o processo.');

  // Valida o perfil que está pendente de 2FA
  const pendingProfile = hasMon ? 'monitor' : 'reply';
  await verify2FAProfile(userId, pendingProfile, code);

  // Se era o monitor, agora conecta o reply com as credenciais salvas
  if (pendingProfile === 'monitor') {
    const creds = _pendingMap.get(`${userId}:_credentials`);
    if (creds) {
      _pendingMap.delete(`${userId}:_credentials`);
      const { username, password, getSessionPath, getUserDataDir } = creds;

      const replyResult = await loginProfile({
        userId, username, password,
        profile: 'reply',
        sessionPath: getSessionPath(userId, 'reply'),
        userDataDir: getUserDataDir(userId, 'reply'),
      });

      // Reply também pode pedir 2FA (conta com 2FA em ambos os perfis é raro mas possível)
      if (replyResult.requires2FA) {
        _pendingMap.set(`${userId}:_credentials`, creds);
        return { ok: false, requires2FA: true, pendingProfile: 'reply' };
      }
    }
  }

  return { ok: true };
}


/**
 * Tenta reenviar o SMS/código 2FA clicando no botão da página pendente.
 *
 * @param {string} userId
 * @param {'monitor'|'reply'} [profile='monitor']
 * @returns {Promise<boolean>}
 */
async function resend2FA(userId, profile = 'monitor') {
  const session = _pendingMap.get(`${userId}:${profile}`);
  if (!session) return false;
  return session.page.evaluate(() => {
    const el = [...document.querySelectorAll('button,[role="button"],a')]
      .find(b => /(send sms|resend|reenviar|enviar sms)/i.test(b.innerText));
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);
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
  loginProfile,
  connectUser,
  verify2FAProfile,
  verify2FAUser,
  resend2FA,
};