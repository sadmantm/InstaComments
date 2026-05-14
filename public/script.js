/* ── Constantes ─────────────────────────────────────────── */
const API = '';          // mesmo origin
const POLL_MS = 18000;   // polling de novos comentários

/* ── Estado global ──────────────────────────────────────── */
const state = {
  activeSection: 'dashboard',
  selectedComment: null,
  filterStatus: 'all',
  filterPost: '',
  filterType: '',
  filterPeriod: 'all',
  searchQuery: '',
  automationEnabled: false,
  replyDraft: '',
  comments: [],         // cache local
  totalPages: 1,
  currentPage: 1,
  botRunning: false,
  autoReply: false,
  stats: {},
  hourlyReplies: [],
  logs: [],
};

/* ── Helpers ────────────────────────────────────────────── */
function minutesToLabel(m) {
  if (m < 60) return `${m}min`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function timeSince(isoStr) {
  if (!isoStr) return '—';
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 60000);
  return minutesToLabel(diff);
}

function statusLabel(s) {
  return { new: 'Novo', pending: 'Pendente', 'replied-manual': 'Manual', 'replied-ai': 'IA' }[s] ?? s;
}

function statusClass(s) {
  return { new: 'new', pending: 'pending', 'replied-manual': 'manual', 'replied-ai': 'ai' }[s] ?? '';
}

// Redireciona imagens do CDN do Instagram pelo proxy local para evitar CORP
function proxyImg(url) {
  if (!url) return '';
  if (url.includes('fbcdn.net') || url.includes('cdninstagram.com') || url.includes('instagram.f')) {
    return `/api/proxy/image?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function avatarSrc(url, id) {
  const proxied = proxyImg(url);
  return proxied || `https://i.pravatar.cc/80?u=${id}`;
}

function sentimentOf(text) {
  const t = (text || '').toLowerCase();
  const pos = ['amei', 'adorei', 'incrível', 'perfeito', 'lindo', 'satisfeita', 'obrigad', 'parabéns', 'qualidade', '❤', '🔥', '✅', '👏'];
  const neg = ['decepcionante', 'errado', 'problema', 'ruim', 'demorou', 'caiu', '😤'];
  if (pos.some(w => t.includes(w))) return 'positive';
  if (neg.some(w => t.includes(w))) return 'negative';
  return 'neutral';
}

function sentimentLabel(s) {
  return { positive: 'Positivo', neutral: 'Neutro', negative: 'Negativo' }[s] ?? s;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ── Navegação ──────────────────────────────────────────── */
function initNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      switchSection(el.dataset.section);
    });
  });
}

function switchSection(sec) {
  state.activeSection = sec;
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.section === sec));
  document.querySelectorAll('.section').forEach(el =>
    el.classList.toggle('hidden', !el.id.endsWith(sec)));
  if (sec === 'comments') loadComments();
  if (sec === 'dashboard') loadDashboard();
}

/* ── Dashboard ──────────────────────────────────────────── */
// Snapshot anterior para calcular deltas de tendência
let _prevStats = null;

async function loadDashboard() {
  try {
    const data = await apiFetch('/api/state');

    // Calcula deltas antes de sobrescrever o snapshot
    const prev = _prevStats;
    _prevStats = { ...data.stats };

    state.stats = data.stats;
    state.botRunning = data.botRunning;
    state.autoReply = data.autoReply;
    state.hourlyReplies = data.hourlyReplies || new Array(24).fill(0);
    state.logs = data.logs || [];

    renderDashboardMetrics(data.stats, data.recent || [], prev);
    renderActivityChart(state.hourlyReplies);
  } catch (e) {
    showToast('error', 'Erro ao carregar dashboard: ' + e.message);
  }
}

