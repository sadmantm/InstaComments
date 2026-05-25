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

const auth = {
  get token()    { return localStorage.getItem('co_token'); },
  get user()     { return JSON.parse(localStorage.getItem('co_user') || 'null'); },
  get igLinked() { return localStorage.getItem('co_ig_linked') === '1'; },
  save(token, user) {
    localStorage.setItem('co_token', token);
    localStorage.setItem('co_user', JSON.stringify(user));
  },
  linkIg()  { localStorage.setItem('co_ig_linked', '1'); },
  clear()   { ['co_token','co_user','co_ig_linked'].forEach(k => localStorage.removeItem(k)); },
  isLoggedIn() { return !!this.token; },
};

/* ── Mostrar / ocultar as telas ─────────────────────────── */
function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  const shell = document.querySelector('.app-shell');
  shell.classList.remove('app-hidden');
  shell.style.display = '';
}

function showAuthScreen() {
  document.getElementById('auth-screen').style.display = '';
  const shell = document.querySelector('.app-shell');
  shell.classList.add('app-hidden');
}

/* ── Helpers UI ─────────────────────────────────────────── */
function setAuthError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.toggle('hidden', !msg);
  el.innerHTML = msg ? `<i class="fa-solid fa-circle-exclamation"></i> ${msg}` : '';
}

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Aguarde…'
    : label;
}

/* ── Toggle senha visível ───────────────────────────────── */
function initPasswordToggles() {
  document.querySelectorAll('.toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.closest('.input-password-wrap').querySelector('input');
      const show  = input.type === 'password';
      input.type  = show ? 'text' : 'password';
      btn.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    });
  });
}

/* ── Tabs login / registro ──────────────────────────────── */
function initAuthTabs() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.getElementById('tab-login').classList.toggle('hidden',    target !== 'login');
      document.getElementById('tab-register').classList.toggle('hidden', target !== 'register');
      setAuthError('login-error', '');
      setAuthError('reg-error', '');
    });
  });
}

/* ── LOGIN ──────────────────────────────────────────────── */
async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('btn-login');

  setAuthError('login-error', '');
  if (!email || !password) { setAuthError('login-error', 'Preencha e-mail e senha.'); return; }

  setLoading(btn, true, '<i class="fa-solid fa-right-to-bracket"></i> Entrar');
  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    auth.save(data.token, data.user);
    onLoginSuccess(false);
  } catch (e) {
    setAuthError('login-error', e.message || 'Credenciais inválidas.');
  } finally {
    setLoading(btn, false, '<i class="fa-solid fa-right-to-bracket"></i> Entrar');
  }
}

/* ── REGISTRO ───────────────────────────────────────────── */
async function handleRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;
  const btn      = document.getElementById('btn-register');

  setAuthError('reg-error', '');

  if (!name || !email || !password || !confirm) {
    setAuthError('reg-error', 'Preencha todos os campos.'); return;
  }
  if (password.length < 8) {
    setAuthError('reg-error', 'A senha deve ter pelo menos 8 caracteres.'); return;
  }
  if (password !== confirm) {
    setAuthError('reg-error', 'As senhas não coincidem.'); return;
  }

  setLoading(btn, true, '<i class="fa-solid fa-user-plus"></i> Criar conta');
  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
    auth.save(data.token, data.user);
    onLoginSuccess(true);           // true = primeiro login → pede Instagram
  } catch (e) {
    setAuthError('reg-error', e.message || 'Erro ao criar conta.');
  } finally {
    setLoading(btn, false, '<i class="fa-solid fa-user-plus"></i> Criar conta');
  }
}

/* ── Pós-login ──────────────────────────────────────────── */
async function onLoginSuccess(firstTime) {
  showApp();

  // Busca o status real do Instagram no servidor
  try {
    const { user } = await apiFetch('/api/auth/me');
    renderIgStatus(user);

    if (!user.igLinked) {
      openIgConnectModal(false); // sem Instagram — mostra credenciais
    } else if (firstTime) {
      openIgConnectModal(true);  // já vinculado — vai direto ao sucesso
    }
  } catch (_) {
    // fallback silencioso
    if (firstTime || !auth.igLinked) openIgConnectModal(false);
  }
}


