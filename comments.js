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
      await page.screenshot({ path: path.resolve(`./cu_${Date.now()}.png`), fullPage: true });
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
        const text = extractCommentText(container);

        if (!commentId) commentId = fakeId(username, postShortcode, text);

        // Foto de perfil
        const imgEl =
          container.querySelector('img[alt$="\'s profile picture"]') ||
          container.querySelector('img[alt*="profile picture"]') ||
          container.querySelector('img[alt*="foto do perfil"]');
        const profilePic = imgEl?.src || '';

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