function renderDashboardMetrics(stats, recent, prev) {
  const total   = stats.total   ?? 0;
  const pending = stats.pending ?? 0;
  const replied = stats.replied ?? 0;

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setVal('m-total',   total);
  setVal('m-new',     pending);
  setVal('m-pending', pending);
  setVal('m-manual',  replied);
  setVal('m-ai',      replied);

  // ── Tendências ─────────────────────────────────────────────────────────
  // Compara com snapshot anterior; na primeira carga prev é null → sem delta
  function applyTrend(selector, current, previous) {
    const el = document.querySelector(selector);
    if (!el) return;
    if (previous == null) { el.style.visibility = 'hidden'; return; }
    const delta = current - previous;
    const pct   = previous > 0 ? Math.round((delta / previous) * 100) : 0;
    const up    = delta >= 0;
    el.className = `metric-trend ${up ? 'up' : 'down'}`;
    el.innerHTML = `<i class="fa-solid fa-arrow-trend-${up ? 'up' : 'down'}"></i> ${up ? '+' : ''}${pct}%`;
    el.style.visibility = '';
  }

  applyTrend('.metric-card:nth-child(1) .metric-trend', total,   prev?.total);
  applyTrend('.metric-card:nth-child(2) .metric-trend', pending, prev?.pending);
  applyTrend('.metric-card:nth-child(3) .metric-trend', pending, prev?.pending);
  applyTrend('.metric-card:nth-child(4) .metric-trend', replied, prev?.replied);
  applyTrend('.metric-card:nth-child(5) .metric-trend', replied, prev?.replied);

  const postList = document.getElementById('posts-list');
  if (!postList) return;

  if (!recent.length) {
    postList.innerHTML = '<div class="loading-state"><span>Nenhum comentário recente</span></div>';
    return;
  }

  // agrupa por postShortcode preservando thumbnail e título
  const posts = {};
  recent.forEach(c => {
    const key = c.postShortcode || c.postUrl || 'desconhecido';
    if (!posts[key]) {
      posts[key] = { count: 0, thumb: c.thumbnailUrl || '', title: c.postTitle || key };
    }
    posts[key].count++;
  });

  postList.innerHTML = Object.entries(posts)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([shortcode, { count, thumb, title }]) => {
      const thumbHtml = thumb
        ? `<img src="${avatarSrc(thumb, 'thumb-' + shortcode)}"
                style="width:100%;height:100%;object-fit:cover;border-radius:6px"
                onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fa-solid fa-image'}))">`
        : '<i class="fa-solid fa-image"></i>';
      return `
        <div class="post-row">
          <div class="post-thumb">${thumbHtml}</div>
          <div class="post-info">
            <div class="post-name" title="${shortcode}">${title.slice(0, 40)}${title.length > 40 ? '…' : ''}</div>
            <div class="post-meta">${count} comentário${count !== 1 ? 's' : ''}</div>
          </div>
          <div class="post-count">${count}</div>
        </div>`;
    })
    .join('');
}

function renderActivityChart(hourly) {
  const el = document.getElementById('activity-chart');
  if (!el) return;

  // Se todos os valores forem zero, tenta construir distribuição
  // a partir dos comentários em cache usando a hora de seenAt
  let data = hourly;
  const allZero = data.every(v => v === 0);
  if (allZero && state.comments.length) {
    data = new Array(24).fill(0);
    state.comments.forEach(c => {
      if (c.timestamp) {
        const h = new Date(c.timestamp).getHours();
        data[h]++;
      }
    });
  }

  const max = Math.max(...data, 1);
  el.innerHTML = data.map((v, h) => `
    <div class="bar-wrap">
      <div class="bar" style="height:${Math.max(4, (v / max) * 100)}%" title="${v} comentário${v !== 1 ? 's' : ''}"></div>
      <span class="bar-lbl">${String(h).padStart(2, '0')}h</span>
    </div>`).join('');
}

/* ── Comentários ────────────────────────────────────────── */
async function loadComments(page = 1) {
  const params = new URLSearchParams({ page, limit: 20 });

  if (state.filterStatus !== 'all') {
    if (state.filterStatus === 'replied') params.set('filter', 'replied');
    else if (state.filterStatus === 'pending') params.set('filter', 'pending');
  }
  if (state.searchQuery) params.set('q', state.searchQuery);

  try {
    const data = await apiFetch(`/api/comments?${params}`);
    state.comments = data.items || [];
    state.totalPages = data.pages || 1;
    state.currentPage = data.page || 1;
    renderComments();
    updateBadge(state.stats.pending ?? 0);
  } catch (e) {
    showToast('error', 'Erro ao carregar comentários: ' + e.message);
  }
}