/* ── LOGOUT ─────────────────────────────────────────────── */
function handleLogout() {
  auth.clear();
  showAuthScreen();
}

/* ── Enter para submeter ────────────────────────────────── */
function initAuthEnterKey() {
  document.getElementById('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('reg-confirm')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRegister();
  });
}

/* MODAL: Conectar Instagram */

function openIgConnectModal(alreadyLinked = false) {
  if (alreadyLinked) {
    igShowStep('success');
  } else {
    igShowStep('credentials');
  }
  document.getElementById('ig-connect-overlay').classList.remove('hidden');
}

function renderIgStatus(user) {
  // Atualiza o objeto de auth em memória para reflexo imediato
  if (user) auth.save(auth.token, user);

  const linked   = user?.igLinked ?? auth.user?.igLinked ?? false;
  const username = user?.igUsername ?? auth.user?.igUsername ?? null;

  // ── Dot + label na sidebar footer ──────────────────────────
  const dot   = document.querySelector('.sidebar-footer .status-dot');
  const label = document.querySelector('.sidebar-footer .status-label');

  if (dot) {
    dot.className = `status-dot ${linked ? 'online' : 'offline'}`;
  }
  if (label) {
    label.textContent = linked
      ? (username ? `@${username}` : 'Instagram conectado')
      : 'Instagram desconectado';
  }

  // ── Badge no nav-item de Configurações (opcional, remove se não quiser) ─
  const cfgNav = document.querySelector('.nav-item[data-section="settings"]');
  if (cfgNav) {
    let badge = cfgNav.querySelector('.nav-badge-ig');
    if (!linked) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge nav-badge-ig';
        badge.title = 'Conta Instagram não conectada';
        badge.textContent = '!';
        cfgNav.appendChild(badge);
      }
    } else {
      badge?.remove();
    }
  }
}

function closeIgConnectModal() {
  document.getElementById('ig-connect-overlay').classList.add('hidden');
}

function igShowStep(step) {
  const map = {
    credentials: 'ig-step-credentials',
    '2fa':       'ig-step-2fa',
    success:     'ig-step-success',
  };
  Object.entries(map).forEach(([k, id]) => {
    document.getElementById(id)?.classList.toggle('hidden', k !== step);
  });
}

