'use strict';

// #region Imports
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');
const { watchComments, replyToComment, fetchComments } = require('./comments');
const { askGemini } = require('./gemini.js');
const {
  launchBrowser,
  saveSession,
  loadSession,
  isLoggedIn,
  connectUser,
  verify2FAUser,
  resend2FA,
} = require('./instagram');
// #endregion

// #region Setup
const app  = express();
const PORT = process.env.PORT || 3000;

const PROMPT_FILE  = path.join(__dirname, 'prompt.txt');
const DB_DIR       = path.join(__dirname, 'db');
const USERS_DIR    = path.join(__dirname, 'users');

[DB_DIR, USERS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const sqliteDb = new Database(path.join(DB_DIR, 'app.db'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// #endregion

// #region Database
sqliteDb.pragma('journal_mode = WAL');
sqliteDb.pragma('foreign_keys = ON');

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    hash        TEXT NOT NULL,
    salt        TEXT NOT NULL,
    ig_linked   INTEGER DEFAULT 0,
    ig_username TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    response   TEXT NOT NULL,
    active     INTEGER DEFAULT 1,
    hits       INTEGER DEFAULT 0,
    icon       TEXT DEFAULT 'fa-bolt',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_user    ON tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
`);

setInterval(() => {
  sqliteDb.prepare('DELETE FROM tokens WHERE expires_at < ?').run(Date.now());
}, 3_600_000);
// #endregion

// #region User / Session Helpers
function getUserDir(userId) {
  const row   = sqliteDb.prepare('SELECT ig_username, name FROM users WHERE id = ?').get(userId);
  // Usa ig_username se disponível, senão name — nunca email para evitar label instável
  const label = (row?.ig_username || row?.name || userId)
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(USERS_DIR, label);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionPath(userId, profile) {
  return path.join(getUserDir(userId), `session_${profile}.json`);
}

function getUserDataDir(userId, profile) {
  const dir = path.join(getUserDir(userId), `userdata_${profile}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCommentsPath(userId) {
  return path.join(getUserDir(userId), 'comments.json');
}

function getConfigPath(userId) {
  return path.join(getUserDir(userId), 'config.json');
}


async function openUserSession(userId, profile = 'monitor') {
  const sessionPath = getSessionPath(userId, profile);
  const userDataDir = getUserDataDir(userId, profile);
  const browser     = await launchBrowser(true, userDataDir);
  const page        = await browser.newPage();
  const loaded      = await loadSession(page, sessionPath);
  if (!loaded) { await browser.close(); throw new Error(`Sessão [${profile}] não encontrada.`); }
  const ok = await isLoggedIn(page);
  if (!ok)  { await browser.close(); throw new Error(`Sessão [${profile}] expirada.`); }
  return { browser, page };
}

function loadComments(userId) {
  const p = getCommentsPath(userId);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; } catch (_) { return {}; }
}

function saveComments(userId, data) {
  fs.writeFileSync(getCommentsPath(userId), JSON.stringify(data, null, 2));
}

function getActiveUserId() {
  const row = sqliteDb.prepare('SELECT id FROM users WHERE ig_linked = 1 LIMIT 1').get();
  return row?.id || null;
}

function markIgLinked(userId, igUsername) {
  sqliteDb.prepare('UPDATE users SET ig_linked = 1, ig_username = ? WHERE id = ?').run(igUsername || null, userId);
}
// #endregion

// #region Auth
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash, salt };
}

function createToken(userId) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  sqliteDb.prepare('INSERT INTO tokens (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
  return token;
}

function validateToken(token) {
  const row = sqliteDb.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    sqliteDb.prepare('DELETE FROM tokens WHERE token = ?').run(token);
    return null;
  }
  return row.user_id;
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ message: 'Não autenticado.' });
  const userId = validateToken(token);
  if (!userId) return res.status(401).json({ message: 'Sessão expirada. Faça login novamente.' });
  const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ message: 'Usuário não encontrado.' });
  req.userId = userId;
  req.user   = { id: userId, name: user.name, email: user.email, igLinked: !!user.ig_linked, igUsername: user.ig_username || null };
  next();
}