function getFilteredComments() {
  let list = state.comments;

  if (state.filterType) {
    // backend não retorna "type", filtro local opcional
    list = list.filter(c => (c.type ?? 'comment') === state.filterType);
  }

  return list;
}

function renderComments() {
  const listEl = document.getElementById('comments-list');
  document.getElementById('comments-loading')?.remove();

  const list = state.comments;           // todos, sem filtro local extra
  if (!list.length) {
    listEl.innerHTML = `<div class="loading-state"><i class="fa-regular fa-face-meh" style="font-size:28px;opacity:.3"></i><span>Nenhum comentário encontrado</span></div>`;
    return;
  }

  listEl.innerHTML = list.map(c => {
    const status = c.replied ? 'replied-manual' : 'pending';
    const age = timeSince(c.timestamp);
    return `
      <div class="comment-item ${c.id === state.selectedComment ? 'selected' : ''} ${!c.replied ? 'is-new' : ''}" data-id="${c.id}" data-shortcode="${c.postShortcode || ''}" data-user="${c.user}">
        <img class="avatar" src="${avatarSrc(c.profilePic, c.id)}" alt="${c.user}" loading="lazy" onerror="this.src='https://i.pravatar.cc/80?u=${c.id}'" />
        <div class="comment-item-body">
          <div class="comment-item-top">
            <span class="comment-username">@${c.user}</span>
            <span class="comment-time">${age}</span>
          </div>
          <div class="comment-text">${c.text}</div>
          <div class="comment-meta">
            <span class="status-tag ${statusClass(status)}">${statusLabel(status)}</span>
            </span>
          </div>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.comment-item').forEach(el => {
    el.addEventListener('click', () => selectComment(el.dataset.id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      openContextMenu(e, el.dataset.id, el.dataset.shortcode, el.dataset.user);
    });
  });
}

(function injectContextMenu() {
  const el = document.createElement('div');
  el.id = 'ctx-menu';
  el.className = 'ctx-menu hidden';
  el.innerHTML = `
    <button data-action="select">  <i class="fa-solid fa-expand"></i>         Ver detalhes</button>
    <button data-action="copy">    <i class="fa-solid fa-copy"></i>            Copiar texto</button>
    <button data-action="copyuser"><i class="fa-solid fa-at"></i>              Copiar usuário</button>
    <div class="ctx-divider"></div>
    <button data-action="pending"> <i class="fa-solid fa-clock"></i>           Marcar pendente</button>
    <button data-action="replied"> <i class="fa-solid fa-check"></i>           Marcar respondido</button>
    <div class="ctx-divider"></div>
    <button data-action="instagram" class="ctx-instagram">
                                   <i class="fa-brands fa-instagram"></i>      Abrir no Instagram</button>
  `;
  document.body.appendChild(el);
})();

function openContextMenu(e, commentId, shortcode, user) {
  const menu = document.getElementById('ctx-menu');
  menu._commentId  = commentId;
  menu._shortcode  = shortcode;
  menu._user       = user;

  // Posicionamento — evita sair da tela
  menu.classList.remove('hidden');
  const { innerWidth: vw, innerHeight: vh } = window;
  const mw = 200, mh = menu.offsetHeight || 220;
  const x = Math.min(e.clientX, vw - mw - 8);
  const y = Math.min(e.clientY, vh - mh - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeContextMenu() {
  document.getElementById('ctx-menu')?.classList.add('hidden');
}

// Delegação de cliques do menu
document.addEventListener('click', e => {
  const menu = document.getElementById('ctx-menu');
  const btn  = e.target.closest('#ctx-menu [data-action]');

  if (!btn) { closeContextMenu(); return; }

  const { _commentId, _shortcode, _user } = menu;
  const comment = state.comments.find(c => String(c.id) === String(_commentId));

  switch (btn.dataset.action) {
    case 'select':
      selectComment(_commentId);
      break;

    case 'copy':
      navigator.clipboard.writeText(comment?.text || '');
      showToast('success', 'Texto do comentário copiado.');
      break;

    case 'copyuser':
      navigator.clipboard.writeText('@' + _user);
      showToast('success', 'Usuário copiado.');
      break;

    case 'pending':
      showToast('info', 'Função de status disponível via bot.');
      break;

    case 'replied':
      if (comment) {
        comment.replied = true;
        renderComments();
        if (state.selectedComment === _commentId) renderDetail(comment);
        showToast('success', 'Comentário marcado como respondido.');
      }
      break;

    case 'instagram': {
      const url = _shortcode
        ? `https://www.instagram.com/p/${_shortcode}/`
        : `https://www.instagram.com/`;
      window.open(url, '_blank', 'noopener,noreferrer');
      break;
    }
  }

  closeContextMenu();
});

