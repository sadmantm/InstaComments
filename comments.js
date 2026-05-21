const fs = require('fs');
const path = require('path');
const { launchBrowser, loadSession, getSessionPage } = require('./instagram');
const { EventEmitter } = require('events');

const DEFAULT_DB_PATH = path.resolve('./comments.json');

function loadDB(commentsPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(commentsPath)) return {};
  return JSON.parse(fs.readFileSync(commentsPath, 'utf-8'));
}

function saveDB(db, commentsPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(commentsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(commentsPath, JSON.stringify(db, null, 2));
}

function markAsReplied(db, key, replyText, commentsPath = DEFAULT_DB_PATH) {
  if (!db[key]) return;

  db[key].replied = true;
  db[key].repliedAt = new Date().toISOString();
  db[key].replyText = replyText;

  saveDB(db, commentsPath);
}

function registerComment(db, comment) {
  const key = `${comment.username}::${comment.postShortcode}::${comment.commentId}`;
  if (db[key]) return false;
  db[key] = {
    ...comment,
    postUrl: comment.postUrl || `https://www.instagram.com/p/${comment.postShortcode}/`,
    replied: false,
    repliedAt: null,
    replyText: null,
    seenAt: new Date().toISOString(),
  };
  return true;
}

function getPendingComments(db) {
  return Object.entries(db)
    .filter(([k]) => !k.startsWith('__'))
    .filter(([, v]) => !v.replied)
    .map(([key, v]) => ({ key, ...v }));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dismissModals(page) {
  await page.evaluate(() => {
    const dismissLabels = [
      'Not Now', 'Agora não',   // notificações
      'Close',   'Fechar',      // genérico
      'Cancel',  'Cancelar',
    ];
    const btns = [...document.querySelectorAll('button')];
    for (const btn of btns) {
      if (dismissLabels.some(l => btn.innerText.trim() === l)) {
        btn.click();
        return;
      }
    }
  });
  await sleep(800);
}

async function openCommentsTab(page, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[tab] Tentativa ${attempt}/${maxRetries} de abrir painel de notificações...`);

    try {
      // ── 0. Fechar qualquer modal bloqueando ──────────────────────────────
      await dismissModals(page);

      // ── 1. Clicar no ícone de notificações ──────────────────────────────
      const notifClicked = await page.evaluate(() => {
        const labels = ['Notifications', 'Notificações'];
        const strategies = [
          // SVG aria-label → link ancestral
          () => {
            for (const label of labels) {
              const svgs = [...document.querySelectorAll(`svg[aria-label="${label}"]`)];
              for (const svg of svgs) {
                const link = svg.closest('a[role="link"]') || svg.closest('a');
                if (link) { link.click(); return `svg[${label}]→a`; }
              }
            }
            return null;
          },
          // SVG click direto
          () => {
            for (const label of labels) {
              const svg = document.querySelector(`svg[aria-label="${label}"]`);
              if (svg) { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })); return `svg[${label}] direto`; }
            }
            return null;
          },
          // <title> dentro do SVG
          () => {
            const titles = [...document.querySelectorAll('title')];
            const t = titles.find(el => labels.includes(el.textContent.trim()));
            if (t) {
              const link = t.closest('a[role="link"]') || t.closest('a');
              if (link) { link.click(); return 'title→a'; }
            }
            return null;
          },
          // aria-label direto no elemento
          () => {
            for (const label of labels) {
              const el = document.querySelector(`[aria-label="${label}"]`);
              if (el) { el.click(); return `aria-label[${label}]`; }
            }
            return null;
          },
        ];
        for (const fn of strategies) {
          const r = fn();
          if (r) return r;
        }
        return null;
      });

      if (!notifClicked) throw new Error('Ícone de notificações não encontrado.');
      console.log(`[tab] Ícone clicado via: ${notifClicked}`);
      await sleep(2000);

      // ── 2. Aguardar painel abrir ─────────────────────────────────────────
      await page.waitForFunction(
        () => {
          const btns = [...document.querySelectorAll('[role="button"]')];
          return btns.some(b => /^(comentários|comments|tudo|all)$/i.test(b.innerText?.trim()));
        },
        { timeout: 10000 }
      );
      console.log('[tab] Painel aberto.');

      // ── 3. Clicar na aba Comentários / Comments ──────────────────────────
      const tabClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="button"]')];
        const btn = btns.find(b => /^(comentários|comments)$/i.test(b.innerText?.trim()));
        if (btn) { btn.click(); return btn.innerText.trim(); }
        return null;
      });

      if (!tabClicked) throw new Error('Aba Comments não encontrada.');
      console.log(`[tab] Aba "${tabClicked}" clicada.`);
      await sleep(2000);

      // ── 4. Confirmar que comentários carregaram ───────────────────────────
      await page.waitForFunction(
        () => document.querySelectorAll('[data-pressable-container="true"]').length > 0,
        { timeout: 10000 }
      );
      console.log('[tab] ✅ Comentários carregados.');
      return;

    } catch (err) {
      console.warn(`[tab] ⚠️ Tentativa ${attempt} falhou: ${err.message}`);
      if (attempt < maxRetries) {
        console.log('[tab] Recarregando...');
        try {
          await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 20000 });
          await sleep(2000);
        } catch (e) { console.warn('[tab] Falha ao recarregar:', e.message); }
      } else {
        throw new Error(`[tab] Falha após ${maxRetries} tentativas: ${err.message}`);
      }
    }
  }
}

async function scrapeVisibleComments(page) {
  console.log('[scrape] Extraindo comentários visíveis...');

  const results = await page.evaluate(() => {
    function fakeId(username, postShortcode, text) {
      const raw = `${username}::${postShortcode}::${text}`;
      return 'fake_' + raw.split('').reduce((a, c) => Math.imul(31, a) + c.charCodeAt(0) | 0, 0).toString(36);
    }

    function extractCommentText(container) {
      // O span principal contém "username commented: texto" ou "username comentou: texto"
      // Queremos apenas o texto após o ": "
      const mainSpan = container.querySelector('span[dir="auto"]');
      if (!mainSpan) return '';

      // Clona o span para manipular sem alterar o DOM
      const clone = mainSpan.cloneNode(true);

      // Remove elementos de tempo (abbr/span com hora)
      clone.querySelectorAll('abbr, time').forEach(el => el.remove());

      // Remove o botão "more" / "mais"
      clone.querySelectorAll('[role="button"]').forEach(el => el.remove());

      let raw = clone.innerText || clone.textContent || '';

      // Remove prefixo "username commented:" ou "username comentou:"
      raw = raw.replace(/^.*?(?:commented|comentou)\s*:\s*/i, '');

      // Remove menção inicial @username se existir
      raw = raw.replace(/^@\S+\s*/, '');

      // Remove timestamp no final (ex: "4h", "1d", "14 hours ago")
      raw = raw.replace(/\s*\d+[hdsm]\s*$/, '').replace(/\s*\d+\s+\w+\s+ago\s*$/i, '');

      return raw.trim();
    }

    const results = [];
    const containers = document.querySelectorAll('[data-pressable-container="true"]');

    for (const container of containers) {
      try {
        // Username: span com classe _ap3a
        const usernameEl = container.querySelector('span._ap3a._aaco._aacw._aacx._aad7._aade');
        if (!usernameEl) continue;
        const username = usernameEl.innerText.trim();
        if (!username) continue;

        // Link da mídia: aria-label="Media thumbnail" ou "Miniatura de mídia"
        const mediaLink =
          container.querySelector('a[aria-label="Media thumbnail"]') ||
          container.querySelector('a[aria-label="Miniatura de mídia"]');
        if (!mediaLink) continue;

        const postHref = mediaLink.getAttribute('href') || '';
        const postMatch = postHref.match(/\/p\/([^/]+)\//);
        if (!postMatch) continue;

        const postShortcode = postMatch[1];
        const postUrl = `https://www.instagram.com${postHref}`;

        // Thumbnail
        const thumbImg = mediaLink.querySelector('img');
        const thumbnailUrl = thumbImg?.src || '';

        // Comment ID via link /c/
        const commentLink = container.querySelector('a[href*="/c/"]');
        let commentId = '';
        let commentDatetime = '';
        if (commentLink) {
          const href = commentLink.getAttribute('href') || '';
          const cMatch = href.match(/\/c\/([^/]+)\//);
          if (cMatch) commentId = cMatch[1];
          const timeEl = commentLink.querySelector('time[datetime]');
          if (timeEl) commentDatetime = timeEl.getAttribute('datetime') || '';
        }

        // Tempo via abbr (fallback)
        const abbrEl = container.querySelector('abbr[aria-label]');
        const timeLabel = abbrEl?.getAttribute('aria-label') || '';

        // Texto do comentário
        // Texto do comentário
const text = extractCommentText(container);

if (!commentId) commentId = fakeId(username, postShortcode, text);

// Foto de perfil
const profileImg = [...container.querySelectorAll('img')].find(img => {
  const alt = (img.getAttribute('alt') || '').toLowerCase();
  const src = img.getAttribute('src') || '';

  const isProfilePic =
    alt.includes('foto do perfil') ||
    alt.includes('profile picture');

  const isMediaThumb =
    alt.includes('miniatura de mídia') ||
    alt.includes('media thumbnail');

  const looksLikeProfileUrl =
    src.includes('/t51.82787-19/') ||
    src.includes('profile_pic') ||
    src.includes('s150x150');

  return isProfilePic && !isMediaThumb && looksLikeProfileUrl;
});

const profilePic = profileImg?.src || '';

if (username && postShortcode) {
  results.push({
    username,
    text,
    postShortcode,
    postUrl,
    thumbnailUrl,
    postTitle: '',
    commentId,
    datetime: commentDatetime,
    timeLabel,
    profilePic,
  });
}

        if (username && postShortcode) {
          results.push({
            username,
            text,
            postShortcode,
            postUrl,
            thumbnailUrl,
            postTitle: '',
            commentId,
            datetime: commentDatetime,
            timeLabel,
            profilePic,
          });
        }
      } catch (e) {
        console.warn('[scrape] Erro ao processar container:', e.message);
      }
    }

    return results;
  });

  console.log(`[scrape] ${results.length} comentário(s) extraído(s).`);
  return results;
}

