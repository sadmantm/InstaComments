var express = require('express');
var path    = require('path');
var fs      = require('fs');
var https   = require('https');

var {
  watchComments,
  replyToComment,
  fetchComments,
  loadDB,
  getPendingComments,
} = require('./comments');
const { askGemini } = require("./gemini.js");

var app  = express();
var PORT = process.env.PORT || 3000;

var CFG_FILE    = path.join(__dirname, 'config.json');
var PROMPT_FILE = path.join(__dirname, 'prompt.txt');
var CREDS_FILE  = path.join(__dirname, 'credentials.json');
var replyQueue = Promise.resolve();
const {
  sessionsExist,
  launchRemoteLogin,
  waitForLoginAndSave,
  CDP_PORT,
} = require('./instagram.js');

const httpProxy = require('http-proxy');
const cdpProxy  = httpProxy.createProxyServer({ target: 'http://localhost:9222', ws: true });

// Proxy HTTP para /cdp-proxy/*
app.use('/cdp-proxy', function(req, res) {
  req.url = req.url.replace('/cdp-proxy', '') || '/';
  cdpProxy.web(req, res);
});

// Proxy WebSocket para /cdp-proxy/*
server.on('upgrade', function(req, socket, head) {
  if (req.url.startsWith('/cdp-proxy')) {
    req.url = req.url.replace('/cdp-proxy', '');
    cdpProxy.ws(req, socket, head);
  }
});


function enqueueReply(fn) {
  replyQueue = replyQueue.then(fn).catch(() => {});
  return replyQueue;
}

var state = {
  logs: [],
  stats: { total: 0, replied: 0, pending: 0, lastScan: null, scanInterval: 3 },
  botRunning: false,
  hourlyReplies: new Array(24).fill(0),
};

var cfg = {
  scanInterval: 3,
  delay: 5,
  maxPerCycle: 10,
  maxChars: 200,
  readonly: false,
  replyOld: true,
  autoReply: false,
};

var botWatcher = null;

function saveCfg() {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch(e) {}
}
function loadCfg() {
  try {
    if (fs.existsSync(CFG_FILE)) cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')));
  } catch(e) {}
}

function addLog(msg, type) {
  state.logs.unshift({
    time: new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }),
    msg: msg,
    type: type || 'info'
  });
  if (state.logs.length > 200) state.logs.pop();
}

function syncStats() {
  try {
    var db      = loadDB();
    var keys    = Object.keys(db).filter(function(k) { return !k.startsWith('__'); });
    var replied = keys.filter(function(k) { return db[k].replied; });
    var pending = keys.filter(function(k) { return !db[k].replied; });

    state.stats.total   = keys.length;
    state.stats.replied = replied.length;
    state.stats.pending = pending.length;

    var now      = Date.now();
    var oneDayMs = 24 * 60 * 60 * 1000;
    var hourly   = new Array(24).fill(0);

    keys.forEach(function(k) {
      var seenAt = db[k].seenAt;
      if (!seenAt) return;
      var ts = new Date(seenAt).getTime();
      if (now - ts <= oneDayMs) {
        var h = new Date(ts).getHours();
        hourly[h]++;
      }
    });

    state.hourlyReplies = hourly;
  } catch(e) {
    addLog('Erro em syncStats: ' + e.message, 'error');
  }
}

function loadSystemPrompt() {
  try {
    if (fs.existsSync(PROMPT_FILE)) {
      var content = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
      if (content) return content;
    }
  } catch(_) {}
  console.warn('Prompt personalizado não encontrado ou vazio. Usando padrão.');
}

function buildPrompt(systemPrompt, username, text) {
  var base = systemPrompt || loadSystemPrompt();
  var comentario = '@' + username + ': ' + text;

  if (base.includes('{{COMENTARIO_DO_USUARIO}}')) {
    return base.replace(/\{\{COMENTARIO_DO_USUARIO\}\}/g, comentario);
  }

  return base + '\n\nComentário de @' + username + ': "' + text + '"\n\nResponda apenas com o texto da resposta, sem explicações.';
}