// Fecha ao pressionar Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeContextMenu();
});


function selectComment(id) {
  state.selectedComment = id;
  state.replyDraft = '';
  renderComments();
  const comment = state.comments.find(c => String(c.id) === String(id));
  if (comment) renderDetail(comment);
}

function renderDetail(c) {
  document.getElementById('detail-empty').classList.add('hidden');
  const content = document.getElementById('detail-content');
  content.classList.remove('hidden');

  const status = c.replied ? 'replied-manual' : 'pending';
  const sentiment = sentimentOf(c.text);
  const age = timeSince(c.timestamp);

  const repliesHtml = c.reply ? `
    <div class="reply-history">
      <div class="reply-history-title">Histórico de Respostas</div>
      <div class="reply-bubble">
        <div class="reply-bubble-meta">
          <span class="reply-bubble-by"><i class="fa-solid fa-user-pen"></i> Resposta Manual</span>
          <span class="reply-bubble-time">${timeSince(c.repliedAt)}</span>
        </div>
        <div class="reply-bubble-text">${c.reply}</div>
      </div>
    </div>` : '';

  content.innerHTML = `
    <div class="detail-header">
      <img class="detail-avatar" src="${avatarSrc(c.profilePic, c.id)}" alt="${c.user}" onerror="this.src='https://i.pravatar.cc/80?u=${c.id}'" />
      <div class="detail-user-info">
        <div class="detail-username">@${c.user}</div>
        <div class="detail-handle">${c.postShortcode || 'post'} · ${age}</div>
      </div>
      <div class="detail-actions">
        <span class="status-tag ${statusClass(status)}">${statusLabel(status)}</span>
        <button class="icon-btn" data-action="pending" title="Marcar pendente"><i class="fa-solid fa-clock"></i></button>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-comment-card">
        <div class="detail-comment-meta">
          <span class="detail-post-ref"><i class="fa-solid fa-image"></i> ${c.postShortcode || 'post'}</span>
          <span class="status-tag ${statusClass(status)}">${statusLabel(status)}</span>
        </div>
        <div class="detail-comment-text">${c.text}</div>
        <div class="sentiment-row">
          <span class="sentiment-label">Sentimento:</span>
          <span class="sentiment-badge ${sentiment}">${sentimentLabel(sentiment)}</span>
        </div>
      </div>
      ${repliesHtml}
    </div>
    <div class="detail-reply-area">
      <div class="reply-input-wrap">
        <textarea class="reply-textarea" id="reply-textarea" placeholder="Escreva uma resposta para @${c.user}…" maxlength="300">${state.replyDraft}</textarea>
        <div class="reply-input-footer">
          <span class="char-count" id="char-count">${state.replyDraft.length}/300</span>
          <div class="reply-btn-row">
            <button class="btn-ai" id="btn-ai-reply"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar com IA</button>
            <button class="btn-primary" id="btn-send-reply"><i class="fa-solid fa-paper-plane"></i> Responder</button>
          </div>
        </div>
      </div>
    </div>`;

  const ta = content.querySelector('#reply-textarea');
  ta.addEventListener('input', () => {
    state.replyDraft = ta.value;
    content.querySelector('#char-count').textContent = `${ta.value.length}/300`;
  });

  content.querySelector('[data-action="pending"]')?.addEventListener('click', () =>
    showToast('info', 'Função de status disponível via bot.'));
  content.querySelector('#btn-send-reply').addEventListener('click', () => sendReply(c.id, false));
  content.querySelector('#btn-ai-reply').addEventListener('click', () => generateAiReply(c));
}