async function scrollPanel(page, maxScrolls = 10) {
  console.log(`[scroll] Localizando painel de notificações...`);

  // Estratégia: identifica o painel UMA vez pelo seu conteúdo estrutural.
  // O painel é o menor ancestral scrollável que contém TODOS os
  // [data-pressable-container] — não apenas um filho qualquer.
  // Guardamos um "fingerprint" (scrollHeight inicial) para detectar
  // se o DOM foi substituído e re-localizar se necessário.
  const findPanel = () => page.evaluate(() => {
    // Pega o primeiro pressable como âncora
    const anchor = document.querySelector('[data-pressable-container="true"]');
    if (!anchor) return null;

    // Sobe na árvore a partir do anchor até achar o scrollável
    let node = anchor.parentElement;
    while (node && node !== document.documentElement) {
      const s = window.getComputedStyle(node);
      if (
        (s.overflowY === 'scroll' || s.overflowY === 'auto') &&
        node.scrollHeight > node.clientHeight
      ) {
        const r = node.getBoundingClientRect();
        return {
          scrollTop  : node.scrollTop,
          scrollHeight: node.scrollHeight,
          centerX    : r.left + r.width  / 2,
          centerY    : r.top  + r.height / 2,
        };
      }
      node = node.parentElement;
    }
    return null;
  });

  // Scroll: volta ao nó via mesma lógica de âncora e incrementa scrollTop
  const doScroll = (amount) => page.evaluate((amount) => {
    const anchor = document.querySelector('[data-pressable-container="true"]');
    if (!anchor) return { scrolled: false, reason: 'sem anchor' };
    let node = anchor.parentElement;
    while (node && node !== document.documentElement) {
      const s = window.getComputedStyle(node);
      if (
        (s.overflowY === 'scroll' || s.overflowY === 'auto') &&
        node.scrollHeight > node.clientHeight
      ) {
        const before = node.scrollTop;
        node.scrollTop += amount;
        return { scrolled: node.scrollTop !== before, reason: 'ok' };
      }
      node = node.parentElement;
    }
    return { scrolled: false, reason: 'scrollável não encontrado' };
  }, amount);

  const info = await findPanel();
  if (!info) {
    console.warn('[scroll] Painel não encontrado, abortando.');
    return;
  }

  console.log(`[scroll] Painel localizado. Iniciando scroll (máx ${maxScrolls} vezes)...`);

  // Posiciona o mouse sobre o painel para ativar o hover
  await page.mouse.move(info.centerX, info.centerY);
  await sleep(150);

  for (let i = 0; i < maxScrolls; i++) {
    const { scrolled, reason } = await doScroll(600);
    if (!scrolled) {
      console.log(`[scroll] Fim do painel no scroll ${i + 1} (${reason}).`);
      break;
    }
    console.log(`[scroll] Scroll ${i + 1} OK.`);
    await sleep(1500);
  }
}