/* ── Enviar credenciais Instagram ───────────────────────── */
async function handleIgConnect() {
  const username = document.getElementById('ig-username').value.trim();
  const password = document.getElementById('ig-password').value;
  const btn      = document.getElementById('ig-connect-btn');

  setAuthError('ig-cred-error', '');
  if (!username || !password) {
    setAuthError('ig-cred-error', 'Preencha usuário e senha do Instagram.'); return;
  }

  setLoading(btn, true, '<i class="fa-solid fa-link"></i> Conectar');
  try {
    const data = await apiFetch('/api/instagram/connect', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    if (data.requires2FA) {
      igShowStep('2fa');
    } else {
      auth.linkIg();
      // Busca o user atualizado e sincroniza o status na UI
      apiFetch('/api/auth/me').then(r => renderIgStatus(r.user)).catch(() => {});
      igShowStep('success');
    }
  } catch (e) {
    setAuthError('ig-cred-error', e.message || 'Falha ao conectar. Verifique suas credenciais.');
  } finally {
    setLoading(btn, false, '<i class="fa-solid fa-link"></i> Conectar');
  }
}

/* ── Verificar código 2FA ───────────────────────────────── */
async function handleIg2FA() {
  const code = document.getElementById('ig-2fa-code').value.trim();
  const btn  = document.getElementById('ig-2fa-submit');

  setAuthError('ig-2fa-error', '');
  if (code.length !== 6 || !/^\d+$/.test(code)) {
    setAuthError('ig-2fa-error', 'Insira o código de 6 dígitos.'); return;
  }

  setLoading(btn, true, '<i class="fa-solid fa-check"></i> Verificar');
  try {
    const data = await apiFetch('/api/instagram/verify2fa', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    if (data.requires2FA && data.pendingProfile === 'reply') {
      // limpa o campo e mostra aviso para o segundo código
      document.getElementById('ig-2fa-code').value = '';
      document.getElementById('ig-2fa-code').focus();
      setAuthError('ig-2fa-error', ''); // limpa erro anterior

      // atualiza o texto informativo do modal para deixar claro que é o 2º perfil
      const infoEl = document.querySelector('#ig-step-2fa .ig-info-text');
      if (infoEl) {
        infoEl.innerHTML = `
          <strong>Sessão de resposta automática</strong><br>
          O Instagram solicitou verificação para a segunda sessão (resposta automática).
          Insira o novo código enviado para seu e-mail ou telefone.
        `;
      }
      return; // permanece na tela de 2FA aguardando o segundo código
    }

    // tudo ok — ambos os perfis verificados
    auth.linkIg();
    apiFetch('/api/auth/me').then(r => renderIgStatus(r.user)).catch(() => {});
    igShowStep('success');
  } catch (e) {
    setAuthError('ig-2fa-error', e.message || 'Código inválido ou expirado.');
  } finally {
    setLoading(btn, false, '<i class="fa-solid fa-check"></i> Verificar');
  }
}

/* ── Reenviar código ────────────────────────────────────── */
async function handleIgResend() {
  const btn = document.getElementById('ig-resend-btn');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    await apiFetch('/api/instagram/resend2fa', { method: 'POST' });
    showToast('info', 'Código reenviado.');
    document.getElementById('ig-2fa-code').value = '';
    document.getElementById('ig-2fa-code').focus();
  } catch (e) {
    showToast('error', 'Não foi possível reenviar: ' + e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Reenviar código'; }, 30000);
  }
}

/* ── Auto-avança ao digitar 6 dígitos ───────────────────── */
function init2FAInput() {
  document.getElementById('ig-2fa-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) handleIg2FA();
  });
}

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
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token ? { 'Authorization': 'Bearer ' + auth.token } : {}),
    },
    ...opts,
  });

  // Só desloga se o 401 vier de uma rota que NÃO seja do Instagram
  if (res.status === 401 && !path.startsWith('/api/instagram/')) {
    auth.clear();
    showAuthScreen();
    throw new Error('Sessão expirada.');
  }

  if (!res.ok) {
    // Tenta parsear como JSON para pegar a mensagem legível
    let msg;
    try {
      const json = await res.json();
      msg = json.message || json.error || JSON.stringify(json);
    } catch (_) {
      msg = await res.text();
    }
    throw new Error(msg);
  }

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
    el.classList.toggle('hidden', el.id !== `section-${sec}`));
  if (sec === 'comments')  loadComments();
  if (sec === 'dashboard') loadDashboard();
  if (sec === 'automation') loadTemplates();   // ← adicionar esta linha
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
  const newCount = pending;

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setVal('m-total',   total);
  setVal('m-new',     newCount);
  setVal('m-pending', pending);
  setVal('m-manual',  replied);
  setVal('m-ai',      replied);

  // ── Tendências via data-metric ──────────────────────────────────────────
  const metricValues = { total, new: newCount, pending, manual: replied, ai: replied };
  const prevValues   = prev
    ? { total: prev.total ?? 0, new: prev.pending ?? 0, pending: prev.pending ?? 0, manual: prev.replied ?? 0, ai: prev.replied ?? 0 }
    : null;

  document.querySelectorAll('.metric-card[data-metric]').forEach(card => {
    const key     = card.dataset.metric;
    const trendEl = card.querySelector('.metric-trend');
    if (!trendEl) return;

    if (!prevValues) { trendEl.style.visibility = 'hidden'; return; }

    const current  = metricValues[key] ?? 0;
    const previous = prevValues[key]   ?? 0;
    const delta    = current - previous;
    const pct      = previous > 0 ? Math.round((delta / previous) * 100) : 0;
    const up       = delta >= 0;

    trendEl.className = `metric-trend ${up ? 'up' : 'down'}`;
    trendEl.innerHTML = `<i class="fa-solid fa-arrow-trend-${up ? 'up' : 'down'}"></i> ${up ? '+' : ''}${pct}%`;
    trendEl.style.visibility = '';
  });

  // ── Posts recentes ─────────────────────────────────────────────────────
  const postList = document.getElementById('posts-list');
  if (!postList) return;

  if (!recent.length) {
    postList.innerHTML = '<div class="loading-state"><span>Nenhum comentário recente</span></div>';
    return;
  }

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
      const safe = title.length > 40 ? title.slice(0, 40) + '…' : title;
      const thumbHtml = thumb
        ? `<img src="${avatarSrc(thumb, 'thumb-' + shortcode)}"
                style="width:100%;height:100%;object-fit:cover;border-radius:6px"
                onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fa-solid fa-image'}))">`
        : '<i class="fa-solid fa-image"></i>';
      return `
        <div class="post-row">
          <div class="post-thumb">${thumbHtml}</div>
          <div class="post-info">
            <div class="post-name" title="${shortcode}">${safe}</div>
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

  let data = hourly;
  const allZero = data.every(v => v === 0);
  if (allZero && state.comments.length) {
    data = new Array(24).fill(0);
    state.comments.forEach(c => {
      if (c.timestamp) data[new Date(c.timestamp).getHours()]++;
    });
  }

  const max = Math.max(...data, 1);
  el.innerHTML = data.map((v, h) => `
    <div class="bar-wrap">
      <div class="bar"
           style="height:${Math.max(4, (v / max) * 100)}%"
           title="${String(h).padStart(2,'0')}h — ${v} comentário${v !== 1 ? 's' : ''}">
      </div>
    </div>`).join('');
}

/* ── Comentários ────────────────────────────────────────── */
async function loadComments(page = 1) {
  const params = new URLSearchParams({ page, limit: 200 }); // limit alto para pegar tudo

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

async function markAsRepliedApi(commentId) {
  const comment = state.comments.find(c => String(c.id) === String(commentId));
  if (!comment) return;

  try {
    await apiFetch(`/api/comments/${commentId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ replied: true }),
    });

    comment.replied   = true;
    comment.repliedAt = comment.repliedAt || new Date().toISOString();

    renderComments();
    if (String(state.selectedComment) === String(commentId)) {
      renderDetail(comment);
    }
    showToast('success', 'Comentário marcado como respondido.');
    syncStats();
  } catch (e) {
    showToast('error', 'Erro ao marcar como respondido: ' + e.message);
  }
}