async function sendReply(id, isAi) {
  const ta = document.getElementById('reply-textarea');
  const text = ta?.value.trim();
  if (!text) { showToast('error', 'Digite uma resposta antes de enviar.'); return; }

  try {
    await apiFetch(`/api/comments/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply: text }),
    });

    // atualiza cache local
    const c = state.comments.find(c => String(c.id) === String(id));
    if (c) { c.replied = true; c.reply = text; c.repliedAt = new Date().toISOString(); }

    state.replyDraft = '';
    renderComments();
    renderDetail(state.comments.find(c => String(c.id) === String(id)));
    showToast('success', isAi ? 'Resposta da IA enviada.' : 'Resposta enviada com sucesso.');
  } catch (e) {
    showToast('error', 'Erro ao enviar resposta: ' + e.message);
  }
}

async function generateAiReply(comment) {
  const btn = document.getElementById('btn-ai-reply');
  const ta  = document.getElementById('reply-textarea');
  if (!btn || !ta) return;

  btn.disabled = true;
  btn.classList.add('generating');
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Gerando…';

  try {
    const systemPrompt = document.getElementById('setting-system-prompt')?.value || '';

    const res = await fetch(API + '/api/ai-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commentId:    comment.id,
        username:     comment.user,
        text:         comment.text,
        systemPrompt: systemPrompt || undefined,  // omite se vazio; server usa prompt.txt
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Erro desconhecido');
    }

    const data = await res.json();
    const aiText = data.reply;
    if (!aiText) throw new Error('Resposta vazia');

    ta.value = aiText;
    state.replyDraft = aiText;
    document.getElementById('char-count').textContent = `${aiText.length}/300`;
    showToast('info', 'Resposta gerada. Revise antes de enviar.');
  } catch (e) {
    showToast('error', 'Não foi possível gerar resposta via IA: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('generating');
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Gerar com IA';
  }
}

/* ── Filtros ─────────────────────────────────────────────── */
function initFilters() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.filterStatus = chip.dataset.filter;
      loadComments();
    });
  });

  document.getElementById('filter-post')?.addEventListener('change', e => {
    state.filterPost = e.target.value;
    loadComments();
  });

  document.getElementById('filter-type')?.addEventListener('change', e => {
    state.filterType = e.target.value;
    renderComments();   // filtro local, sem round-trip
  });

  document.getElementById('filter-period')?.addEventListener('change', e => {
    state.filterPeriod = e.target.value;
    loadComments();
  });

  document.getElementById('search-input')?.addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    // Garante que a aba comentários esteja aberta ao digitar
    if (state.activeSection !== 'comments') switchSection('comments');
    else loadComments();
  });
}

/* ── Automação ───────────────────────────────────────────── */
async function initAutomation() {
  try {
    const cfg = await apiFetch('/api/config');
    state.automationEnabled = cfg.autoReply;
    syncAutomationUI(cfg.autoReply);
  } catch { /* usa estado padrão */ }

  const master = document.getElementById('master-toggle');
  master?.addEventListener('change', async () => {
    const on = master.checked;
    try {
      await apiFetch('/api/bot/mode', {
        method: 'POST',
        body: JSON.stringify({ autoReply: on }),
      });
      state.automationEnabled = on;
      syncAutomationUI(on);
      showToast(on ? 'success' : 'info', on ? 'Automação global ativada.' : 'Automação global desativada.');
    } catch (e) {
      showToast('error', 'Erro ao alterar modo: ' + e.message);
      master.checked = !on;    // reverte visualmente
    }
  });

  document.getElementById('add-rule-btn')?.addEventListener('click', () => openModal(null));
}

function syncAutomationUI(on) {
  const card  = document.getElementById('auto-status-card');
  const pill  = document.getElementById('auto-pill');
  const master = document.getElementById('master-toggle');
  if (master) master.checked = on;
  if (!card) return;
  card.className = `auto-status-card ${on ? 'active-card' : 'inactive-card'}`;
  card.querySelector('.auto-status-icon i').className = `fa-solid ${on ? 'fa-circle-check' : 'fa-circle-xmark'}`;
  card.querySelector('.auto-status-text strong').textContent = on ? 'Automação Ativa' : 'Automação Inativa';
  card.querySelector('.auto-status-text span').textContent = on
    ? 'Respondendo comentários automaticamente via IA'
    : 'Respostas automáticas desativadas';
  card.querySelector('.auto-status-badge').className = `auto-status-badge ${on ? 'on' : 'off'}`;
  card.querySelector('.auto-status-badge').textContent = on ? 'ON' : 'OFF';
  if (pill) {
    pill.className = `nav-pill ${on ? 'active-pill' : ''}`;
    pill.textContent = on ? 'Ativo' : 'Inativo';
  }
}

/* ── Templates / Respostas prontas (estado local) ─────────── */
// O backend não tem endpoint de templates ainda; mantemos no cliente.
const TEMPLATES_DEFAULT = [
  { id: 1, name: 'Pergunta sobre Preço',       trigger: 'preço, valor, quanto custa, caro, barato',  text: 'Olá! Os preços estão disponíveis no nosso site. Acesse pelo link na bio 🛍️', active: true,  hits: 0, icon: 'fa-tag' },
  { id: 2, name: 'Disponibilidade de Estoque', trigger: 'tem, disponível, estoque, tamanho, grade',  text: 'Oi! Para conferir disponibilidade e tamanhos, acesse nosso site 😊',          active: true,  hits: 0, icon: 'fa-box' },
  { id: 3, name: 'Dúvidas sobre Envio',        trigger: 'frete, entrega, prazo, envio, correios',    text: 'Enviamos para todo o Brasil! Prazo e frete calculados na compra 🚚',          active: true,  hits: 0, icon: 'fa-truck' },
  { id: 4, name: 'Agradecimento por Elogio',   trigger: 'amei, adorei, incrível, perfeito, lindo',   text: 'Que alegria! Obrigada pelo carinho ❤️',                                       active: true,  hits: 0, icon: 'fa-heart' },
  { id: 5, name: 'Reclamação — DM',            trigger: 'errado, decepcionante, problema, ruim',     text: 'Sentimos muito 😔 Manda um Direct com os detalhes do pedido!',               active: false, hits: 0, icon: 'fa-triangle-exclamation' },
  { id: 6, name: 'Formas de Pagamento',        trigger: 'parcelar, cartão, pix, boleto',             text: 'Aceitamos PIX, boleto e cartão em até 12x sem juros 🎉',                     active: true,  hits: 0, icon: 'fa-credit-card' },
];

let templates = [...TEMPLATES_DEFAULT];
const ICONS_POOL = ['fa-bolt', 'fa-tag', 'fa-star', 'fa-message', 'fa-circle-check', 'fa-comment', 'fa-hand-wave'];

function renderTemplates() {
  const list = document.getElementById('rules-list');
  if (!list) return;
  if (!templates.length) {
    list.innerHTML = `<div class="loading-state"><span>Nenhuma resposta pronta cadastrada</span></div>`;
    return;
  }
  list.innerHTML = templates.map(t => `
    <div class="rule-card" data-tpl="${t.id}">
      <div class="rule-icon"><i class="fa-solid ${t.icon}"></i></div>
      <div class="rule-body">
        <div class="rule-name">${t.name}</div>
        <div class="rule-trigger"><i class="fa-solid fa-key"></i> ${t.trigger}</div>
        <div class="rule-preview">${t.text}</div>
      </div>
      <div class="rule-actions">
        <span class="rule-hit">${t.hits} uso${t.hits !== 1 ? 's' : ''}</span>
        <label class="toggle-switch">
          <input type="checkbox" class="tpl-toggle" data-tpl-id="${t.id}" ${t.active ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <button class="icon-btn tpl-edit" data-tpl-id="${t.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn tpl-del"  data-tpl-id="${t.id}" title="Remover"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.tpl-toggle').forEach(tog => {
    tog.addEventListener('change', e => {
      const id = parseInt(e.target.dataset.tplId);
      const tpl = templates.find(t => t.id === id);
      tpl.active = e.target.checked;
      showToast(tpl.active ? 'success' : 'info', `"${tpl.name}" ${tpl.active ? 'ativada' : 'desativada'}.`);
    });
  });

  list.querySelectorAll('.tpl-edit').forEach(btn => {
    btn.addEventListener('click', () => openModal(parseInt(btn.dataset.tplId)));
  });

  list.querySelectorAll('.tpl-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.tplId);
      const tpl = templates.find(t => t.id === id);
      templates = templates.filter(t => t.id !== id);
      renderTemplates();
      showToast('info', `"${tpl.name}" removida.`);
    });
  });
}