// ─── Helper JS injetado na página do post ────────────────────────────────────
const helperSrc = `
  function normText(v) { return (v||'').replace(/\\s+/g,' ').trim().toLowerCase(); }

  function getCommentText(container, username) {
    const els = [...container.querySelectorAll('span[dir="auto"]')];
    for (const el of els) {
      if (el.querySelector('time')) continue;
      const t = el.innerText.trim();
      if (!t || t === username || t === 'Responder') continue;
      if (/^\\d+\\s+curtida/.test(t.toLowerCase())) continue;
      return t;
    }
    return '';
  }

  function getActionRow(container) {
    const buttons = [...container.querySelectorAll('[role="button"]')];
    for (const btn of buttons) {
      if (btn.innerText.trim() === 'Responder') return btn.parentElement;
    }
    return null;
  }

  function getReplyButton(container) {
    const row = getActionRow(container);
    if (!row) return null;
    return [...row.querySelectorAll('[role="button"]')].find(b => b.innerText.trim() === 'Responder') || null;
  }

  function getLikeButton(container) {
    const row = getActionRow(container);
    if (!row) return null;
    return [...row.parentElement.querySelectorAll('[role="button"]')].find(b => !!b.querySelector('svg[aria-label="Curtir"]')) || null;
  }

  function hasReplyButton(c) { return !!getReplyButton(c); }

  function scoreContainer(container, target) {
    let score = 0;
    const link  = container.querySelector('a[href*="/c/"]');
    const href  = link ? (link.getAttribute('href')||'') : '';
    if (target.commentId && href.includes('/c/'+target.commentId+'/')) score += 1000;
    const timeEl = container.querySelector('time[datetime]');
    const dt = timeEl ? (timeEl.getAttribute('datetime')||'') : '';
    if (target.datetime && dt === target.datetime) score += 500;
    const text   = normText(getCommentText(container, target.username));
    const wanted = normText(target.text);
    if (wanted && text === wanted) score += 300;
    else if (wanted && text.includes(wanted)) score += 150;
    else if (wanted) {
      for (let len = Math.min(wanted.length, text.length); len >= 6; len--) {
        if (text.includes(wanted.slice(0,len))) { score += len; break; }
      }
    }
    return score;
  }

  function collectCandidates(targetUsername) {
    const seen = new Set(); const out = [];
    for (const el of document.querySelectorAll('span._ap3a._aaco._aacw._aacx._aad7._aade')) {
      if (normText(el.innerText) !== normText(targetUsername)) continue;
      let node = el;
      for (let i = 0; i < 15 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        if (!hasReplyButton(node)) continue;
        if (seen.has(node)) break;
        seen.add(node); out.push(node); break;
      }
    }
    return out;
  }

  function resolveTargetContainer(target) {
    const byId = target.commentId ? document.querySelector('a[href*="/c/'+target.commentId+'/"]') : null;
    if (byId) {
      let node = byId;
      for (let i = 0; i < 15 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        if (hasReplyButton(node)) return node;
      }
    }
    const candidates = collectCandidates(target.username);
    if (!candidates.length) return null;
    let best = null, bestScore = -1;
    for (const c of candidates) {
      const s = scoreContainer(c, target);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  }

  function clickContainer(container, doLike) {
    const replyBtn = getReplyButton(container);
    if (!replyBtn) return false;
    const likeBtn = getLikeButton(container);
    if (doLike && likeBtn) likeBtn.click();
    replyBtn.click();
    return true;
  }
`;