async function syncStats() {
  try {
    const data = await apiFetch('/api/state');
    state.stats = data.stats;
    updateBadge(data.stats.pending ?? 0);
  } catch (_) {}
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
  if (!listEl) return;
  document.getElementById('comments-loading')?.remove();

  const list = getFilteredComments();
  if (!list.length) {
    listEl.innerHTML = `<div class="loading-state"><i class="fa-regular fa-face-meh" style="font-size:28px;opacity:.3"></i><span>Nenhum comentário encontrado</span></div>`;
    return;
  }

  listEl.innerHTML = list.map(c => {
    const status = c.replied ? 'replied-manual' : 'pending';
    const age    = timeSince(c.timestamp);
    return `
      <div class="comment-item ${String(c.id) === String(state.selectedComment) ? 'selected' : ''} ${!c.replied ? 'is-new' : ''}"
           data-id="${c.id}" data-shortcode="${c.postShortcode || ''}" data-user="${c.user}">
        <img class="avatar" src="${avatarSrc(c.profilePic, c.id)}" alt="${c.user}"
             loading="lazy" onerror="this.src='https://i.pravatar.cc/80?u=${c.id}'" />
        <div class="comment-item-body">
          <div class="comment-item-top">
            <span class="comment-username">@${c.user}</span>
            <span class="comment-time">${age}</span>
          </div>
          <div class="comment-text">${c.text}</div>
          <div class="comment-meta">
            <span class="status-tag ${statusClass(status)}">${statusLabel(status)}</span>
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
        markAsRepliedApi(_commentId);
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
  const ta  = document.getElementById('reply-textarea');
  const btn = document.getElementById('btn-send-reply');
  const text = ta?.value.trim();

  if (!text) { showToast('error', 'Digite uma resposta antes de enviar.'); return; }
  if (!btn) return;

  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Enviando…';

  try {
    await apiFetch(`/api/comments/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply: text }),
    });

    const c = state.comments.find(c => String(c.id) === String(id));
    if (c) { c.replied = true; c.reply = text; c.repliedAt = new Date().toISOString(); }

    state.replyDraft = '';
    renderComments();
    renderDetail(state.comments.find(c => String(c.id) === String(id)));
    showToast('success', isAi ? 'Resposta da IA enviada.' : 'Resposta enviada com sucesso.');
  } catch (e) {
    showToast('error', 'Erro ao enviar resposta: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = originalHTML;
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

    const data = await apiFetch('/api/ai-reply', {
      method: 'POST',
      body: JSON.stringify({
        commentId: comment.id,
        username: comment.user,
        text: comment.text,
        systemPrompt: systemPrompt || undefined,
      }),
    });

    const aiText = data.reply;
    if (!aiText) throw new Error('Resposta vazia');

    ta.value = aiText;
    state.replyDraft = aiText;

    const count = document.getElementById('char-count');
    if (count) count.textContent = `${aiText.length}/300`;

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
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

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

  const debouncedSearch = debounce(query => {
    state.searchQuery = query;
    if (state.activeSection !== 'comments') switchSection('comments');
    else loadComments();
  }, 350);
  
  document.getElementById('search-input')?.addEventListener('input', e => {
    debouncedSearch(e.target.value.toLowerCase().trim());
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
      const data = await apiFetch('/api/bot/mode', {
        method: 'POST',
        body: JSON.stringify({ autoReply: on }),
      });
      
      state.automationEnabled = data.autoReply;
      state.autoReply = data.autoReply;
      state.botRunning = data.botRunning;
      
      syncAutomationUI(data.autoReply);
      
      showToast(
        data.autoReply ? 'success' : 'info',
        data.autoReply
          ? 'Automação ativada. O bot começou a monitorar comentários.'
          : 'Automação desativada. O bot foi parado.'
      );
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
let templates = [];   // preenchido via API
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
      <div class="rule-icon"><i class="fa-solid ${t.icon || 'fa-bolt'}"></i></div>
      <div class="rule-body">
        <div class="rule-name">${t.name}</div>
        <div class="rule-trigger"><i class="fa-solid fa-key"></i> ${t.trigger}</div>
        <div class="rule-preview">${t.response}</div>
      </div>
      <div class="rule-actions">
        <span class="rule-hit">${t.hits ?? 0} uso${(t.hits ?? 0) !== 1 ? 's' : ''}</span>
        <label class="toggle-switch">
          <input type="checkbox" class="tpl-toggle" data-tpl-id="${t.id}" ${t.active ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <button class="icon-btn tpl-edit" data-tpl-id="${t.id}" title="Editar">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="icon-btn tpl-del" data-tpl-id="${t.id}" title="Remover">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.tpl-toggle').forEach(tog => {
    tog.addEventListener('change', async e => {
      const id  = e.target.dataset.tplId;
      const tpl = templates.find(t => t.id === id);
      if (!tpl) return;
      e.target.disabled = true;
      try {
        const updated = await apiFetch(`/api/templates/${id}/toggle`, { method: 'PATCH' });
        tpl.active = updated.active;
        showToast(tpl.active ? 'success' : 'info', `"${tpl.name}" ${tpl.active ? 'ativada' : 'desativada'}.`);
      } catch (err) {
        e.target.checked = !e.target.checked; // reverte visualmente
        showToast('error', 'Erro ao alterar template: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });
  });

  list.querySelectorAll('.tpl-edit').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.tplId));
  });

  list.querySelectorAll('.tpl-del').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteTemplate(btn.dataset.tplId));
  });
}