/* ── Modal ───────────────────────────────────────────────── */
let editingRuleId = null;

function openModal(editId) {
  editingRuleId = editId;
  const tpl = editId ? templates.find(t => t.id === editId) : null;
  document.getElementById('modal-title').textContent = tpl ? 'Editar Resposta Pronta' : 'Nova Resposta Pronta';
  document.getElementById('rule-name').value     = tpl?.name    ?? '';
  document.getElementById('rule-trigger').value  = tpl?.trigger ?? '';
  document.getElementById('rule-response').value = tpl?.text    ?? '';
  document.getElementById('rule-active').checked = tpl ? tpl.active : true;
  document.getElementById('modal-save').textContent = tpl ? 'Salvar Alterações' : 'Salvar Resposta';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function initModal() {
  const overlay = document.getElementById('modal-overlay');
  const close = () => overlay.classList.add('hidden');
  document.getElementById('modal-close').addEventListener('click', close);
  document.getElementById('modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('modal-save').addEventListener('click', () => {
    const name    = document.getElementById('rule-name').value.trim();
    const trigger = document.getElementById('rule-trigger').value.trim();
    const text    = document.getElementById('rule-response').value.trim();
    const active  = document.getElementById('rule-active').checked;
    if (!name || !trigger || !text) { showToast('error', 'Preencha todos os campos obrigatórios.'); return; }

    if (editingRuleId) {
      const tpl = templates.find(t => t.id === editingRuleId);
      Object.assign(tpl, { name, trigger, text, active });
      showToast('success', `"${name}" atualizada.`);
    } else {
      templates.unshift({
        id: Date.now(), name, trigger, text, active, hits: 0,
        icon: ICONS_POOL[Math.floor(Math.random() * ICONS_POOL.length)],
      });
      showToast('success', `"${name}" criada com sucesso.`);
    }
    renderTemplates();
    close();
  });
}