async function replyToComment(
  commentKey,
  replyText,
  {
    like = true,
    maxRetries = 3,
    commentsPath = DEFAULT_DB_PATH,
    sessionPath = null,
    userDataDir = null,
  } = {}
) {
  const db = loadDB(commentsPath);
  const comment = db[commentKey];

  if (!comment) throw new Error('Comentário não encontrado: ' + commentKey);
  if (comment.replied) {
    console.log(`[reply] @${comment.username} já respondido, pulando.`);
    return;
  }

  const { username, text: commentText, postShortcode, commentId, datetime: commentDatetime } = comment;
  const isFakeId = commentId.startsWith('fake_');
  const postUrl = comment.postUrl || `https://www.instagram.com/p/${postShortcode}/`;

  console.log(`\n[reply] Iniciando resposta para @${username}`);
  console.log(`[reply] Post: ${postUrl}`);
  console.log(`[reply] commentId: ${commentId} | isFakeId: ${isFakeId}`);
  console.log(`[reply] Texto do comentário: "${commentText}"`);
  console.log(`[reply] Resposta a postar: "${replyText.slice(0, 80)}"`);

  console.log('[reply] Abrindo sessão dedicada [reply]...');

  const session = await getSessionPage('reply', {
    sessionPath,
    userDataDir,
  });

  if (!session) throw new Error('Sem sessão reply. Conecte o Instagram novamente.');

  const { browser, page } = session;
  let lastError;

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        const wait = attempt * 5000;
        console.log(`[reply] Tentativa ${attempt}/${maxRetries} em ${wait}ms...`);
        await sleep(wait);
      } else {
        console.log(`[reply] Tentativa 1/${maxRetries}`);
      }

      try {
        console.log(`[reply] Navegando para ${postUrl}...`);
        await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2000);

        const currentUrl = page.url();
        console.log(`[reply] URL atual: ${currentUrl}`);

        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('/accounts/login')) {
          throw new Error('Redirecionado para login — sessão reply expirada.');
        }

        console.log('[reply] Procurando container do comentário...');

        const clickResult = await page.evaluate(
          (target, doLike, src) => {
            eval(src);
            const container = resolveTargetContainer(target);
            if (!container) return { clicked: false, reason: 'container não encontrado' };
            const ok = clickContainer(container, doLike);
            return { clicked: ok, reason: ok ? 'ok' : 'botão Responder ausente no container' };
          },
          {
            username,
            text: commentText,
            datetime: commentDatetime || '',
            commentId: isFakeId ? '' : commentId,
          },
          like,
          helperSrc
        );

        console.log(`[reply] Resultado do clique: clicked=${clickResult.clicked} | reason=${clickResult.reason}`);

        if (!clickResult.clicked) {
          throw new Error(`Botão "Responder" não encontrado para @${username}: ${clickResult.reason}`);
        }

        await sleep(1500);

