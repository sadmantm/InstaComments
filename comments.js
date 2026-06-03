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

function markAsReplied(db, key, replyText, commentsPath = DEFAULT_DB_PATH, meta = {}) {
  if (!db[key]) return;
  db[key].replied   = true;
  db[key].repliedAt = new Date().toISOString();
  db[key].replyText = replyText;
  // metadados opcionais (replySource, templateId, templateName, etc.)
  Object.assign(db[key], meta);
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
    .map(([key, v]) => ({ key, id: key, ...v }));  // id = alias de key
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
      await sleep(2000);

      // ── 2. Aguardar painel abrir ─────────────────────────────────────────
      await page.waitForFunction(
        () => {
          const btns = [...document.querySelectorAll('[role="button"]')];
          return btns.some(b => /^(comentários|comments|tudo|all)$/i.test(b.innerText?.trim()));
        },
        { timeout: 10000 }
      );

      // ── 3. Clicar na aba Comentários / Comments ──────────────────────────
      const tabClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[role="button"]')];
        const btn = btns.find(b => /^(comentários|comments)$/i.test(b.innerText?.trim()));
        if (btn) { btn.click(); return btn.innerText.trim(); }
        return null;
      });

      if (!tabClicked) throw new Error('Aba Comments não encontrada.');
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

async function expandTruncatedComments(page) {
  const expanded = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const containers = document.querySelectorAll('[data-pressable-container="true"]');
    let count = 0;

    for (const container of containers) {
      // O botão "more" fica DENTRO do span principal, com role="button"
      // e o texto " more" ou " mais"
      const buttons = container.querySelectorAll('div[role="button"]');
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (txt === 'more' || txt === 'mais') {
          btn.click();
          count++;
          await sleep(50); // pequeno respiro entre cliques
          break; // só um "more" por container
        }
      }
    }
    return count;
  });

  if (expanded > 0) {
    // Espera o DOM reagir aos cliques
    await new Promise((r) => setTimeout(r, 400));
  }
  return expanded;
}