/* ── Settings ────────────────────────────────────────────── */
function initSettings() {
  // Carrega o prompt salvo e preenche o campo na UI
  apiFetch('/api/config').then(cfg => {
    const el = document.getElementById('setting-system-prompt');
    if (el && cfg.systemPrompt) el.value = cfg.systemPrompt;
  }).catch(() => {});

  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          autoReply:    document.getElementById('master-toggle')?.checked ?? state.automationEnabled,
          systemPrompt: document.getElementById('setting-system-prompt')?.value ?? '',
        }),
      });
      showToast('success', 'Configurações salvas.');
    } catch (e) {
      showToast('error', 'Erro ao salvar: ' + e.message);
    }
  });
}


/* ── Header ──────────────────────────────────────────────── */
function initHeader() {
  document.getElementById('refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    document.querySelector('.sync-label').textContent = 'Sincronizando…';
    try {
      await apiFetch('/api/scan', { method: 'POST' });
      await loadDashboard();
      if (state.activeSection === 'comments') await loadComments();
      document.querySelector('.sync-label').textContent = 'Sincronizado';
      showToast('success', 'Dados atualizados.');
    } catch (e) {
      document.querySelector('.sync-label').textContent = 'Erro';
      showToast('error', 'Falha ao sincronizar: ' + e.message);
    } finally {
      btn.classList.remove('spinning');
    }
  });

  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    sb.style.width = (sb.style.width === '0px') ? 'var(--sidebar-w)' : '0px';
  });
}

