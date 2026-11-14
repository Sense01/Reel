#!/usr/bin/env node
'use strict';

// REEL BFF Server (zero dependências):
// - OAuth2 Authorization Code Flow com refresh_token persistente (sem expiração de 1h)
// - Proxy Drive API + Streaming com Range RFC 9110, AbortController e retry/backoff
// - Transmux/Transcode sob demanda via ffmpeg (opcional, caso ffmpeg esteja no PATH)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8'
};

function inferMime(name, upstreamType) {
  if (upstreamType && upstreamType !== 'application/octet-stream') return upstreamType;
  const ext = (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || upstreamType || 'video/mp4';
}

function parseRange(hdr, size) {
  if (!hdr) return null;
  const m = String(hdr).trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { raw: true, header: hdr };
  const s1 = m[1], s2 = m[2];
  if (!s1 && !s2) return { invalid: true };
  if (!s1 && s2) {
    const suf = Number(s2);
    if (!Number.isFinite(suf) || suf <= 0) return { invalid: true };
    if (size > 0) {
      const start = Math.max(0, size - suf);
      const end = size - 1;
      return { start, end, header: `bytes=${start}-${end}` };
    }
    return { raw: true, header: `bytes=-${suf}` };
  }
  const start = Number(s1);
  if (!Number.isFinite(start) || start < 0 || (size > 0 && start >= size)) return { invalid: true };
  const end = s2 !== '' ? (size > 0 ? Math.min(Number(s2), size - 1) : Number(s2)) : (size > 0 ? size - 1 : '');
  if (end !== '' && (!Number.isFinite(end) || end < start)) return { invalid: true };
  return { start, end, header: `bytes=${start}-${end}` };
}

function sleepAbortable(ms, signal) {
  return new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      res();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(fetchFn, url, init = {}, maxRetries = 4) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchFn(url, init);
    if (r.ok || r.status === 401 || r.status === 404 || r.status === 416) return r;

    let bodyTxt = null;
    let retryable = r.status === 429 || r.status >= 500;
    if (r.status === 403) {
      try {
        bodyTxt = await r.text();
        const reason = JSON.parse(bodyTxt)?.error?.errors?.[0]?.reason || '';
        retryable = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      } catch (_) {}
      if (!retryable) {
        return new Response(bodyTxt || '', {
          status: r.status,
          headers: { 'content-type': r.headers.get('content-type') || 'application/json' }
        });
      }
    } else if (retryable && attempt < maxRetries) {
      try { await r.body?.cancel(); } catch (_) {}
    }

    if (!retryable || attempt >= maxRetries) return r;
    const ra = Number(r.headers.get('Retry-After'));
    const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
    await sleepAbortable(Math.min(base + Math.random() * 400, 15000), init.signal);
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function readJsonBody(req, limit = 65536) {
  return new Promise((res, rej) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limit) {
        req.destroy();
        return rej(new Error('Body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        res(raw ? JSON.parse(raw) : {});
      } catch (e) {
        rej(new Error('JSON inválido'));
      }
    });
    req.on('error', rej);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function detectFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function createReelServer(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const fetchFn = options.fetch || globalThis.fetch;
  const configPath = options.configPath || path.join(rootDir, '.reel-config.json');
  const sessionsPath = options.sessionsPath || path.join(rootDir, '.reel-sessions.json');
  const driveBase = options.driveBase || 'https://www.googleapis.com/drive/v3';
  const oauthTokenUrl = options.oauthTokenUrl || 'https://oauth2.googleapis.com/token';
  const hasFfmpeg = options.hasFfmpeg ?? detectFfmpeg();
  const internalToken = crypto.randomBytes(24).toString('hex');

  function loadJsonFile(file, fallback) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {}
    return fallback;
  }
  function saveJsonFile(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }

  let fileCfg = loadJsonFile(configPath, {});
  if (!fileCfg.hmacSecret && !process.env.SESSION_SECRET) {
    fileCfg.hmacSecret = crypto.randomBytes(32).toString('hex');
  }
  const hmacSecret = process.env.SESSION_SECRET || fileCfg.hmacSecret;
  const sessions = new Map(Object.entries(loadJsonFile(sessionsPath, {})));
  const refreshLocks = new Map();

  function signStreamToken(sid, fileId, ttlMs = 3600000) {
    const expAt = Date.now() + ttlMs;
    const payload = `${sid}.${fileId}.${expAt}`;
    const sig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
    return `${expAt}.${sig}`;
  }

  function verifyStreamToken(token, fileId) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [expStr, sig] = parts;
    const expAt = Number(expStr);
    if (!Number.isFinite(expAt) || Date.now() > expAt) return null;
    for (const sid of sessions.keys()) {
      const payload = `${sid}.${fileId}.${expStr}`;
      const expected = crypto.createHmac('sha256', hmacSecret).update(payload).digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return sid;
    }
    return null;
  }

  function persistSessions() {
    saveJsonFile(sessionsPath, Object.fromEntries(sessions));
  }

  function getConfig() {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID || fileCfg.clientId || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || fileCfg.clientSecret || '',
      tmdbKey: process.env.TMDB_KEY || fileCfg.tmdbKey || ''
    };
  }

  async function refreshSessionToken(sid) {
    if (refreshLocks.has(sid)) return refreshLocks.get(sid);
    const p = (async () => {
      const sess = sessions.get(sid);
      if (!sess || !sess.refreshToken) throw Object.assign(new Error('Sessão sem refresh_token'), { status: 401 });
      const cfg = getConfig();
      if (!cfg.clientId || !cfg.clientSecret) {
        throw Object.assign(new Error('Credenciais OAuth BFF em falta'), { status: 500 });
      }
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: sess.refreshToken,
        grant_type: 'refresh_token'
      });
      const r = await fetchFn(oauthTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        if (r.status === 400 || r.status === 401) {
          sessions.delete(sid);
          persistSessions();
        }
        throw Object.assign(new Error(data.error_description || data.error || 'Falha ao renovar token'), { status: 401 });
      }
      sess.accessToken = data.access_token;
      sess.exp = Date.now() + (Number(data.expires_in || 3600) - 120) * 1000;
      if (data.refresh_token) sess.refreshToken = data.refresh_token;
      persistSessions();
      return sess.accessToken;
    })().finally(() => refreshLocks.delete(sid));

    refreshLocks.set(sid, p);
    return p;
  }

  async function ensureAccessToken(sid, force = false) {
    const sess = sessions.get(sid);
    if (!sess) throw Object.assign(new Error('Não autenticado'), { status: 401 });
    if (!force && sess.accessToken && Date.now() < (sess.exp || 0)) return sess.accessToken;
    return refreshSessionToken(sid);
  }

  function getSid(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies.reel_sid || '';
  }

  async function driveFetchWithAuth(sid, url, init = {}) {
    let force = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await ensureAccessToken(sid, force);
      const headers = { ...(init.headers || {}), Authorization: 'Bearer ' + tok };
      const r = await fetchWithRetry(fetchFn, url, { ...init, headers });
      if (r.status === 401 && attempt === 0) {
        try { await r.body?.cancel(); } catch (_) {}
        force = true;
        continue;
      }
      return r;
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = u.pathname;
    const secHeaders = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    };

    try {
      // Static allowlisted assets
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8')
          .replace('</head>', '<meta name="reel-bff" content="1">\n</head>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders });
        return res.end(html);
      }
      if (req.method === 'GET' && pathname === '/sw.js') {
        const sw = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache', ...secHeaders });
        return res.end(sw);
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, hasFfmpeg });
      }

      if (req.method === 'GET' && pathname === '/api/auth/status') {
        const cfg = getConfig();
        const sid = getSid(req);
        const sess = sid ? sessions.get(sid) : null;
        return sendJson(res, 200, {
          bff: true,
          clientId: cfg.clientId,
          configured: !!(cfg.clientId && cfg.clientSecret),
          authenticated: !!sess,
          hasRefreshToken: !!(sess && sess.refreshToken),
          exp: sess ? sess.exp : 0,
          hasFfmpeg,
          hasTmdb: !!cfg.tmdbKey
        });
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        if (body.clientId !== undefined) fileCfg.clientId = String(body.clientId).trim();
        if (body.clientSecret !== undefined && String(body.clientSecret).trim()) {
          fileCfg.clientSecret = String(body.clientSecret).trim();
        }
        if (body.tmdbKey !== undefined) fileCfg.tmdbKey = String(body.tmdbKey).trim();
        saveJsonFile(configPath, fileCfg);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/api/auth/exchange') {
        const body = await readJsonBody(req);
        const code = String(body.code || '').trim();
        if (!code) return sendJson(res, 400, { error: 'Código OAuth em falta' });
        const cfg = getConfig();
        if (!cfg.clientId || !cfg.clientSecret) {
          return sendJson(res, 400, { error: 'Configura Client ID e Client Secret no servidor BFF' });
        }
        const params = new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: body.redirectUri || 'postmessage',
          grant_type: 'authorization_code'
        });
        const r = await fetchFn(oauthTokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.access_token) {
          return sendJson(res, 400, { error: data.error_description || data.error || 'Erro ao trocar código OAuth' });
        }
        const sid = crypto.randomBytes(32).toString('hex');
        const oldSid = getSid(req);
        const existingRefresh = oldSid && sessions.get(oldSid)?.refreshToken;
        if (oldSid) sessions.delete(oldSid);
        const exp = Date.now() + (Number(data.expires_in || 3600) - 120) * 1000;
        sessions.set(sid, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || existingRefresh || '',
          exp
        });
        persistSessions();
        const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
        const cookie = `reel_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
        return sendJson(res, 200, { ok: true, exp, hasRefreshToken: !!(data.refresh_token || existingRefresh) }, { 'set-cookie': cookie });
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const sid = getSid(req);
        if (sid) {
          sessions.delete(sid);
          persistSessions();
        }
        return sendJson(res, 200, { ok: true }, { 'set-cookie': 'reel_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }

      // Drive metadata proxy
      if (req.method === 'GET' && pathname.startsWith('/api/drive/')) {
        const sid = getSid(req);
        const sub = pathname.slice('/api/drive/'.length);
        if (!/^files(\/[\w-]+)?$/.test(sub)) return sendJson(res, 400, { error: 'Endpoint Drive inválido' });
        const target = new URL(`${driveBase}/${sub}`);
        for (const k of ['q', 'fields', 'pageSize', 'orderBy', 'pageToken', 'supportsAllDrives', 'includeItemsFromAllDrives']) {
          if (u.searchParams.has(k)) target.searchParams.set(k, u.searchParams.get(k));
        }
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        const r = await driveFetchWithAuth(sid, target.toString(), { signal: ac.signal });
        const txt = await r.text();
        res.writeHead(r.status, {
          'content-type': r.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store'
        });
        return res.end(txt);
      }

      // Signed single-file stream link for external players (VLC / IINA / Infuse / M3U)
      const linkMatch = pathname.match(/^\/api\/stream-link\/([\w-]+)$/);
      if (req.method === 'POST' && linkMatch) {
        const sid = getSid(req);
        await ensureAccessToken(sid);
        const fileId = linkMatch[1];
        const st = signStreamToken(sid, fileId);
        const host = req.headers.host || '127.0.0.1';
        const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const link = `${proto}://${host}/api/stream/${fileId}?st=${encodeURIComponent(st)}`;
        return sendJson(res, 200, { url: link });
      }

      // Stream proxy with RFC 9110 Range + AbortController + token refresh
      const streamMatch = pathname.match(/^\/api\/stream\/([\w-]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && streamMatch) {
        const fileId = streamMatch[1];
        const isInternal = req.headers['x-reel-internal'] === internalToken;
        const st = u.searchParams.get('st');
        const sid = isInternal
          ? String(req.headers['x-reel-sid'] || '')
          : (st ? (verifyStreamToken(st, fileId) || '') : getSid(req));
        const size = Math.max(0, Number(u.searchParams.get('s')) || 0);
        const isHead = req.method === 'HEAD';
        const range = parseRange(req.headers.range, size);

        if (range && range.invalid) {
          res.writeHead(416, { 'content-range': size > 0 ? `bytes */${size}` : 'bytes */*' });
          return res.end();
        }

        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });

        const upstreamUrl = `${driveBase}/files/${fileId}?alt=media&supportsAllDrives=true`;
        const upstreamRange = isHead && !range ? 'bytes=0-0' : (range ? range.header : '');
        const r = await driveFetchWithAuth(sid, upstreamUrl, {
          headers: upstreamRange ? { Range: upstreamRange } : {},
          signal: ac.signal
        });

        if (!r.ok) {
          const outH = {
            'content-type': r.headers.get('content-type') || 'application/json',
            'cache-control': 'no-store'
          };
          if (r.headers.has('content-range')) outH['content-range'] = r.headers.get('content-range');
          res.writeHead(r.status, outH);
          return res.end(await r.text().catch(() => ''));
        }

        const outHeaders = {
          'content-type': inferMime(u.searchParams.get('n'), r.headers.get('content-type')),
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          ...secHeaders
        };

        if (isHead) {
          try { await r.body?.cancel(); } catch (_) {}
          const cr = r.headers.get('content-range') || '';
          const total = (cr.match(/\/(\d+)$/) || [])[1] || (size ? String(size) : '');
          if (range) {
            if (cr) outHeaders['content-range'] = cr;
            if (r.headers.has('content-length')) outHeaders['content-length'] = r.headers.get('content-length');
            res.writeHead(r.status, outHeaders);
          } else {
            if (total) outHeaders['content-length'] = total;
            res.writeHead(200, outHeaders);
          }
          return res.end();
        }

        const cr = r.headers.get('content-range');
        const cl = r.headers.get('content-length');
        if (cr) outHeaders['content-range'] = cr;
        else if (r.status === 206 && range && !range.raw && size > 0) {
          outHeaders['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
        }
        if (cl) outHeaders['content-length'] = cl;

        if (u.searchParams.has('dl')) {
          const fname = (u.searchParams.get('n') || 'video.mp4').replace(/[\r\n"]/g, '_');
          const ascii = fname.replace(/[^\x20-\x7E]/g, '_') || 'video.mp4';
          outHeaders['content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fname)}`;
        }

        res.writeHead(r.status, outHeaders);
        if (!r.body) return res.end();
        const nodeStream = Readable.fromWeb(r.body);
        nodeStream.on('error', () => { if (!res.writableEnded) res.destroy(); });
        res.on('close', () => nodeStream.destroy());
        return nodeStream.pipe(res);
      }

      // Optional ffmpeg live fragmented-MP4 remux/transcode
      const trMatch = pathname.match(/^\/api\/transcode\/([\w-]+)$/);
      if (req.method === 'GET' && trMatch) {
        if (!hasFfmpeg) return sendJson(res, 501, { error: 'ffmpeg não está disponível no servidor' });
        const sid = getSid(req);
        await ensureAccessToken(sid); // verify session before spawning
        const fileId = trMatch[1];
        const t0 = Math.max(0, Number(u.searchParams.get('t')) || 0);
        const vCopy = u.searchParams.get('vcopy') === '1';
        const addr = server.address();
        const localHost = addr.address === '::' ? '[::1]' : (addr.address === '0.0.0.0' ? '127.0.0.1' : (addr.family === 'IPv6' ? `[${addr.address}]` : addr.address));
        const localBase = `http://${localHost}:${addr.port}/api/stream/${fileId}`;

        const args = [
          '-hide_banner', '-loglevel', 'error',
          '-headers', `x-reel-internal: ${internalToken}\r\nx-reel-sid: ${sid}\r\n`,
          '-ss', String(t0),
          '-i', localBase,
          '-map', '0:v:0', '-map', '0:a:0?',
          ...(vCopy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p']),
          '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
          '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1'
        ];

        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'cache-control': 'no-store',
          ...secHeaders
        });
        ff.stdout.pipe(res);
        ff.stderr.on('data', () => {});
        res.on('close', () => {
          if (!ff.killed) ff.kill('SIGKILL');
        });
        ff.on('error', () => { if (!res.writableEnded) res.destroy(); });
        ff.on('close', () => { if (!res.writableEnded) res.end(); });
        return;
      }

      return sendJson(res, 404, { error: 'Não encontrado' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      const status = err.status || 500;
      if (!res.headersSent) return sendJson(res, status, { error: err.message || 'Erro interno' });
      res.destroy();
    }
  });

  server.on('close', () => {});
  return { server, sessions, getConfig, parseRange, inferMime, fetchWithRetry };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 8787);
  const HOST = process.env.HOST || '127.0.0.1';
  const { server } = createReelServer();
  server.listen(PORT, HOST, () => {
    console.log(`REEL BFF a correr em http://${HOST}:${PORT}`);
  });
}

module.exports = { createReelServer, parseRange, inferMime, fetchWithRetry };