function register(name, email, password) {
  if (!name || !email || !password || password.length < 8)
    throw Object.assign(new Error('Dados inválidos.'), { status: 400 });
  if (sqliteDb.prepare('SELECT id FROM users WHERE email = ?').get(email))
    throw Object.assign(new Error('E-mail já cadastrado.'), { status: 409 });

  const id             = crypto.randomUUID();
  const { hash, salt } = hashPassword(password);
  sqliteDb
    .prepare('INSERT INTO users (id,name,email,hash,salt) VALUES (?,?,?,?,?)')
    .run(id, name, email, hash, salt);

  seedUserTemplates(id); // ← templates padrão

  return { token: createToken(id), user: { id, name, email, igLinked: false } };
}

function loginUser(email, password) {
  const user = sqliteDb.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw Object.assign(new Error('Credenciais inválidas.'), { status: 401 });
  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.hash) throw Object.assign(new Error('Credenciais inválidas.'), { status: 401 });
  return { token: createToken(user.id), user: { id: user.id, name: user.name, email: user.email, igLinked: !!user.ig_linked } };
}
// #endregion

// #region Instagram Connect

async function connectInstagramForUser(userId, username, password) {
  return connectUser({
    userId,
    username,
    password,
    getSessionPath,   // já existe no index.js
    getUserDataDir,   // já existe no index.js
  });
}

// #endregion

// #region Bot Config

const cfgDefaults = {
  scanInterval : 3,
  delay        : 5,
  maxPerCycle  : 10,
  maxChars     : 200,
  readonly     : false,
  replyOld     : true,
  autoReply    : false,
  systemPrompt : '',
};

// Lê o config de um usuário (com fallback para defaults)
function loadUserCfg(userId) {
  const p = getConfigPath(userId);
  try {
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { ...cfgDefaults, ...saved };
    }
  } catch (_) {}
  return { ...cfgDefaults };
}

// Salva o config de um usuário
function saveUserCfg(userId, cfg) {
  const p = getConfigPath(userId);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

// Atualiza campos específicos do config de um usuário e retorna o config completo
function patchUserCfg(userId, patch) {
  const cfg = loadUserCfg(userId);
  const next = { ...cfg, ...patch };
  saveUserCfg(userId, next);
  return next;
}

// #endregion

// #region Templates

const TEMPLATES_DEFAULT_DATA = [
  {
    name    : 'Pergunta sobre Preço',
    trigger : 'preço, valor, quanto custa, caro, barato',
    response: 'Olá! Os preços estão disponíveis no nosso site. Acesse pelo link na bio 🛍️',
    icon    : 'fa-tag',
  },
  {
    name    : 'Dúvidas sobre Envio',
    trigger : 'frete, entrega, prazo, envio, correios',
    response: 'Enviamos para todo o Brasil! Prazo e frete são calculados na finalização da compra 🚚',
    icon    : 'fa-truck',
  },
];

function seedUserTemplates(userId) {
  const existing = sqliteDb
    .prepare('SELECT COUNT(*) as c FROM templates WHERE user_id = ?')
    .get(userId);
  if (existing.c > 0) return; // já tem templates, não duplica

  const insert = sqliteDb.prepare(`
    INSERT INTO templates (id, user_id, name, trigger, response, active, hits, icon)
    VALUES (@id, @userId, @name, @trigger, @response, 1, 0, @icon)
  `);

  const insertMany = sqliteDb.transaction(rows => {
    rows.forEach(r => insert.run(r));
  });

  insertMany(TEMPLATES_DEFAULT_DATA.map(t => ({
    id    : crypto.randomUUID(),
    userId,
    name  : t.name,
    trigger: t.trigger,
    response: t.response,
    icon  : t.icon,
  })));
}

function listTemplates(userId) {
  return sqliteDb
    .prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId);
}