/* ── Badge ───────────────────────────────────────────────── */
function updateBadge(n) {
  const badge = document.getElementById('new-badge');
  if (!badge) return;
  badge.textContent = n;
  badge.style.display = n ? '' : 'none';
}

/* ── Toast ───────────────────────────────────────────────── */
function showToast(type, message) {
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<i class="fa-solid ${icons[type] ?? 'fa-circle-info'}"></i><span>${message}</span>`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 350); }, 3000);
}

function startPolling() {
  // Tenta SSE primeiro; cai em polling somente se o browser não suportar
  if (!window.EventSource) {
    _fallbackPolling();
    return;
  }

  var es = new EventSource('/api/events');
  var reconnectTimer = null;

  // ── tick: dashboard atualizado pelo watcher ──────────────────────────────
  es.addEventListener('tick', function(e) {
    var payload = JSON.parse(e.data);        // { stats, hourlyReplies, newCount }

    state.stats        = payload.stats;
    state.hourlyReplies = payload.hourlyReplies;

    updateBadge(payload.stats.pending ?? 0);

    if (state.activeSection === 'dashboard') {
      renderDashboardMetrics(payload.stats, [], null);
      renderActivityChart(payload.hourlyReplies);
    }
  });

  // ── new_comments: chegaram comentários novos ─────────────────────────────
  es.addEventListener('new_comments', function(e) {
    var payload = JSON.parse(e.data);        // { count, previews, stats }

    state.stats = payload.stats;
    updateBadge(payload.stats.pending ?? 0);

    // Toast com preview do primeiro comentário
    var preview = payload.previews[0];
    var msg = payload.count === 1
      ? 'Novo comentário de @' + preview.user + ': "' + preview.text.slice(0, 50) + (preview.text.length > 50 ? '…' : '') + '"'
      : payload.count + ' novos comentários recebidos';
    showToast('info', msg);

    // Recarrega a aba ativa sem precisar de round-trip extra
    if (state.activeSection === 'comments')  loadComments();
    if (state.activeSection === 'dashboard') loadDashboard();
  });

  es.addEventListener('login_saved', function(e) {
    const payload = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('sse:login_saved', { detail: payload }));
  });
  

  // ── onerror: reconecta com back-off ─────────────────────────────────────
  es.onerror = function() {
    es.close();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(startPolling, 5000);   // tenta novamente em 5s
  };
}

function _fallbackPolling() {
  var lastTotal = state.stats.total ?? 0;
  setInterval(async function() {
    try {
      var data = await apiFetch('/api/state');
      var newTotal = data.stats.total ?? 0;
      var diff = newTotal - lastTotal;
      if (diff > 0) {
        showToast('info', diff + ' novo(s) comentário(s) recebido(s)');
        updateBadge(data.stats.pending ?? 0);
        if (state.activeSection === 'comments')  loadComments();
        if (state.activeSection === 'dashboard') {
          renderDashboardMetrics(data.stats, data.recent || [], null);
          renderActivityChart(data.hourlyReplies || new Array(24).fill(0));
        }
        lastTotal = newTotal;
      }
      state.botRunning = data.botRunning;
    } catch(e) { /* silencioso */ }
  }, 10000);
}

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  initNav();
  initFilters();
  initModal();
  initSettings();
  initHeader();
  renderTemplates();

  await loadDashboard();
  await initAutomation();

  startPolling();
  setTimeout(() => document.getElementById('comments-loading')?.remove(), 800);
});