console.log('[reply] Aguardando textarea...');

const textarea = await page.waitForSelector(
  'textarea[placeholder="Adicione um comentário..."]',
  { visible: true, timeout: 8000 }
);

// ── FIX: aguarda o Instagram preencher o @username na textarea ──────────
// O Instagram injeta a menção de forma assíncrona após o clique em Responder.
// Se digitarmos antes, sobrescrevemos ou perdemos o @username,
// fazendo o reply virar um comentário solto em vez de reply encadeado.

await page.waitForFunction(
  () => {
    const ta = document.querySelector('textarea[placeholder="Adicione um comentário..."]');
    if (!ta) return false;
    const val = ta.value.trim();
    // Aguarda até ter algum conteúdo (o @username inserido pelo Instagram)
    return val.length > 0;
  },
  { timeout: 6000 }
).catch(() => {
  // Se não preencheu em 6s, loga mas continua — melhor tentar do que abortar
  console.warn('[reply] Timeout aguardando @mention na textarea. Continuando mesmo assim.');
});

// Garante foco e posiciona cursor no fim do conteúdo já existente
await textarea.click();
await page.keyboard.press('End');

// Lê o que o Instagram já colocou na textarea (ex: "@username ")
const existingText = await page.evaluate(() => {
  const ta = document.querySelector('textarea[placeholder="Adicione um comentário..."]');
  return ta ? ta.value : '';
});