function createTemplate(userId, { name, trigger, response, active = 1, icon = 'fa-bolt' }) {
  const id = crypto.randomUUID();
  sqliteDb.prepare(`
    INSERT INTO templates (id, user_id, name, trigger, response, active, icon)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, trigger, response, active ? 1 : 0, icon);
  return sqliteDb.prepare('SELECT * FROM templates WHERE id = ?').get(id);
}

function updateTemplate(userId, id, patch) {
  const allowed  = ['name', 'trigger', 'response', 'active', 'icon'];
  const fields   = Object.keys(patch).filter(k => allowed.includes(k));
  if (!fields.length) return null;

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const params    = { id, userId };
  fields.forEach(f => {
    params[f] = f === 'active' ? (patch[f] ? 1 : 0) : patch[f];
  });

  sqliteDb.prepare(`
    UPDATE templates
    SET ${setClause}, updated_at = datetime('now')
    WHERE id = @id AND user_id = @userId
  `).run(params);

  return sqliteDb.prepare('SELECT * FROM templates WHERE id = ?').get(id);
}

function deleteTemplate(userId, id) {
  const info = sqliteDb
    .prepare('DELETE FROM templates WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return info.changes > 0;
}

function incrementTemplateHit(templateId) {
  sqliteDb
    .prepare('UPDATE templates SET hits = hits + 1, updated_at = datetime(\'now\') WHERE id = ?')
    .run(templateId);
}

/**
 * Testa o texto de um comentário contra os templates ativos do usuário.
 * Retorna o primeiro template cujos gatilhos batem, ou null.
 */
function matchTemplate(userId, text) {
  const active = sqliteDb
    .prepare('SELECT * FROM templates WHERE user_id = ? AND active = 1 ORDER BY created_at ASC')
    .all(userId);

  const lower = (text || '').toLowerCase();

  for (const tpl of active) {
    const keywords = tpl.trigger
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    if (keywords.some(kw => lower.includes(kw))) {
      return tpl;
    }
  }
  return null;
}

// #endregion

// #region State / Logs / Stats
const state = {
  logs: [],
  stats: { total: 0, replied: 0, pending: 0, lastScan: null, scanInterval: 3 },
  botRunning: false,
  hourlyReplies: new Array(24).fill(0),
};

function addLog(msg, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    }),
    msg,
    type
  };

  state.logs.unshift(entry);

  if (state.logs.length > 200) {
    state.logs.pop();
  }

  const line = `[${entry.time}] [${type.toUpperCase()}] ${msg}`;

  if (type === 'error') {
    console.error(line);
  } else if (type === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function syncAllStats() {
  try {
    let total = 0, replied = 0;
    const hourly = new Array(24).fill(0);
    const now    = Date.now();
    const linked = sqliteDb.prepare('SELECT id FROM users WHERE ig_linked = 1').all();
    linked.forEach(({ id }) => {
      const db   = loadComments(id);
      const keys = Object.keys(db).filter(k => !k.startsWith('__'));
      total   += keys.length;
      replied += keys.filter(k => db[k].replied).length;
      keys.forEach(k => {
        if (!db[k].seenAt) return;
        const ts = new Date(db[k].seenAt).getTime();
        if (now - ts <= 86400000) hourly[new Date(ts).getHours()]++;
      });
    });
    state.stats.total   = total;
    state.stats.replied = replied;
    state.stats.pending = total - replied;
    state.hourlyReplies = hourly;
    state.botRunning    = userWatchers.size > 0;
  } catch (e) { addLog('Erro em syncAllStats: ' + e.message, 'error'); }
}

function getRecentComments(n) {
  const uid = getActiveUserId();
  if (!uid) return [];
  const db = loadComments(uid);
  return Object.entries(db)
    .filter(([k]) => !k.startsWith('__'))
    .map(([k, v]) => ({ id: k, user: v.username, ...v }))
    .sort((a, b) => new Date(b.seenAt) - new Date(a.seenAt))
    .slice(0, n || 10);
}

function listComments({ page = 1, limit = 15, filter = 'all', q = '' }) {
  const uid = getActiveUserId();
  const db  = uid ? loadComments(uid) : {};

  let all = Object.entries(db)
    .filter(([k]) => !k.startsWith('__'))
    .map(([k, v]) => ({
      id          : k,
      user        : v.username,
      text        : v.text,
      postUrl     : v.postUrl,
      postShortcode: v.postShortcode,
      postTitle   : v.postTitle,
      thumbnailUrl: v.thumbnailUrl,
      profilePic  : v.profilePic || '',
      replied     : !!v.replied,
      reply       : v.replyText,
      repliedAt   : v.repliedAt,
      timestamp   : v.seenAt,
      datetime    : v.datetime   || '',
      timeLabel   : v.timeLabel  || '',
      timeIsRelative: !!v.timeIsRelative,
    }));

  if (filter === 'pending') all = all.filter(c => !c.replied);
  if (filter === 'replied') all = all.filter(c =>  c.replied);
  if (q) all = all.filter(c =>
    c.user?.toLowerCase().includes(q) || c.text?.toLowerCase().includes(q));

  // ── Ordenação: mais recente primeiro ──────────────────────────────────
  all.sort((a, b) => {
    const tsA = effectiveTimestamp(a);
    const tsB = effectiveTimestamp(b);
    return tsB - tsA;
  });

  const total = all.length;
  const pages = Math.ceil(total / limit) || 1;
  const items = all.slice((page - 1) * limit, page * limit);
  return { items, total, page, pages };
}

/**
 * Resolve o timestamp efetivo de um comentário para ordenação.
 *
 * Prioridade:
 *   1. datetime exato do Instagram (via <time datetime="...">)
 *   2. timeLabel relativo convertido em ms a partir de agora
 *   3. seenAt (fallback — quando dois comentários têm o mesmo seenAt,
 *      o relativo mais curto = mais recente)
 */
function effectiveTimestamp(c) {
  // 1. Datetime exato
  if (c.datetime) {
    const t = Date.parse(c.datetime);
    if (!isNaN(t)) return t;
  }

  // 2. timeLabel relativo: "17 min", "2h", "1 d", "1 sem.", "3w", etc.
  if (c.timeIsRelative && c.timeLabel) {
    const ms = parseLabelToMs(c.timeLabel);
    if (ms !== null) return Date.now() - ms;
  }

  // 3. Fallback: seenAt
  return c.timestamp ? Date.parse(c.timestamp) : 0;
}

/**
 * Converte um timeLabel relativo do Instagram em milissegundos de diferença.
 * Retorna null se não conseguir parsear.
 * Exemplos: "17 min", "2h", "1 d", "1 sem.", "2w", "3s"
 */
function parseLabelToMs(label) {
  if (!label) return null;
  const txt = label.trim().toLowerCase();

  const match = txt.match(/^(\d+)\s*(s|seg\.?|m|min\.?|h|d|w|sem\.?)$/);
  if (!match) return null;

  const n    = parseInt(match[1], 10);
  const unit = match[2].replace(/\./, '');

  const map = {
    s: 1000,
    seg: 1000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    sem: 604_800_000,
  };

  const factor = map[unit] ?? null;
  return factor !== null ? n * factor : null;
}
// #endregion

// #region AI / Prompt
function loadSystemPrompt() {
  try { if (fs.existsSync(PROMPT_FILE)) { const c = fs.readFileSync(PROMPT_FILE, 'utf8').trim(); if (c) return c; } } catch (_) {}
}

function buildPrompt(systemPrompt, username, text) {
  const base       = systemPrompt || loadSystemPrompt();
  const comentario = '@' + username + ': ' + text;
  if (base?.includes('{{COMENTARIO_DO_USUARIO}}')) return base.replace(/\{\{COMENTARIO_DO_USUARIO\}\}/g, comentario);
  return (base || '') + '\n\nComentário de @' + username + ': "' + text + '"\n\nResponda apenas com o texto da resposta, sem explicações.';
}

async function autoReplyFn(userId, comment) {
  const compositeKey =
    comment.key ??
    comment.id ??
    (comment.username && comment.postShortcode && comment.commentId
      ? `${comment.username}::${comment.postShortcode}::${comment.commentId}`
      : null);

  if (!compositeKey) {
    addLog(`⚠️ autoReplyFn: chave indefinida para @${comment.username} — abortando`, 'warn');
    return null;
  }

  try {
    const matched = matchTemplate(userId, comment.text);

    if (matched) {
      const reply = matched.response;
      incrementTemplateHit(matched.id);
      // ← NÃO salva replied:true aqui; replyToComment fará isso após postar
      addLog(`⚡ Template "${matched.name}" respondeu @${comment.username}`, 'ok');
      return reply;
    }

    const cfg    = loadUserCfg(userId);
    const prompt = buildPrompt(cfg.systemPrompt || null, comment.username, comment.text);
    const reply  = await askGemini(prompt);
    if (!reply) throw new Error('Resposta vazia da IA');
    return reply;

  } catch (e) {
    addLog(`❌ Erro ao responder @${comment.username}: ${e.message}`, 'error');
    return null;
  }
}

// #endregion

// #region SSE
let sseClients = [];

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients = sseClients.filter(r => { try { r.write(data); return true; } catch (_) { return false; } });
}

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  sseClients.push(res);
  req.on('close', () => { clearInterval(hb); sseClients = sseClients.filter(c => c !== res); });
});
// #endregion

// #region Bot Watcher
const userWatchers = new Map();

async function startUserBot(userId) {
  if (userWatchers.has(userId)) return;

  const row = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row || !row.ig_linked) return;

  const cfg   = loadUserCfg(userId);
  const label = row.ig_username || row.name || userId;
  const sessionPath = getSessionPath(userId, 'monitor');

  if (!fs.existsSync(sessionPath)) {
    addLog(`[${label}] Sessão monitor não encontrada.`, 'warn');
    return;
  }

  try {
    const watcher = await watchComments({
      intervalMs      : cfg.scanInterval * 60 * 1000,
      scrolls         : 5,
      autoReply       : cfg.autoReply,
      replyFn         : async (comment) => {
        // Resolve o texto E os metadados
        const compositeKey =
          comment.key ??
          (comment.username && comment.postShortcode && comment.commentId
            ? `${comment.username}::${comment.postShortcode}::${comment.commentId}`
            : null);
    
        const result = await autoReplyFn(userId, comment);
        if (!result) return null;
    
        // Após replyToComment ter sucesso (chamado pelo watcher),
        // precisamos gravar os metadados — fazemos isso via hook pós-reply.
        // Armazena no closure para o watcher usar depois.
        comment.__meta = result.meta ?? { replySource: 'ai' };
        return result.text ?? result;
      },
      replyDelayMs    : cfg.delay * 1000,
      sessionPath     : getSessionPath(userId, 'monitor'),
      userDataDir     : getUserDataDir(userId, 'monitor'),
      commentsPath    : getCommentsPath(userId),
      replySessionPath: getSessionPath(userId, 'reply'),
      replyUserDataDir: getUserDataDir(userId, 'reply'),
    });

    if (!watcher || typeof watcher.on !== 'function')
      throw new Error('watchComments não retornou um watcher válido.');

    watcher.on('tick', info => {
      addLog(`[${label}] Varredura: ${info.newCount} novo(s), ${info.pendingCount} pendente(s)`, 'info');
      syncAllStats();
      broadcast('tick', { stats: state.stats, hourlyReplies: state.hourlyReplies, newCount: info.newCount });
    });

    watcher.on('new', comments => {
      const data = loadComments(userId);
    
      comments.forEach(c => {
        const key = `${c.username}::${c.postShortcode}::${c.commentId}`;
        if (!key.includes('undefined') && !data[key]) {
          // Verifica se já existe variante respondida com fake ID
          const alreadyReplied = Object.values(data).some(
            v => v.username === c.username &&
                 v.postShortcode === c.postShortcode &&
                 v.text === c.text &&
                 v.replied === true
          );
          if (!alreadyReplied) {
            data[key] = { ...c, seenAt: new Date().toISOString(), replied: false };
          }
        }
      });
    
      saveComments(userId, data);
    
      comments.forEach(c => addLog(`[${label}] Novo comentário de @${c.username}`, 'info'));
    
      broadcast('new_comments', {
        count   : comments.length,
        previews: comments.map(c => ({
          id  : `${c.username}::${c.postShortcode}::${c.commentId}`,
          user: c.username,
          text: (c.text || '').slice(0, 80),
        })),
        stats: state.stats,
      });
    });

    watcher.on('error', async err => {
      addLog(`[${label}] Erro no watcher: ${err.message}`, 'error');

      // ── "Frame detached" indica que o browser foi derrubado externamente.
      //    Remove o watcher atual e agenda restart automático. ──────────────
      const isDetached =
        err.message?.includes('detached') ||
        err.message?.includes('Target closed') ||
        err.message?.includes('Session closed');

      if (isDetached) {
        addLog(`[${label}] Browser derrubado — reiniciando bot em 15s…`, 'warn');
        userWatchers.delete(userId);
        setTimeout(() => {
          // Só reinicia se o usuário ainda tem autoReply ligado
          const c = loadUserCfg(userId);
          if (c.autoReply) startUserBot(userId).catch(() => {});
        }, 15_000);
      }
    });

    userWatchers.set(userId, watcher);
    syncAllStats();
    addLog(`[${label}] Bot iniciado (${cfg.autoReply ? 'automático' : 'manual'})`, 'ok');

  } catch (e) {
    addLog(`[${label}] Falha ao iniciar bot: ${e.message}`, 'error');
  }
}


async function stopUserBot(userId) {
  const watcher = userWatchers.get(userId);
  if (!watcher) return;
  try { await watcher.stop(); } catch (_) {}
  userWatchers.delete(userId);
  const row = sqliteDb.prepare('SELECT ig_username, name FROM users WHERE id = ?').get(userId);
  addLog(`[${row?.ig_username || row?.name || userId}] Bot parado.`, 'warn');
}

async function _onIgLinked(userId) {
  const row = sqliteDb.prepare('SELECT ig_username, name FROM users WHERE id = ?').get(userId);
  const label = row?.ig_username || row?.name || userId;

  addLog(`[${label}] Instagram vinculado. Bot aguardando início manual.`, 'ok');

  syncAllStats();
  broadcast('tick', {
    stats: state.stats,
    hourlyReplies: state.hourlyReplies,
    newCount: 0
  });
}
// #endregion

// #region Routes — Auth
app.post('/api/auth/register', (req, res) => {
  try { const r = register(req.body?.name, req.body?.email, req.body?.password); addLog(`Registro: ${req.body?.email}`, 'ok'); res.status(201).json(r); }
  catch (e) { res.status(e.status || 400).json({ message: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  try { const r = loginUser(req.body?.email, req.body?.password); addLog(`Login: ${req.body?.email}`, 'ok'); res.json(r); }
  catch (e) { res.status(e.status || 401).json({ message: e.message }); }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) sqliteDb.prepare('DELETE FROM tokens WHERE token = ?').run(h.slice(7));
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));
// #endregion

// #region Routes — Instagram

app.post('/api/instagram/connect', requireAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ message: 'Usuário e senha do Instagram são obrigatórios.' });

  try {
    addLog(`Conectando Instagram @${username} — monitor + reply`, 'info');

    // Persiste o ig_username IMEDIATAMENTE para que getUserDir já use o label certo
    // mesmo antes de concluir o 2FA
    sqliteDb
      .prepare('UPDATE users SET ig_username = ? WHERE id = ?')
      .run(username, req.userId);

    const result = await connectInstagramForUser(req.userId, username, password);

    if (!result.requires2FA) {
      markIgLinked(req.userId, username);
      addLog(`Instagram @${username} vinculado (ambos os perfis)`, 'ok');
      _onIgLinked(req.userId);
    } else {
      addLog(`Instagram @${username}: aguardando 2FA`, 'info');
    }

    res.json(result);
  } catch (e) {
    addLog(`Erro ao conectar Instagram: ${e.message}`, 'error');
    const status = e.code === 'WRONG_CREDENTIALS' ? 401 : 400;
    res.status(status).json({ message: e.message });
  }
});
app.post('/api/instagram/verify2fa', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code || !/^\d{6}$/.test(code))
    return res.status(422).json({ message: 'Código de 6 dígitos inválido.' });

  try {
    const result = await verify2FAUser(req.userId, code);

    if (!result.ok && result.requires2FA) {
      return res.json({ requires2FA: true, pendingProfile: result.pendingProfile });
    }

    // ig_username já foi salvo no /connect — usa direto do banco
    const row      = sqliteDb.prepare('SELECT ig_username FROM users WHERE id = ?').get(req.userId);
    const username = row?.ig_username;

    if (!username) {
      // Segurança: não deveria chegar aqui, mas loga se acontecer
      addLog(`2FA: ig_username ausente para userId ${req.userId}`, 'error');
      return res.status(500).json({ message: 'Username do Instagram não encontrado.' });
    }

    markIgLinked(req.userId, username);
    addLog(`2FA verificado — monitor + reply vinculados (@${username})`, 'ok');
    _onIgLinked(req.userId);
    res.json({ ok: true });

  } catch (e) {
    addLog(`Erro 2FA: ${e.message}`, 'error');
    res.status(422).json({ message: e.message });
  }
});

app.post('/api/instagram/resend2fa', requireAuth, async (req, res) => {
  const sent = await resend2FA(req.userId, 'monitor');
  if (!sent)
    return res.status(400).json({ message: 'Não foi possível reenviar o código automaticamente.' });
  res.json({ ok: true });
});

// #endregion

// #region Routes — Comments / Bot
app.get('/api/state', requireAuth, (req, res) => {
  const cfg = loadUserCfg(req.userId);
  syncAllStats();
  state.stats.scanInterval = cfg.scanInterval;
  res.json({
    stats      : state.stats,
    logs       : state.logs.slice(0, 50),
    hourlyReplies: state.hourlyReplies,
    botRunning : state.botRunning,
    autoReply  : cfg.autoReply,
    recent     : getRecentComments(10),
  });
});

app.get('/api/comments', requireAuth, (req, res) => {
  try {
    res.json(listComments({
      page:   parseInt(req.query.page)  || 1,
      limit:  parseInt(req.query.limit) || 15,
      filter: req.query.filter || 'all',
      q:      (req.query.q || '').toLowerCase(),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comments/:id/reply', requireAuth, async (req, res) => {
  const key = req.params.id;
  const reply = (req.body.reply || '').trim();

  if (!reply) {
    return res.status(400).json({ error: 'Texto de resposta obrigatório.' });
  }

  try {
    await replyToComment(key, reply, {
      commentsPath: getCommentsPath(req.userId),
      sessionPath: getSessionPath(req.userId, 'reply'),
      userDataDir: getUserDataDir(req.userId, 'reply'),
    });

    const data = loadComments(req.userId);

    if (data[key]) {
      data[key].replied = true;
      data[key].replyText = reply;
      data[key].repliedAt = new Date().toISOString();
      saveComments(req.userId, data);
    }

    syncAllStats();

    addLog(`[${req.user.email}] Respondido manualmente via painel`, 'ok');

    res.json({ ok: true });
  } catch (e) {
    addLog('Erro ao responder: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai-reply', requireAuth, async (req, res) => {
  const { commentId, username = 'usuário', text, systemPrompt = null } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Texto do comentário obrigatório.' });
  try {
    addLog('Gerando resposta IA para comentário ' + (commentId || '?'), 'info');
    const cfg        = loadUserCfg(req.userId);
    const finalPrompt = buildPrompt(systemPrompt ?? cfg.systemPrompt ?? null, username, text);
    const reply = await Promise.race([
      askGemini(finalPrompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout de 90s')), 90000)),
    ]);
    if (!reply) throw new Error('Resposta vazia da IA');
    addLog('IA gerou resposta para ' + username, 'ok');
    res.json({ reply });
  } catch (e) {
    addLog('Erro IA: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/start', requireAuth, async (req, res) => {
  try {
    await startUserBot(req.userId);
    syncAllStats();

    res.json({
      ok: true,
      botRunning: userWatchers.has(req.userId)
    });
  } catch (e) {
    addLog('Erro ao iniciar bot manualmente: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  stopUserBot(req.userId)
    .then(() => res.json({ ok: true }))
    .catch(e => res.status(500).json({ error: e.message }));
});

app.post('/api/scan', requireAuth, async (req, res) => {
  let browser;
  try {
    const watcher = userWatchers.get(req.userId);

    if (watcher) {
      // Bot ativo: usa o watcher (que já gerencia o mutex internamente)
      // Evita abrir segundo Chrome no mesmo userDataDir
      addLog('Varredura manual delegada ao watcher ativo.', 'info');
      const result = await watcher.scanNow();
      state.stats.lastScan = new Date().toISOString();
      syncAllStats();
      return res.json({ ok: true, found: result?.newCount ?? 0 });
    }

    // Bot inativo: abre sessão temporária normalmente
    const session = await openUserSession(req.userId, 'monitor');
    browser = session.browser;

    const result = await fetchComments({
      browser     : session.browser,
      page        : session.page,
      scrolls     : 5,
      commentsPath: getCommentsPath(req.userId),
    });

    await browser.close();
    browser = null;

    state.stats.lastScan = new Date().toISOString();
    syncAllStats();

    addLog('Varredura manual: ' + (result?.scraped?.length ?? 0) + ' encontrado(s)', 'info');
    res.json({ ok: true, found: result?.scraped?.length ?? 0 });

  } catch (e) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    addLog('Erro na varredura manual: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/bot/mode', requireAuth, async (req, res) => {
  try {
    const cfg = patchUserCfg(req.userId, { autoReply: !!req.body.autoReply });

    if (cfg.autoReply) {
      await startUserBot(req.userId);
      addLog('Modo automático ativado e bot iniciado.', 'ok');
    } else {
      await stopUserBot(req.userId);
      addLog('Modo automático desativado e bot parado.', 'warn');
    }

    syncAllStats();
    res.json({ ok: true, autoReply: cfg.autoReply, botRunning: userWatchers.has(req.userId) });
  } catch (e) {
    addLog('Erro ao alterar modo automático: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/config', requireAuth, (req, res) => {
  const cfg = loadUserCfg(req.userId);
  res.json(cfg);
});


app.post('/api/config', requireAuth, (req, res) => {
  const { systemPrompt, ...rest } = req.body || {};
  const patch = { ...rest };
  if (typeof systemPrompt === 'string') patch.systemPrompt = systemPrompt;
  const cfg = patchUserCfg(req.userId, patch);
  addLog(`[${req.user.email}] Configurações atualizadas`, 'ok');
  res.json({ ok: true, cfg });
});


app.delete('/api/logs/clear', requireAuth, (req, res) => { state.logs = []; res.json({ ok: true }); });

app.delete('/api/data/clear', requireAuth, (req, res) => {
  const uid = getActiveUserId();
  if (uid) saveComments(uid, {});
  state.stats = { total: 0, replied: 0, pending: 0, lastScan: null, scanInterval: cfg.scanInterval };
  state.hourlyReplies = new Array(24).fill(0);
  addLog('Dados limpos pelo painel', 'warn');
  res.json({ ok: true });
});
// #endregion

// #region Routes — Image Proxy
app.get('/api/proxy/image', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('url obrigatória');
  const allowed = /^https:\/\/([a-z0-9-]+\.)?(cdninstagram\.com|fbcdn\.net|instagram\.f[a-z]{2,6}[0-9]+-[0-9]+\.fna\.fbcdn\.net)(\/|$)/i;
  if (!allowed.test(url)) return res.status(403).send('domínio não permitido');
  const parsed = new URL(url);
  const req2 = https.request({
    hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/', 'Origin': 'https://www.instagram.com', 'Accept': 'image/*' },
  }, imgRes => {
    res.writeHead(imgRes.statusCode === 200 ? 200 : 502, {
      'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      ...(imgRes.headers['content-length'] ? { 'Content-Length': imgRes.headers['content-length'] } : {}),
    });
    imgRes.pipe(res);
  });
  req2.on('error', e => { if (!res.headersSent) res.status(502).send('Erro: ' + e.message); });
  req2.end();
});
// #endregion

// #region Routes — Templates

app.get('/api/templates', requireAuth, (req, res) => {
  try {
    const rows = listTemplates(req.userId);
    // Normaliza active para boolean para o front
    res.json(rows.map(t => ({ ...t, active: !!t.active })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/templates', requireAuth, (req, res) => {
  const { name, trigger, response, active, icon } = req.body || {};
  if (!name?.trim() || !trigger?.trim() || !response?.trim())
    return res.status(400).json({ message: 'name, trigger e response são obrigatórios.' });
  try {
    const tpl = createTemplate(req.userId, { name, trigger, response, active, icon });
    addLog(`[${req.user.email}] Template criado: "${name}"`, 'ok');
    res.status(201).json({ ...tpl, active: !!tpl.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/templates/:id', requireAuth, (req, res) => {
  const { name, trigger, response, active, icon } = req.body || {};
  try {
    const updated = updateTemplate(req.userId, req.params.id, { name, trigger, response, active, icon });
    if (!updated) return res.status(404).json({ message: 'Template não encontrado.' });
    addLog(`[${req.user.email}] Template atualizado: "${updated.name}"`, 'ok');
    res.json({ ...updated, active: !!updated.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  try {
    const ok = deleteTemplate(req.userId, req.params.id);
    if (!ok) return res.status(404).json({ message: 'Template não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/templates/:id/toggle', requireAuth, (req, res) => {
  try {
    const current = sqliteDb
      .prepare('SELECT active FROM templates WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!current) return res.status(404).json({ message: 'Template não encontrado.' });

    const updated = updateTemplate(req.userId, req.params.id, { active: !current.active });
    res.json({ ...updated, active: !!updated.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// #endregion

// #region Init

syncAllStats();

app.listen(PORT, async () => {
  addLog('Servidor iniciado na porta ' + PORT, 'ok');
  await restoreActiveBots();
});

async function restoreActiveBots() {
  const linked = sqliteDb
    .prepare('SELECT id FROM users WHERE ig_linked = 1')
    .all();

  if (!linked.length) return;

  addLog(`Verificando ${linked.length} usuário(s) com Instagram vinculado...`, 'info');

  for (const { id } of linked) {
    const cfg = loadUserCfg(id);

    if (!cfg.autoReply) {
      // autoReply desligado — não sobe o bot
      continue;
    }

    const sessionPath = getSessionPath(id, 'monitor');
    if (!fs.existsSync(sessionPath)) {
      const row   = sqliteDb.prepare('SELECT ig_username, name FROM users WHERE id = ?').get(id);
      const label = row?.ig_username || row?.name || id;
      addLog(`[${label}] autoReply ativo mas sessão monitor ausente — bot não restaurado.`, 'warn');
      continue;
    }

    try {
      await startUserBot(id);
    } catch (e) {
      const row   = sqliteDb.prepare('SELECT ig_username, name FROM users WHERE id = ?').get(id);
      const label = row?.ig_username || row?.name || id;
      addLog(`[${label}] Falha ao restaurar bot: ${e.message}`, 'error');
    }
  }
}

//#endregion