async function loadTemplates() {
  const list = document.getElementById('rules-list');
  if (list) list.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Carregando…</span></div>`;
  try {
    templates = await apiFetch('/api/templates');
    renderTemplates();
  } catch (e) {
    showToast('error', 'Erro ao carregar templates: ' + e.message);
    if (list) list.innerHTML = `<div class="loading-state"><span>Falha ao carregar templates.</span></div>`;
  }
}

async function confirmDeleteTemplate(id) {
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;
  if (!confirm(`Remover "${tpl.name}"? Esta ação não pode ser desfeita.`)) return;
  try {
    await apiFetch(`/api/templates/${id}`, { method: 'DELETE' });
    templates = templates.filter(t => t.id !== id);
    renderTemplates();
    showToast('info', `"${tpl.name}" removida.`);
  } catch (e) {
    showToast('error', 'Erro ao remover template: ' + e.message);
  }
}

/* ── Modal ───────────────────────────────────────────────── */
let editingRuleId = null;

function openModal(editId = null) {
  editingRuleId = editId;
  const tpl = editId ? templates.find(t => t.id === editId) : null;

  document.getElementById('modal-title').textContent      = tpl ? 'Editar Resposta Pronta' : 'Nova Resposta Pronta';
  document.getElementById('rule-name').value              = tpl?.name     ?? '';
  document.getElementById('rule-trigger').value           = tpl?.trigger  ?? '';
  document.getElementById('rule-response').value          = tpl?.response ?? '';
  document.getElementById('rule-active').checked          = tpl ? tpl.active : true;
  document.getElementById('modal-save').textContent       = tpl ? 'Salvar Alterações' : 'Salvar Resposta';

  // Limpa erros visuais anteriores
  ['rule-name', 'rule-trigger', 'rule-response'].forEach(id =>
    document.getElementById(id)?.classList.remove('input-error'));

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function initModal() {
  const overlay = document.getElementById('modal-overlay');
  const close = () => overlay.classList.add('hidden');
  document.getElementById('modal-close').addEventListener('click', close);
  document.getElementById('modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('modal-save').addEventListener('click', async () => {
    const nameEl    = document.getElementById('rule-name');
    const triggerEl = document.getElementById('rule-trigger');
    const textEl    = document.getElementById('rule-response');
    const saveBtn   = document.getElementById('modal-save');
  
    const name     = nameEl.value.trim();
    const trigger  = triggerEl.value.trim();
    const response = textEl.value.trim();
    const active   = document.getElementById('rule-active').checked;
    const icon     = ICONS_POOL[Math.floor(Math.random() * ICONS_POOL.length)];
  
    // Validação visual inline
    [nameEl, triggerEl, textEl].forEach(el => el.classList.remove('input-error'));
    let hasError = false;
    if (!name)     { nameEl.classList.add('input-error');    hasError = true; }
    if (!trigger)  { triggerEl.classList.add('input-error'); hasError = true; }
    if (!response) { textEl.classList.add('input-error');    hasError = true; }
    if (hasError)  { showToast('error', 'Preencha todos os campos obrigatórios.'); return; }
  
    const originalLabel = saveBtn.textContent;
    saveBtn.disabled    = true;
    saveBtn.innerHTML   = '<i class="fa-solid fa-circle-notch fa-spin"></i> Salvando…';
  
    try {
      if (editingRuleId) {
        const updated = await apiFetch(`/api/templates/${editingRuleId}`, {
          method: 'PUT',
          body  : JSON.stringify({ name, trigger, response, active, icon }),
        });
        const idx = templates.findIndex(t => t.id === editingRuleId);
        if (idx !== -1) templates[idx] = updated;
        showToast('success', `"${name}" atualizada.`);
      } else {
        const created = await apiFetch('/api/templates', {
          method: 'POST',
          body  : JSON.stringify({ name, trigger, response, active, icon }),
        });
        templates.unshift(created);
        showToast('success', `"${name}" criada com sucesso.`);
      }
      renderTemplates();
      document.getElementById('modal-overlay').classList.add('hidden');
    } catch (e) {
      showToast('error', 'Erro ao salvar template: ' + e.message);
    } finally {
      saveBtn.disabled  = false;
      saveBtn.textContent = originalLabel;
    }
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

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const si = document.getElementById('search-input');
      if (si) { si.focus(); si.select(); }
    }
  });

  document.getElementById('dash-period')?.addEventListener('change', e => {
    state.dashPeriod = e.target.value;
    loadDashboard();
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

let _eventSource = null;

function startPolling() {
  if (!auth.isLoggedIn()) return;
  if (_eventSource && _eventSource.readyState !== EventSource.CLOSED) return; // já conectado

  if (!window.EventSource) { _fallbackPolling(); return; }

  _eventSource = new EventSource('/api/events?token=' + encodeURIComponent(auth.token || ''));
  let reconnectTimer = null;

  _eventSource.addEventListener('tick', e => {
    const payload = JSON.parse(e.data);
    state.stats = payload.stats;
    state.hourlyReplies = payload.hourlyReplies;
    updateBadge(payload.stats.pending ?? 0);
    if (state.activeSection === 'dashboard') {
      renderDashboardMetrics(payload.stats, [], null);
      renderActivityChart(payload.hourlyReplies);
    }
  });

  _eventSource.addEventListener('new_comments', e => {
    const payload = JSON.parse(e.data);
    state.stats = payload.stats;
    updateBadge(payload.stats.pending ?? 0);
    const preview = payload.previews[0];
    const msg = payload.count === 1
      ? `Novo comentário de @${preview.user}: "${preview.text.slice(0, 50)}${preview.text.length > 50 ? '…' : ''}"`
      : `${payload.count} novos comentários recebidos`;
    showToast('info', msg);
    if (state.activeSection === 'comments')  loadComments();
    if (state.activeSection === 'dashboard') loadDashboard();
  });

  _eventSource.onerror = () => {
    _eventSource.close();
    _eventSource = null;
    clearTimeout(reconnectTimer);
    if (auth.isLoggedIn()) reconnectTimer = setTimeout(startPolling, 5000);
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
function initAuth() {
  /* Mostrar tela correta na carga */
  if (auth.isLoggedIn()) {
    showApp();
  } else {
    showAuthScreen();
  }

  initAuthTabs();
  initPasswordToggles();
  initAuthEnterKey();
  init2FAInput();

  /* Botões de auth */
  document.getElementById('btn-login')?.addEventListener('click', handleLogin);
  document.getElementById('btn-register')?.addEventListener('click', handleRegister);
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);

  /* Modal Instagram */
  // Botão fechar do modal IG
  document.getElementById('ig-connect-close')?.addEventListener('click', () => {
    const successStep = document.getElementById('ig-step-success');
    const user = auth.user;
    if (!successStep?.classList.contains('hidden') || user?.igLinked) {
      closeIgConnectModal();
    } else {
      setAuthError('ig-cred-error', 'Conclua a conexão com o Instagram antes de continuar.');
    }
  });

  // Botão "Ir para o Dashboard" no step de sucesso
  document.getElementById('ig-done-btn')?.addEventListener('click', () => {
    closeIgConnectModal();
    switchSection('dashboard');
  });

  // Overlay — só fecha se já vinculado
  document.getElementById('ig-connect-overlay')?.addEventListener('click', e => {
    if (e.target !== document.getElementById('ig-connect-overlay')) return;
    const user = auth.user;
    if (user?.igLinked) closeIgConnectModal();
  });

  document.getElementById('ig-connect-btn')?.addEventListener('click', handleIgConnect);
  document.getElementById('ig-2fa-submit')?.addEventListener('click', handleIg2FA);
  document.getElementById('ig-2fa-back')?.addEventListener('click', () => igShowStep('credentials'));
  document.getElementById('ig-resend-btn')?.addEventListener('click', handleIgResend);
}

document.addEventListener('DOMContentLoaded', async () => {
  initAuth();

  // Sincroniza status do Instagram assim que a UI estiver pronta
  if (auth.isLoggedIn()) {
    apiFetch('/api/auth/me')
      .then(r => renderIgStatus(r.user))
      .catch(() => renderIgStatus(null));
  }

  initNav();
  initFilters();
  initModal();
  initSettings();
  initHeader();
  loadTemplates();

  await loadDashboard();
  await initAutomation();

  startPolling();
  setTimeout(() => document.getElementById('comments-loading')?.remove(), 800);
});