console.log(`[reply] Conteúdo já na textarea: "${existingText.trim()}"`);

// Se já tem o @mention, só adiciona o texto depois
// Se não tem nada (fallback), digita normalmente
const prefix = existingText.endsWith(' ') ? '' : ' ';
await textarea.type(prefix + replyText, { delay: 40 });
await sleep(500);

console.log('[reply] Clicando em "Postar"...');


        const posted = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('[role="button"]')]
            .find(b => b.innerText.trim() === 'Postar');
          if (!btn) return false;
          btn.click();
          return true;
        });

        if (!posted) throw new Error('Botão "Postar" não encontrado.');

        await sleep(2000);

        markAsReplied(db, commentKey, replyText, commentsPath);

        console.log(`[reply] ✅ Resposta postada com sucesso para @${username}!`);
        return;
      } catch (err) {
        console.error(`[reply] ❌ Falha na tentativa ${attempt}: ${err.message}`);
        lastError = err;
      }
    }
  } finally {
    console.log('[reply] Fechando sessão dedicada [reply].');
    await browser.close();
  }

  throw new Error(`Falha após ${maxRetries} tentativas. Último erro: ${lastError?.message}`);
}

async function fetchComments({
  page = null,
  browser = null,
  scrolls = 5,
  sessionPath = null,
  userDataDir = null,
  commentsPath = DEFAULT_DB_PATH,
} = {}) {
  let ownBrowser = false;

  if (!page) {
    const session = await getSessionPage('monitor', { sessionPath, userDataDir });
    if (!session) return;

    browser = session.browser;
    page = session.page;
    ownBrowser = true;
  }

  try {
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await openCommentsTab(page);
    await scrollPanel(page, scrolls);

    const scraped = await scrapeVisibleComments(page);

    const db = loadDB(commentsPath);
    let newCount = 0;

    for (const c of scraped) {
      if (registerComment(db, c)) newCount++;
    }

    saveDB(db, commentsPath);

    const pending = getPendingComments(db);

    console.log(`\n📊 Resultado:`);
    console.log(`   Novos    : ${newCount}`);
    console.log(`   Pendentes: ${pending.length}`);
    console.log(`   Total    : ${Object.keys(db).filter(k => !k.startsWith('__')).length}`);
    console.log(`   DB       : ${commentsPath}`);

    return { scraped, pending, db, newCount };
  } finally {
    if (ownBrowser && browser) {
      await browser.close();
    }
  }
}