async function autoReplyFn(comment) {
  try {
    const fullPrompt = buildPrompt(null, comment.username, comment.text);
    const aiReply = await askGemini(fullPrompt);

    if (!aiReply) throw new Error('Resposta vazia da IA');

    console.log(`\n[ai-reply] ✅ Para: @${comment.username}`);
    console.log(`[ai-reply] 💬 Resposta: ${aiReply.slice(0, 120)}${aiReply.length > 120 ? '…' : ''}\n`);

    addLog(`✅ IA gerou resposta para @${comment.username}: "${aiReply.slice(0, 60)}…"`, 'ok');

    // Retorna o texto — quem posta no Instagram é o watchComments
    return aiReply;
  } catch (e) {
    console.error(`[ai-reply] ❌ ERRO para @${comment.username}:`, e);
    addLog(`❌ Erro ao gerar resposta IA para @${comment.username}: ${e.message}`, 'error');
    return null;
  }
}

/* ── Endpoints ───────────────────────────────────────────────────────────── */
app.post('/api/ai-reply', express.json(), async function(req, res) {
  var body         = req.body || {};
  var commentId    = body.commentId;
  var username     = body.username || 'usuário';
  var text         = body.text;
  var systemPrompt = body.systemPrompt || null;

  if (!text) return res.status(400).json({ error: 'Texto do comentário obrigatório.' });

  const fullPrompt = buildPrompt(systemPrompt, username, text);

  try {
    addLog('Gerando resposta IA para comentário ' + (commentId || '?'), 'info');
    const reply = await Promise.race([
      askGemini(fullPrompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: Gemini demorou mais de 90s')), 90000)),
    ]);

    console.log(`\n[ai-reply] ✅ Para: @${username} (comentário ${commentId || '?'})`);
    console.log(`[ai-reply] 💬 Resposta: ${(reply || '').slice(0, 120)}${(reply||'').length > 120 ? '…' : ''}\n`);
    if (!reply) throw new Error('Resposta vazia da IA');

    addLog('IA gerou resposta para ' + (username || commentId), 'ok');
    res.json({ reply });
  } catch (e) {
    console.error('[ai-reply] ERRO:', e);
    addLog('Erro ao gerar resposta IA: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

async function startBot() {
  if (botWatcher) return;

  try {
    botWatcher = await watchComments({
      intervalMs:   cfg.scanInterval * 60 * 1000,
      scrolls:      5,
      autoReply:    cfg.autoReply,
      replyFn:      autoReplyFn,
      replyDelayMs: cfg.delay * 1000,
    });

    botWatcher.on('tick', function(info) {
      state.stats.lastScan = info.at;
      state.botRunning     = true;
      syncStats();
      addLog('Varredura: ' + info.newCount + ' novo(s), ' + info.pendingCount + ' pendente(s)', 'info');
      broadcast('tick', {
        stats:         state.stats,
        hourlyReplies: state.hourlyReplies,
        newCount:      info.newCount,
      });
    });

    botWatcher.on('new', function(comments) {
      comments.forEach(function(c) {
        addLog('Novo comentário de @' + c.username, 'info');
      });
      broadcast('new_comments', {
        count:    comments.length,
        previews: comments.map(function(c) {
          return { id: c.id, user: c.username, text: (c.text || '').slice(0, 80) };
        }),
        stats: state.stats,
      });
    });

    botWatcher.on('error', function(err) {
      addLog('Erro no watcher: ' + err.message, 'error');
    });

    state.botRunning = true;
    addLog('Bot iniciado (' + (cfg.autoReply ? 'automático' : 'manual') + ')', 'ok');
  } catch(e) {
    addLog('Falha ao iniciar bot: ' + e.message, 'error');
  }
}

async function stopBot() {
  if (!botWatcher) return;
  try { await botWatcher.stop(); } catch(e) {}
  botWatcher       = null;
  state.botRunning = false;
  addLog('Bot parado', 'warn');
}

var sseClients = [];

function broadcast(eventName, payload) {
  var data = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  sseClients = sseClients.filter(function(res) {
    try { res.write(data); return true; }
    catch(e) { return false; }
  });
}

app.get('/api/events', function(req, res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  var hb = setInterval(function() {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  sseClients.push(res);

  req.on('close', function() {
    clearInterval(hb);
    sseClients = sseClients.filter(function(c) { return c !== res; });
  });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', function(req, res) {
  syncStats();
  state.stats.scanInterval = cfg.scanInterval;
  res.json({
    stats:         state.stats,
    logs:          state.logs.slice(0, 50),
    hourlyReplies: state.hourlyReplies,
    botRunning:    state.botRunning,
    autoReply:     cfg.autoReply,
    recent:        getRecentComments(10),
  });
});

app.get('/api/comments', function(req, res) {
  var page   = parseInt(req.query.page)  || 1;
  var limit  = parseInt(req.query.limit) || 15;
  var filter = req.query.filter || 'all';
  var q      = (req.query.q || '').toLowerCase();

  try {
    var db  = loadDB();
    var all = Object.entries(db)
      .filter(function(e) { return !e[0].startsWith('__'); })
      .map(function(e) {
        return {
          id:            e[0],
          user:          e[1].username,
          text:          e[1].text,
          postUrl:       e[1].postUrl,
          postShortcode: e[1].postShortcode,
          timestamp:     e[1].seenAt,
          replied:       e[1].replied,
          reply:         e[1].replyText,
          repliedAt:     e[1].repliedAt,
          profilePic:    e[1].profilePic || '',
          whitelist:     (db['__whitelist__'] || []).includes(e[1].username),
        };
      })
      .sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

    if (filter === 'pending') all = all.filter(function(c) { return !c.replied; });
    if (filter === 'replied') all = all.filter(function(c) { return  c.replied; });

    if (q) {
      all = all.filter(function(c) {
        return c.user.toLowerCase().indexOf(q) !== -1 || c.text.toLowerCase().indexOf(q) !== -1;
      });
    }

    var total = all.length;
    var items = all.slice((page - 1) * limit, page * limit);
    res.json({ items: items, total: total, page: page, pages: Math.ceil(total / limit) || 1 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comments/:id/reply', function(req, res) {
  var key   = req.params.id;
  var reply = (req.body.reply || '').trim();
  if (!reply) return res.status(400).json({ error: 'Texto de resposta obrigatório.' });

  var activeSession = botWatcher ? botWatcher.getSession() : null;

  replyToComment(key, reply, { _session: activeSession })
    .then(function() {
      state.stats.replied++;
      if (state.stats.pending > 0) state.stats.pending--;
      state.hourlyReplies[new Date().getHours()]++;
      addLog('Respondido manualmente via painel', 'ok');
      res.json({ ok: true });
    })
    .catch(function(e) {
      addLog('Erro ao responder: ' + e.message, 'error');
      res.status(500).json({ error: e.message });
    });
});

app.post('/api/bot/stop', function(req, res) {
  stopBot()
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/scan', function(req, res) {
  fetchComments({ scrolls: 5 })
    .then(function(result) {
      state.stats.lastScan = new Date().toISOString();
      syncStats();
      addLog('Varredura manual: ' + (result ? result.scraped.length : 0) + ' encontrado(s)', 'info');
      res.json({ ok: true });
    })
    .catch(function(e) {
      addLog('Erro na varredura manual: ' + e.message, 'error');
      res.status(500).json({ error: e.message });
    });
});

app.post('/api/bot/mode', function(req, res) {
  cfg.autoReply = !!req.body.autoReply;
  saveCfg();
  addLog('Modo alterado para: ' + (cfg.autoReply ? 'automático' : 'manual'), 'ok');
  if (botWatcher) stopBot().then(startBot);
  res.json({ ok: true, autoReply: cfg.autoReply });
});

app.get('/api/config', function(req, res) {
  var prompt = '';
  try {
    if (fs.existsSync(PROMPT_FILE)) prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
  } catch(_) {}
  res.json(Object.assign({}, cfg, { systemPrompt: prompt }));
});

app.post('/api/config', function(req, res) {
  var body = req.body || {};

  if (typeof body.systemPrompt === 'string') {
    try { fs.writeFileSync(PROMPT_FILE, body.systemPrompt, 'utf8'); } catch(e) {}
    delete body.systemPrompt;
  }

  cfg = Object.assign(cfg, body);
  saveCfg();
  addLog('Configurações atualizadas', 'ok');
  res.json({ ok: true });
});

app.delete('/api/logs/clear', function(req, res) {
  state.logs = [];
  res.json({ ok: true });
});

app.delete('/api/data/clear', function(req, res) {
  var { saveDB } = require('./comments');
  saveDB({});
  state.stats = { total: 0, replied: 0, pending: 0, lastScan: null, scanInterval: cfg.scanInterval };
  state.hourlyReplies = new Array(24).fill(0);
  addLog('Dados limpos pelo painel', 'warn');
  res.json({ ok: true });
});

app.get('/api/proxy/image', function(req, res) {
  var url = req.query.url;
  if (!url) return res.status(400).send('url obrigatória');

  var allowed = /^https:\/\/([a-z0-9-]+\.)?(cdninstagram\.com|fbcdn\.net|instagram\.f[a-z]{2,6}[0-9]+-[0-9]+\.fna\.fbcdn\.net)(\/|$)/i;
  if (!allowed.test(url)) return res.status(403).send('domínio não permitido');

  var parsed = new URL(url);
  var options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.instagram.com/',
      'Origin': 'https://www.instagram.com',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  };

  var request = https.request(options, function(imgRes) {
    var headers = {
      'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    };
    if (imgRes.headers['content-length']) headers['Content-Length'] = imgRes.headers['content-length'];
    res.writeHead(imgRes.statusCode === 200 ? 200 : 502, headers);
    imgRes.pipe(res);
  });

  request.on('error', function(e) {
    if (!res.headersSent) res.status(502).send('Erro ao buscar imagem: ' + e.message);
  });

  request.end();
});

app.post('/api/login/start', async function (req, res) {
  try {
    await launchRemoteLogin();
    // Agora aponta para o proxy interno — mesma origin, porta 3000
    const cdpBase = '';  // mesma origin do frontend
    addLog('Login remoto iniciado', 'info');
    res.json({ ok: true, cdpBase });
  } catch (e) {
    addLog('Erro ao iniciar login remoto: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/login/save — detecta conclusão do login, salva as duas sessões e inicia o bot
app.post('/api/login/save', async function (req, res) {
  try {
    res.json({ ok: true, message: 'Aguardando conclusão do login…' });

    // Processa em background
    waitForLoginAndSave()
      .then(() => {
        addLog('Sessões salvas (monitor + reply). Iniciando bot…', 'ok');
        broadcast('login_saved', { ok: true });
        startBot();  // inicia o bot automaticamente após login
      })
      .catch(e => {
        addLog('Erro ao salvar sessão: ' + e.message, 'error');
        broadcast('login_saved', { ok: false, error: e.message });
      });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/login/status — verifica se as sessões existem
app.get('/api/login/status', function (req, res) {
  res.json({ loggedIn: sessionsExist() });
});


function getRecentComments(n) {
  try {
    var db = loadDB();
    return Object.entries(db)
      .filter(function(e) { return !e[0].startsWith('__'); })
      .map(function(e) { return Object.assign({ id: e[0], user: e[1].username }, e[1]); })
      .sort(function(a, b) { return new Date(b.seenAt) - new Date(a.seenAt); })
      .slice(0, n);
  } catch(e) { return []; }
}

loadCfg();
syncStats();
if (sessionsExist()) {
  // Sessões já existem — inicia o bot normalmente
  startBot();
} else {
  // Sem sessão — aguarda o usuário fazer login pelo frontend
  addLog('Nenhuma sessão encontrada. Faça login pelo painel.', 'warn');
  console.warn('[server] Sessões não encontradas. Bot não iniciado. Aguardando login via frontend.');
}


const http   = require('http');
const server = http.createServer(app);
server.listen(PORT, function() {
  console.log('Servidor: http://localhost:' + PORT);
  addLog('Servidor iniciado na porta ' + PORT, 'ok');
});