async function scrapeVisibleComments(page) {
  await expandTruncatedComments(page);

  const results = await page.evaluate(() => {
    // ---------- helpers (iguais ao original) ----------
    function fakeId(username, postShortcode, text) {
      const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
      const raw  = `${username}::${postShortcode}::${normalized}`;
      const hash = raw.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
      return 'fake_' + Math.abs(hash).toString(36);
    }

    function parseTimeLabel(raw) {
      if (!raw) return { raw: '', iso: null };
      const txt = raw.trim();
      const relMatch = txt.match(/^(\d+)\s*(s|m|h|d|w|sem\.?)$/i);
      if (relMatch) return { raw: txt, iso: null };
      if (/^(yesterday|ontem)$/i.test(txt)) {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return { raw: txt, iso: d.toISOString().slice(0, 10) };
      }
      const monthsEN = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const monthsPT = { jan:0,fev:1,mar:2,abr:3,mai:4,jun:5,jul:6,ago:7,set:8,out:9,nov:10,dez:11 };
      const enMatch = txt.match(/^([A-Za-z]{3,})\s+(\d{1,2})$/);
      if (enMatch) {
        const key = enMatch[1].slice(0, 3).toLowerCase();
        const day = parseInt(enMatch[2], 10);
        const m = monthsEN[key] ?? monthsPT[key];
        if (m != null) {
          const year = new Date().getFullYear();
          const d = new Date(Date.UTC(year, m, day));
          if (d > new Date()) d.setUTCFullYear(year - 1);
          return { raw: txt, iso: d.toISOString().slice(0, 10) };
        }
      }
      const ptMatch = txt.match(/^(\d{1,2})\s*de\s*([a-zç]{3,})\.?$/i);
      if (ptMatch) {
        const day = parseInt(ptMatch[1], 10);
        const key = ptMatch[2].slice(0, 3).toLowerCase();
        const m = monthsPT[key];
        if (m != null) {
          const year = new Date().getFullYear();
          const d = new Date(Date.UTC(year, m, day));
          if (d > new Date()) d.setUTCFullYear(year - 1);
          return { raw: txt, iso: d.toISOString().slice(0, 10) };
        }
      }
      return { raw: txt, iso: null };
    }

    function extractTextAndDate(container) {
      const mainSpan = container.querySelector('div.x1iyjqo2 > span[dir="auto"]');
      if (!mainSpan) return { text: '', dateLabel: '' };
      let dateLabel = '';
      const directSpans = Array.from(mainSpan.children).filter(el => el.tagName === 'SPAN');
      if (directSpans.length > 0)
        dateLabel = (directSpans[directSpans.length - 1].innerText || '').trim();
      const clone = mainSpan.cloneNode(true);
      clone.querySelectorAll('a').forEach(a => { if (!a.getAttribute('aria-label')) a.remove(); });
      clone.querySelectorAll('div[role="button"]').forEach(el => el.remove());
      const cloneSpans = Array.from(clone.children).filter(el => el.tagName === 'SPAN');
      if (cloneSpans.length > 0) cloneSpans[cloneSpans.length - 1].remove();
      let text = clone.innerText || clone.textContent || '';
      text = text.replace(/^\s*(?:commented|comentou)\s*:\s*/i, '');
      text = text.replace(/^@\S+\s*/, '');
      text = text.replace(/\s+/g, ' ').trim();
      return { text, dateLabel };
    }

    // ---------- helpers de classificação ----------

    /**
     * Retorna true se o container é uma notificação de like/follow/mention
     * e NÃO um comentário.
     *
     * Heurísticas:
     *  1. O span principal NÃO contém "commented:" / "comentou:"
     *  2. O texto contém padrões típicos de like/follow ("liked your", "started following",
     *     "curtiu", "começou a seguir", "and X others", "e mais X")
     */
    function isLikeOrFollowNotification(container) {
      const mainSpan = container.querySelector('div.x1iyjqo2 > span[dir="auto"]');
      if (!mainSpan) return true; // sem span principal → desconhecido, descartar

      const raw = (mainSpan.innerText || mainSpan.textContent || '').toLowerCase();

      // DEVE conter "commented" / "comentou" para ser comentário
      const isComment = /commented\s*:|comentou\s*:/.test(raw);
      if (isComment) return false;

      // Padrões de notificação de like/follow/mention para confirmar descarte
      const nonCommentPatterns = [
        /liked your/,
        /curtiu (sua|o seu|a sua)/,
        /started following/,
        /começou a seguir/,
        /mentioned you/,
        /mencionou/,
        /and \d+ others/,
        /e mais \d+/,
        /also liked/,
        /também curtiu/,
      ];
      // se bater qualquer padrão de não-comentário, descarta
      if (nonCommentPatterns.some(p => p.test(raw))) return true;

      // Se não tem "commented" E não bate nenhum padrão conhecido → descarta por segurança
      return true;
    }

    // ---------- main loop ----------
    const out = [];
    const containers = document.querySelectorAll('[data-pressable-container="true"]');

    for (const container of containers) {
      try {
        // ── FILTRO PRINCIPAL: ignora likes, follows, etc. ──────────────────
        if (isLikeOrFollowNotification(container)) continue;

        const usernameEl = container.querySelector('span._ap3a._aaco._aacw._aacx._aad7._aade');
        if (!usernameEl) continue;
        const username = (usernameEl.innerText || '').trim();
        if (!username) continue;

        const mediaLink =
          container.querySelector('a[aria-label="Media thumbnail"]') ||
          container.querySelector('a[aria-label="Miniatura de mídia"]');
        if (!mediaLink) continue;

        const postHref = mediaLink.getAttribute('href') || '';
        const postMatch = postHref.match(/\/(?:p|reel)\/([^/]+)\//);
        if (!postMatch) continue;

        const postShortcode = postMatch[1];
        const postUrl = `https://www.instagram.com${postHref}`;
        const thumbnailUrl = mediaLink.querySelector('img')?.src || '';

        let commentId = '';
        let commentDatetime = '';
        const commentLink = container.querySelector('a[href*="/c/"]');
        if (commentLink) {
          const href = commentLink.getAttribute('href') || '';
          const cMatch = href.match(/\/c\/([^/]+)\//);
          if (cMatch) commentId = cMatch[1];
          const timeEl = commentLink.querySelector('time[datetime]');
          if (timeEl) commentDatetime = timeEl.getAttribute('datetime') || '';
        }

        const { text, dateLabel } = extractTextAndDate(container);

        // Segurança extra: se o texto extraído ainda parecer notificação, pula
        if (/liked your|curtiu|started following|começou a seguir/i.test(text)) continue;

        const parsed = parseTimeLabel(dateLabel);
        if (!commentId) commentId = fakeId(username, postShortcode, text);

        let profilePic = '';
        const avatarLink = container.querySelector(`a[href="/${username}/"] img`);
        if (avatarLink) {
          profilePic = avatarLink.getAttribute('src') || '';
        } else {
          const profileImg = Array.from(container.querySelectorAll('img')).find(img => {
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            return (
              alt.includes(`${username.toLowerCase()}'s profile picture`) ||
              alt.includes(`foto do perfil de ${username.toLowerCase()}`)
            );
          });
          profilePic = profileImg?.src || '';
        }

        out.push({
          username, text, postShortcode, postUrl, thumbnailUrl, postTitle: '',
          commentId,
          datetime: commentDatetime || parsed.iso || '',
          timeLabel: parsed.raw,
          timeIsRelative: !commentDatetime && !parsed.iso && !!parsed.raw,
          profilePic,
        });
      } catch (e) {
        console.warn('[scrape] Erro ao processar container:', e.message);
      }
    }

    return out;
  });

  console.log(`[scrape] ${results.length} comentário(s) extraído(s).`);
  return results;
}

// Helper JS injetado na página do post
const helperSrc = `
  function normText(v) { return (v||'').replace(/\\s+/g,' ').trim().toLowerCase(); }

  // Lê o texto visível de um elemento, incluindo spans filhos
  function innerText(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  function getCommentText(container, username) {
    const els = [...container.querySelectorAll('span[dir="auto"]')];
    for (const el of els) {
      if (el.querySelector('time')) continue;
      const t = innerText(el);
      if (!t || t === username || /^reply$/i.test(t)) continue;
      if (/^\\d+\\s+like/.test(t.toLowerCase())) continue;
      return t;
    }
    return '';
  }

  // Acha o elemento [role="button"] cujo texto visível (incluindo filhos) bate com "Reply"
  function findReplyButton(container) {
    const btns = [...container.querySelectorAll('[role="button"]')];
    return btns.find(b => /^reply$/i.test(innerText(b))) || null;
  }

  function findLikeButton(container) {
    return [...container.querySelectorAll('[role="button"]')]
      .find(b => !!b.querySelector('svg[aria-label="Like"]')) || null;
  }

  function hasReplyButton(c) { return !!findReplyButton(c); }

  function scoreContainer(container, target) {
    let score = 0;
    const link = container.querySelector('a[href*="/c/"]');
    const href = link ? (link.getAttribute('href') || '') : '';
    if (target.commentId && href.includes('/c/' + target.commentId + '/')) score += 1000;
    const timeEl = container.querySelector('time[datetime]');
    const dt = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
    if (target.datetime && dt === target.datetime) score += 500;
    const text   = normText(getCommentText(container, target.username));
    const wanted = normText(target.text);
    if (wanted && text === wanted) score += 300;
    else if (wanted && text.includes(wanted)) score += 150;
    else if (wanted) {
      for (let len = Math.min(wanted.length, text.length); len >= 6; len--) {
        if (text.includes(wanted.slice(0, len))) { score += len; break; }
      }
    }
    return score;
  }

  function collectCandidates(targetUsername) {
    const seen = new Set(); const out = [];
    for (const el of document.querySelectorAll('span._ap3a._aaco._aacw._aacx._aad7._aade')) {
      if (normText(innerText(el)) !== normText(targetUsername)) continue;
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
    const byId = target.commentId
      ? document.querySelector('a[href*="/c/' + target.commentId + '/"]')
      : null;
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
    const replyBtn = findReplyButton(container);
    if (!replyBtn) return false;
    if (doLike) {
      const likeBtn = findLikeButton(container);
      if (likeBtn) likeBtn.click();
    }
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

  const session = await getSessionPage('reply', {
    sessionPath,
    userDataDir,
  });

  if (!session) throw new Error('Sem sessão reply. Conecte o Instagram novamente.');

  const cleanReply = sanitizeReply(replyText);
if (!cleanReply) {
  throw new Error('Resposta rejeitada pelo sanitizador (provável vazamento de raciocínio do LLM).');
}

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
        await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2000);

        const currentUrl = page.url();

        if (!currentUrl.includes(`/${postShortcode}`) && !currentUrl.includes(postShortcode)) {
          throw new Error(`Navegação foi para URL errada: esperado ${postShortcode}, obtido ${currentUrl}`);
        }

        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('/accounts/login')) {
          throw new Error('Redirecionado para login — sessão reply expirada.');
        }

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

        if (!clickResult.clicked) {
          throw new Error(`Botão "Responder" não encontrado para @${username}: ${clickResult.reason}`);
        }

        await sleep(1500);

        const textarea = await page.waitForSelector(
          'textarea[placeholder="Add a comment\u2026"]',   // … = \u2026
          { visible: true, timeout: 8000 }
        );
        
        await page.waitForFunction(
          () => {
            const ta = document.querySelector('textarea[placeholder="Add a comment\u2026"]');
            return ta && ta.value.trim().length > 0;
          },
          { timeout: 6000 }
        ).catch(() => {
          console.warn('[reply] Timeout aguardando @mention na textarea. Continuando mesmo assim.');
        });
        
        await textarea.click();
        await page.keyboard.press('End');
        
        const existingText = await page.evaluate(() => {
          const ta = document.querySelector('textarea[placeholder="Add a comment\u2026"]');
          return ta ? ta.value : '';
        });
        
        const prefix = existingText.endsWith(' ') ? '' : ' ';
        await textarea.type(prefix + cleanReply, { delay: 40 });
        await sleep(500);
        
        const posted = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('[role="button"]')]
            .find(b => /^post$/i.test((b.innerText || b.textContent || '').trim()));
          if (!btn) return false;
          btn.click();
          return true;
        });
        
        if (!posted) throw new Error('Botão "Post" não encontrado.');
        

        await sleep(2000);

        markAsReplied(db, commentKey, cleanReply, commentsPath);

        console.log(`[reply] ✅ Resposta postada com sucesso para @${username}!`);
        return;
      } catch (err) {
        console.error(`[reply] ❌ Falha na tentativa ${attempt}: ${err.message}`);
        lastError = err;
              const ss = path.resolve(`./error_${profile}_${Date.now()}.png`);
              await page.screenshot({ path: ss, fullPage: true });
      }
    }
  } finally {
    console.log('[reply] Fechando sessão dedicada [reply].');
    const proc = browser.process();
    await browser.close();
    // Espera o processo do Chromium realmente terminar antes de liberar o profile
    if (proc) {
      await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', resolve);
        setTimeout(resolve, 5000); // fallback
      });
    }
  }

  throw new Error(`Falha após ${maxRetries} tentativas. Último erro: ${lastError?.message}`);
}

// Rede de segurança: nunca postar JSON cru ou vazamento de estrutura
function sanitizeReply(raw) {
  if (!raw) return null;
  let t = String(raw).trim();

  // Se veio JSON cru (truncado ou não), tenta extrair "resposta"
  if (t.startsWith('{') || t.includes('"resposta"')) {
    const m = t.match(/"resposta"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m && m[1]) {
      t = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').trim();
    } else {
      return null; // não recuperável → não posta
    }
  }

  // Marcadores que nunca devem ir pro Instagram
  if (/(INTENCAO_|VIDEO_|TIPO_DO_VIDEO|Rascunhos?:|"resposta"\s*:)/i.test(t)) {
    return null;
  }

  t = t.replace(/^["'*\s]+|["'*\s]+$/g, '').trim();
  if (!t || t.length > 300) return null;

  return t;
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