async function watchComments({
  intervalMs = 60_000,
  scrolls = 5,
  autoReply = false,
  replyFn = null,
  replyDelayMs = 8_000,
  sessionPath = null,
  userDataDir = null,
  commentsPath = DEFAULT_DB_PATH,
  replySessionPath = null,
  replyUserDataDir = null,
} = {}) {
  const emitter = new EventEmitter();

  let running      = true;
  let timer        = null;
  let tickPromise  = null;   // mutex: nunca dois ticks em paralelo

  async function tick() {
    if (!running) return;

    // ── Mutex: aguarda tick anterior terminar antes de iniciar novo ──────────
    if (tickPromise) {
      console.log('[watch] Tick aguardando varredura anterior terminar...');
      await tickPromise.catch(() => {});
      if (!running) return;
    }

    tickPromise = _doTick();
    try   { await tickPromise; }
    catch (_) { /* erros já emitidos dentro de _doTick */ }
    finally { tickPromise = null; }
  }

  async function _doTick() {
    let browser = null;

    console.log('\n[tick] ── Iniciando varredura temporária ──────────────────────');

    try {
      const session = await getSessionPage('monitor', { sessionPath, userDataDir });
      if (!session) throw new Error(`Não foi possível abrir sessão monitor. Caminho: ${sessionPath}`);

      browser = session.browser;
      const page = session.page;

      try {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (err) {
        console.warn('[watch] Falha/timeout ao abrir Instagram, tentando continuar:', err.message);
        try { await page.evaluate(() => window.stop()); } catch (_) {}
      }

      await sleep(3000);
      await openCommentsTab(page);
      await scrollPanel(page, scrolls);

      const scraped = await scrapeVisibleComments(page);
      const db      = loadDB(commentsPath);
      const newOnes = [];

      for (const c of scraped) {
        if (registerComment(db, c)) newOnes.push(c);
      }
      saveDB(db, commentsPath);

      const pending = getPendingComments(db);
      const total   = Object.keys(db).filter(k => !k.startsWith('__')).length;

      emitter.emit('tick', {
        newCount    : newOnes.length,
        pendingCount: pending.length,
        totalCount  : total,
        at          : new Date().toISOString(),
      });

      if (newOnes.length > 0) emitter.emit('new', newOnes);

      console.log(`[watch] Coletados: ${scraped.length} | Novos: ${newOnes.length} | Pendentes: ${pending.length}`);

      if (autoReply && replyFn) {
        const freshPending = getPendingComments(loadDB(commentsPath));
        for (const comment of freshPending) {
          if (!running) break;
          try {
            const replyText = await replyFn(comment);
            if (!replyText) continue;
            await replyToComment(comment.key, replyText, {
              commentsPath,
              sessionPath : replySessionPath,
              userDataDir : replyUserDataDir,
            });
            await sleep(replyDelayMs);
          } catch (err) {
            emitter.emit('error', err);
          }
        }
      }

      console.log('[tick] ── Varredura concluída ───────────────────────\n');
      return { newCount: newOnes.length, pendingCount: pending.length };

    } catch (err) {
      console.error(`❌ Erro na varredura: ${err.message}`);
      emitter.emit('error', err);
      throw err;
    } finally {
      if (browser) {
        try { await browser.close(); console.log('[watch] Navegador monitor fechado.'); }
        catch (_) {}
      }
    }
  }

  console.log(`👁️ Monitoramento iniciado. Intervalo: ${intervalMs / 1000}s`);

  tick(); // primeira execução imediata
  timer = setInterval(() => tick(), intervalMs);

  return {
    on : emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    // Dispara uma varredura imediata e aguarda — usado por /api/scan
    // quando o bot já está rodando, evitando abrir segundo browser no mesmo userDataDir
    scanNow: () => tick(),

    stop: async () => {
      running = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (tickPromise) await tickPromise.catch(() => {});
      console.log('🔴 Monitoramento encerrado.');
    },
  };
}


async function replyAllPending(replyFn, delayMs = 8000) {
  const db = loadDB(commentsPath);
  const pending = getPendingComments(db);

  if (pending.length === 0) { console.log('✅ Nenhum comentário pendente.'); return; }

  console.log(`📋 ${pending.length} comentário(s) pendente(s).\n`);
  for (const comment of pending) {
    const replyText = await replyFn(comment);
    if (!replyText) continue;
    await replyToComment(comment.key, replyText); // usa sessão 'reply' internamente
    await sleep(delayMs);
  }
}

module.exports = {
  fetchComments,
  replyToComment,
  replyAllPending,
  loadDB, saveDB,
  registerComment,
  markAsReplied,
  getPendingComments,
  watchComments,
};