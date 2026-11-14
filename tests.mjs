import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(new URL(import.meta.url).pathname);

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
function extractInlineScripts(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (!/\bsrc\s*=/i.test(tag) && m[1].trim()) scripts.push(m[1]);
  }
  return { html, scripts };
}

function makeDomEnv(html = '') {
  const store = new Map();
  const sess = new Map();
  class El {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this._html = '';
      this.textContent = '';
      this.style = {};
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this._classes = new Set();
      this.attributes = new Map();
      this.value = '';
      this.checked = false;
      this.paused = true;
      this.ended = false;
      this.currentTime = 0;
      this.duration = NaN;
      this.readyState = 0;
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
      this.textTracks = [];
      this.audioTracks = [];
      const self = this;
      this.classList = {
        add: (...a) => a.forEach(x => self._classes.add(x)),
        remove: (...a) => a.forEach(x => self._classes.delete(x)),
        contains: x => self._classes.has(x),
        toggle: (x, f) => {
          const on = f === undefined ? !self._classes.has(x) : !!f;
          if (on) self._classes.add(x); else self._classes.delete(x);
          return on;
        },
      };
    }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, []);
      this.listeners.get(t).push(fn);
    }
    removeEventListener(t, fn) {
      const l = this.listeners.get(t);
      if (l) this.listeners.set(t, l.filter(x => x !== fn));
    }
    dispatchEvent(ev) {
      for (const fn of this.listeners.get(ev.type) || []) fn(ev);
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    appendChild(c) { this.children.push(c); return c; }
    remove() {}
    click() {}
    focus() {}
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() {}
    removeAttribute(k) { this.attributes.delete(k); if (k === 'src') this.src = ''; }
    addTextTrack(kind, label, lang) {
      const cues = [];
      const t = {
        kind, label, language: lang, mode: 'hidden', cues,
        addCue: c => cues.push(c),
        removeCue: c => { const i = cues.indexOf(c); if (i >= 0) cues.splice(i, 1); },
      };
      this.textTracks.push(t);
      return t;
    }
  }

  const byIdMap = new Map();
  // Register every id="..." present in HTML markup cleanly (while leaving dynamic #ifr null)
  for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    if (!byIdMap.has(m[1])) byIdMap.set(m[1], new El('div', m[1]));
  }
  const document = {
    visibilityState: 'visible',
    listeners: new Map(),
    documentElement: new El('html'),
    body: new El('body'),
    head: new El('head'),
    createElement: tag => new El(tag),
    getElementById: id => byIdMap.get(id) || null,
    querySelector: sel => {
      if (sel.startsWith('#') && !/[ >.\[]/.test(sel.slice(1))) return byIdMap.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, []);
      this.listeners.get(t).push(fn);
    },
    removeEventListener() {},
  };
  return { byIdMap, document, store, sess, El };
}

function loadAppContext({ hasBFFMeta = false, fetchMock } = {}) {
  const { html, scripts } = extractInlineScripts(path.join(ROOT, 'index.html'));
  const code = scripts.join('\n;\n');
  const { byIdMap, document, store, sess } = makeDomEnv(html);
  if (hasBFFMeta) {
    const origQS = document.querySelector;
    document.querySelector = sel => {
      if (sel === 'meta[name="reel-bff"]') return { content: '1' };
      return origQS(sel);
    };
  }
  class VTTCueMock {
    constructor(a, b, text) { this.startTime = a; this.endTime = b; this.text = text; }
  }
  class SafeMessageChannel extends MessageChannel {
    constructor() {
      super();
      this.port1.unref?.();
      this.port2.unref?.();
    }
  }
  const safeSetTimeout = (fn, ms, ...a) => {
    const t = setTimeout(fn, ms, ...a);
    t.unref?.();
    return t;
  };
  const safeSetInterval = (fn, ms, ...a) => {
    const t = setInterval(fn, ms, ...a);
    t.unref?.();
    return t;
  };
  const ctx = {
    console, Promise, Math, Date, JSON, RegExp, Array, Map, Set, WeakSet, WeakMap,
    Uint8Array, DataView, ArrayBuffer, Object, Number, String, Boolean, Error, TypeError,
    TextDecoder, TextEncoder, URL, URLSearchParams, Blob, AbortController, AbortSignal,
    Intl, Headers, Response, Request, MessageChannel: SafeMessageChannel,
    setTimeout: safeSetTimeout, clearTimeout, setInterval: safeSetInterval, clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
    document,
    navigator: {
      serviceWorker: {
        controller: null,
        register: () => Promise.resolve({ scope: '/' }),
        addEventListener: () => {},
      },
      clipboard: { writeText: async () => {} },
    },
    location: { protocol: 'http:', href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    sessionStorage: {
      getItem: k => (sess.has(k) ? sess.get(k) : null),
      setItem: (k, v) => sess.set(k, String(v)),
      removeItem: k => sess.delete(k),
    },
    VTTCue: VTTCueMock,
    google: undefined,
    fetch: fetchMock || (async () => new Response(JSON.stringify({}), { status: 404 })),
    scrollTo: () => {},
    scrollY: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    alert: () => {},
    prompt: () => null,
    MediaSource: class MediaSourceMock {
      static isTypeSupported(m) {
        return /avc1|mp4a/.test(m);
      }
      addEventListener() {}
      addSourceBuffer() { return {}; }
    },
    SourceBuffer: class SourceBufferMock {},
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.ctx_google_set = oauth => { ctx.google = oauth; };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'index.html' });
  const api = vm.runInContext(
    `({
      S, V, MKV, TK, HK, BFF,
      clean, se, pickShowName, artKey, isId, safeUrl, esc, auth,
      srtToVtt, assToVtt, parseVttCues, findExtSubs, reconcileProgress, forgetProg,
      persist, askStop, P, setCur: v => { cur = v; }, setPrompt: fn => { prompt = fn; },
      byId, loadF, render, render2, covers, swUrl, direct, mediaUrl, hasBFF,
      setToken: (t, e) => { tok = t; exp = e; },
      setGoogleOAuth: oauth => { ctx_google_set(oauth); },
      setSubs: s => { S.subs = s; },
      setCache: c => { S.cache = c; },
      setLibs: l => { S.libs = l; },
      setProg: p => { S.prog = p; },
    })`,
    ctx
  );
  return { ctx, api, byIdMap, store, drain: () => new Promise(r => setTimeout(r, 5)) };
}

/* In-process synthetic HTTP dispatcher against node http.Server (works cleanly inside sandbox) */
function invokeServer(srv, reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = reqPath;
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = req.socket;

    const res = new EventEmitter();
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headersSent = false;
    res.writableEnded = false;
    res._headers = Object.create(null);
    const chunks = [];

    res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
    res.getHeader = k => res._headers[k.toLowerCase()];
    res.hasHeader = k => k.toLowerCase() in res._headers;
    res.removeHeader = k => { delete res._headers[k.toLowerCase()]; };
    res.getHeaders = () => ({ ...res._headers });
    res.flushHeaders = () => { res.headersSent = true; };
    res.writeHead = (status, msgOrHdrs, maybeHdrs) => {
      res.statusCode = status;
      const hdrs = typeof msgOrHdrs === 'object' ? msgOrHdrs : maybeHdrs;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
      }
      res.headersSent = true;
      return res;
    };
    res.write = chunk => {
      res.headersSent = true;
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };
    res.end = chunk => {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.headersSent = true;
      res.writableEnded = true;
      res.emit('finish');
      res.emit('close');
      const buf = Buffer.concat(chunks);
      resolve({
        status: res.statusCode,
        headers: res._headers,
        buf,
        text: () => buf.toString('utf8'),
        json: () => JSON.parse(buf.toString('utf8')),
      });
    };
    res.destroy = () => {
      res.writableEnded = false;
      res.emit('close');
    };

    try {
      srv.emit('request', req, res);
      if (body !== undefined) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/* ================================================================== */
/* 1. Syntax checks                                                   */
/* ================================================================== */
test('index.html inline scripts compile with zero syntax errors', () => {
  const { scripts } = extractInlineScripts(path.join(ROOT, 'index.html'));
  assert.ok(scripts.length >= 1);
  for (const s of scripts) {
    new vm.Script(s, { filename: 'index.html' });
  }
});

/* ================================================================== */
/* 2. sw.js Service Worker proxy tests                                */
/* ================================================================== */
function loadSwContext({ fetchImpl, clientsImpl }) {
  const code = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = new Map();
  class SafeMessageChannel extends MessageChannel {
    constructor() {
      super();
      this.port1.unref?.();
      this.port2.unref?.();
    }
  }
  const safeSetTimeout = (fn, ms, ...a) => {
    const t = setTimeout(fn, ms, ...a);
    t.unref?.();
    return t;
  };
  const ctx = {
    console, Promise, Math, Date, JSON, RegExp, Array, Map, Set, Uint8Array,
    URL, URLSearchParams, Headers, Response, Request, AbortController, AbortSignal,
    MessageChannel: SafeMessageChannel, ReadableStream, TextEncoder,
    setTimeout: safeSetTimeout, clearTimeout,
    encodeURIComponent, decodeURIComponent, Number, String, Object, Error,
    self: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        matchAll: async () => (clientsImpl ? clientsImpl() : []),
        get: async id => (clientsImpl ? (await clientsImpl()).find(c => c.id === id) || null : null),
      },
    },
    fetch: fetchImpl,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'sw.js' });
  return {
    ctx,
    listeners,
    helpers: vm.runInContext(
      '({ parseRange: typeof parseRange !== "undefined" ? parseRange : null, inferMime: typeof inferMime !== "undefined" ? inferMime : null })',
      ctx
    ),
  };
}

test('sw.js: Range RFC 9110, 416, HEAD, 401 refresh via MessageChannel, 403 retry vs quota, dl=1', async () => {
  const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  const upstreamCalls = [];
  let tokenVersion = 1;
  let force401Once = true;
  let force429Once = true;

  const clientMock = {
    id: 'win-1',
    postMessage(msg, transfer) {
      if (msg && msg.type === 'REEL_NEED_TOKEN') {
        if (msg.force) tokenVersion = 2;
        const port = transfer[0];
        port.postMessage({ tok: `tok-v${tokenVersion}` });
        port.close?.();
      }
    },
  };

  const { listeners, helpers } = loadSwContext({
    clientsImpl: async () => [clientMock],
    fetchImpl: async (url, init = {}) => {
      upstreamCalls.push({ url: String(url), headers: { ...init.headers }, signal: init.signal });
      const auth = init.headers?.Authorization || init.headers?.authorization || '';
      if (force401Once && auth === 'Bearer tok-v1') {
        force401Once = false;
        return new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } }), { status: 401 });
      }
      if (force429Once && auth === 'Bearer tok-v2') {
        force429Once = false;
        return new Response(
          JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (String(url).includes('QUOTAFAIL')) {
        return new Response(
          JSON.stringify({ error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const rh = init.headers?.Range || init.headers?.range || '';
      const m = /^bytes=(\d*)-(\d*)$/.exec(rh);
      let s = 0, e = payload.length - 1;
      if (m) {
        if (m[1] === '' && m[2]) {
          const n = Number(m[2]);
          s = Math.max(0, payload.length - n);
          e = payload.length - 1;
        } else {
          s = m[1] ? Number(m[1]) : 0;
          e = m[2] ? Math.min(payload.length - 1, Number(m[2])) : payload.length - 1;
        }
        if (s > e || s >= payload.length) {
          return new Response('', {
            status: 416,
            headers: { 'Content-Range': `bytes */${payload.length}` },
          });
        }
        const slice = payload.subarray(s, e + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${s}-${e}/${payload.length}`,
            'Content-Length': String(slice.length),
            'Content-Type': 'application/octet-stream',
          },
        });
      }
      return new Response(payload, { status: 200 });
    },
  });

  // 1. parseRange RFC 9110 checks (using cross-realm plain JSON comparison + HTTP 416)
  const plainObj = x => JSON.parse(JSON.stringify(x));
  if (helpers.parseRange) {
    assert.deepEqual(plainObj(helpers.parseRange('bytes=0-9', 100)), { start: 0, end: 9, header: 'bytes=0-9' });
    assert.deepEqual(plainObj(helpers.parseRange('bytes=90-', 100)), { start: 90, end: 99, header: 'bytes=90-99' });
    assert.deepEqual(plainObj(helpers.parseRange('bytes=-10', 100)), { start: 90, end: 99, header: 'bytes=90-99' });
    const bad = helpers.parseRange('bytes=120-130', 100);
    assert.ok(bad && (bad.unsatisfiable || bad.invalid || bad.status === 416));
  }

  const appSw = loadAppContext();
  await appSw.drain();
  const streamPath = appSw.api.swUrl({ id: 'FILE123', name: 'Movie.mp4', size: payload.length, mime: 'video/mp4' });
  const dispatchFetch = req =>
    new Promise(resolve => {
      listeners.get('fetch')({
        request: req,
        clientId: 'win-1',
        respondWith: p => resolve(Promise.resolve(p)),
      });
    });

  // 2. Suffix range bytes=-5 + triggers 401 token refresh & 403 rateLimit retry
  const r1 = await dispatchFetch(
    new Request(`http://127.0.0.1:3000/${streamPath}`, {
      headers: { Range: 'bytes=-5' },
    })
  );
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), `bytes ${payload.length - 5}-${payload.length - 1}/${payload.length}`);
  assert.equal(await r1.text(), payload.subarray(payload.length - 5).toString());
  assert.equal(tokenVersion, 2);

  // 3. Invalid range -> HTTP 416
  const r416 = await dispatchFetch(
    new Request(`http://127.0.0.1:3000/${streamPath}`, {
      headers: { Range: 'bytes=500-600' },
    })
  );
  assert.equal(r416.status, 416);

  // 4. HEAD request maps to bytes=0-0 and empty body
  const beforeHead = upstreamCalls.length;
  const rHead = await dispatchFetch(
    new Request(`http://127.0.0.1:3000/${streamPath}`, { method: 'HEAD' })
  );
  assert.equal(upstreamCalls[beforeHead].headers.Range, 'bytes=0-0');
  assert.equal(await rHead.text(), '');

  // 5. dl=1 sets safe Content-Disposition: attachment
  const rDl = await dispatchFetch(
    new Request(`http://127.0.0.1:3000/${streamPath}&dl=1`)
  );
  assert.equal(rDl.status, 200);
  assert.match(rDl.headers.get('content-disposition') || '', /attachment;.*filename="Movie\.mp4"/);

  // 6. downloadQuotaExceeded passes 403 directly WITHOUT retry loop
  const beforeQuota = upstreamCalls.length;
  const quotaPath = appSw.api.swUrl({ id: 'QUOTAFAIL', name: 'Quota.mp4', size: 100, mime: 'video/mp4' });
  const rQuota = await dispatchFetch(new Request(`http://127.0.0.1:3000/${quotaPath}`));
  assert.equal(rQuota.status, 403);
  assert.equal(upstreamCalls.length - beforeQuota, 1);

  // 7. AbortSignal propagation
  const ac = new AbortController();
  const sigReq = new Request(`http://127.0.0.1:3000/${streamPath}`, { signal: ac.signal });
  await dispatchFetch(sigReq);
  const lastUpstream = upstreamCalls[upstreamCalls.length - 1];
  assert.ok(lastUpstream.signal instanceof AbortSignal);
  ac.abort();
  assert.equal(lastUpstream.signal.aborted, true);
});

/* ================================================================== */
/* 3. server.js BFF integration tests                                 */
/* ================================================================== */
test('server.js: static allowlist, OAuth code exchange, refresh mutex, range proxy & signed links', async () => {
  const { createReelServer } = require('./server.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-test-'));
  const videoBytes = Buffer.alloc(1024);
  for (let i = 0; i < videoBytes.length; i++) videoBytes[i] = i & 255;

  let oauthTokenCalls = 0;
  let currentAccessToken = 'access-initial';
  let forceExpiredOnce = false;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      oauthTokenCalls++;
      await new Promise(r => setTimeout(r, 25));
      const bodyStr = String(init.body || '');
      if (bodyStr.includes('grant_type=authorization_code')) {
        currentAccessToken = 'access-1';
        return new Response(
          JSON.stringify({ access_token: currentAccessToken, refresh_token: 'refresh-xyz', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (bodyStr.includes('grant_type=refresh_token')) {
        currentAccessToken = 'access-refreshed-' + oauthTokenCalls;
        forceExpiredOnce = false;
        return new Response(
          JSON.stringify({ access_token: currentAccessToken, expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
    if (u.startsWith('https://www.googleapis.com/drive/v3/files/VID1')) {
      const auth = init.headers?.Authorization || init.headers?.authorization || '';
      if (forceExpiredOnce && auth === 'Bearer access-1') {
        return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
      }
      if (!u.includes('alt=media')) {
        return new Response(
          JSON.stringify({ id: 'VID1', name: 'Test.Film.2024.mp4', size: String(videoBytes.length), mimeType: 'video/mp4' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const rh = init.headers?.Range || init.headers?.range || '';
      const m = /^bytes=(\d+)-(\d*)$/.exec(rh);
      if (m) {
        const s = Number(m[1]);
        const e = m[2] ? Math.min(videoBytes.length - 1, Number(m[2])) : videoBytes.length - 1;
        const slice = videoBytes.subarray(s, e + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${s}-${e}/${videoBytes.length}`,
            'Content-Length': String(slice.length),
            'Content-Type': 'video/mp4',
          },
        });
      }
      return new Response(videoBytes, {
        status: 200,
        headers: { 'Content-Length': String(videoBytes.length), 'Content-Type': 'video/mp4' },
      });
    }
    return origFetch(url, init);
  };

  const srvObj = createReelServer({
    staticDir: ROOT,
    configPath: path.join(tmpDir, 'config.json'),
    sessionsPath: path.join(tmpDir, 'sessions.json'),
  });
  const srv = typeof srvObj.listen === 'function' ? srvObj : srvObj.server;

  try {
    // 1. HTML injection + static allowlist security
    const rHtml = await invokeServer(srv, '/');
    assert.equal(rHtml.status, 200);
    assert.match(rHtml.text(), /<meta name="reel-bff" content="1">/);

    for (const forbidden of ['/server.js', '/tests.mjs', '/.reel-config.json', '/.reel-sessions.json']) {
      const rSec = await invokeServer(srv, forbidden);
      assert.ok(rSec.status === 403 || rSec.status === 404, `expected ${forbidden} blocked, got ${rSec.status}`);
    }

    // 2. Save OAuth client config & exchange auth code
    const rCfg = await invokeServer(srv, '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'cid-123', clientSecret: 'sec-456' }),
    });
    assert.equal(rCfg.status, 200);

    const rEx = await invokeServer(srv, '/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-1', redirectUri: 'postmessage' }),
    });
    assert.equal(rEx.status, 200);
    const setCookie = rEx.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) ? setCookie.some(c => /HttpOnly/i.test(c)) : /HttpOnly/i.test(String(setCookie || '')));
    const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookieHeader = cookieList.map(c => c.split(';')[0]).join('; ');

    const rStatus = await invokeServer(srv, '/api/auth/status', { headers: { Cookie: cookieHeader } });
    assert.equal(rStatus.status, 200);
    assert.equal(rStatus.json().authenticated, true);
    assert.equal(rStatus.json().hasRefreshToken, true);

    // 3. Byte-Range streaming + dl=1
    const rRange = await invokeServer(srv, '/api/stream/VID1', {
      headers: { Cookie: cookieHeader, Range: 'bytes=10-29' },
    });
    assert.equal(rRange.status, 206);
    assert.equal(rRange.headers['content-range'], 'bytes 10-29/1024');
    assert.deepEqual(rRange.buf, videoBytes.subarray(10, 30));

    const rDl = await invokeServer(srv, '/api/stream/VID1?dl=1&n=Test.Film.2024.mp4', { headers: { Cookie: cookieHeader } });
    assert.equal(rDl.status, 200);
    assert.match(rDl.headers['content-disposition'] || '', /attachment;.*filename="Test\.Film\.2024\.mp4"/);

    // 4. Concurrent 401 refresh single-flight mutex (5 parallel requests trigger ONLY 1 refresh call)
    forceExpiredOnce = true;
    const beforeCalls = oauthTokenCalls;
    const parallel = await Promise.all(
      [0, 1, 2, 3, 4].map(i =>
        invokeServer(srv, '/api/stream/VID1', {
          headers: { Cookie: cookieHeader, Range: `bytes=${i * 10}-${i * 10 + 9}` },
        })
      )
    );
    for (const r of parallel) assert.equal(r.status, 206);
    assert.equal(oauthTokenCalls - beforeCalls, 1, 'Expected single-flight refresh mutex');

    // 5. Signed external link works without cookie; tampered fails
    const rLink = await invokeServer(srv, '/api/stream-link/VID1', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(rLink.status, 200);
    const { url: signedPath } = rLink.json();
    assert.ok(signedPath.includes('st='));

    const rExt = await invokeServer(srv, signedPath, { headers: { Range: 'bytes=0-15' } });
    assert.equal(rExt.status, 206);
    assert.deepEqual(rExt.buf, videoBytes.subarray(0, 16));

    const badPath = signedPath.slice(0, -1) + (signedPath.endsWith('0') ? '1' : '0');
    const rBad = await invokeServer(srv, badPath);
    assert.ok(rBad.status === 401 || rBad.status === 403);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* 4. Frontend client logic, XSS, subtitles, metadata, progress & MKV */
/* ================================================================== */
const plain = x => JSON.parse(JSON.stringify(x));

test('Metadata parsing: clean(), se(), pickShowName(), artKey(), safeUrl()', async () => {
  const { api, drain } = loadAppContext();
  await drain();

  assert.deepEqual(plain(api.clean('2001.A.Space.Odyssey.1968.2160p.BluRay.x265.mkv')), {
    t: '2001 A Space Odyssey',
    y: '1968',
  });
  assert.deepEqual(plain(api.clean('Blade.Runner.2049.(2017).1080p.WEB-DL.mp4')), {
    t: 'Blade Runner 2049',
    y: '2017',
  });
  assert.deepEqual(plain(api.clean('The.Matrix.1999.REMASTERED.mkv')), {
    t: 'The Matrix',
    y: '1999',
  });

  assert.deepEqual(plain(api.se('Show.S02E14.1080p.mkv')), [2, 14]);
  assert.deepEqual(plain(api.se('Show.1x07.mkv')), [1, 7]);
  assert.deepEqual(plain(api.se('Episode 09 - Pilot.mkv')), [1, 9]);
  assert.deepEqual(plain(api.se('Dark - 04.mkv')), [1, 4]);

  assert.equal(api.pickShowName(['Breaking Bad', 'Season 02'], 'Series'), 'Breaking Bad');
  assert.equal(api.pickShowName(['Severance', 'Temporada 1'], 'Series'), 'Severance');
  assert.equal(api.pickShowName(['Chernobyl'], 'Series'), 'Chernobyl');

  assert.equal(api.safeUrl('javascript:alert(1)'), '');
  assert.equal(api.safeUrl('data:text/html,<script>'), '');
  assert.equal(api.safeUrl('https://image.tmdb.org/t/p/w500/abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
});

test('XSS neutralization in loadF(), render(), and artUrls', async () => {
  const { api, byIdMap, drain } = loadAppContext();
  await drain();
  const payload = `"><img src=x onerror=alert(1)>`;
  api.setLibs([{ id: 'LIB1', name: 'Filmes', type: 'films' }]);
  api.setCache({
    LIB1: [
      { id: 'ID_XSS', name: payload + '.2024.mkv', size: 1000, mime: 'video/x-matroska', lib: 'LIB1', pid: 'LIB1' },
    ],
  });
  api.render();
  const mainHtml = byIdMap.get('main').innerHTML;
  assert.doesNotMatch(mainHtml, /<img src=x onerror=/i);
  assert.doesNotMatch(mainHtml, /onclick=/i);

  api.loadF('ID_XSS');
  assert.doesNotMatch(mainHtml, /<img src=x onerror=/i);
});

test('External subtitles: srtToVtt(), assToVtt(), parseVttCues(), findExtSubs()', async () => {
  const { api, drain } = loadAppContext();
  await drain();

  const srt = '\uFEFF1\r\n00:01:02,500 --> 00:01:05,750\r\nOlá mundo!\r\nSegunda linha.\r\n\r\n2\r\n01:02,000 --> 01:04,500\r\nCurto';
  const vttFromSrt = api.srtToVtt(srt);
  assert.ok(vttFromSrt.startsWith('WEBVTT'));
  assert.match(vttFromSrt, /00:01:02\.500 --> 00:01:05\.750/);
  assert.match(vttFromSrt, /00:01:02\.000 --> 00:01:04\.500/);

  const ass = `[Script Info]\nTitle: Demo\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:04.25,Default,,0,0,0,,{\\i1}Texto\\NLinha 2\nDialogue: 0,0:00:05.00,0:00:06.00,Signs,,0,0,0,,{\\p1}m 0 0 l 10 10\n`;
  const vttFromAss = api.assToVtt(ass);
  const cues = api.parseVttCues(vttFromAss);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].a, 1.5);
  assert.equal(cues[0].b, 4.25);
  assert.equal(cues[0].tx, 'Texto\nLinha 2');

  const film = { id: 'V1', name: 'Dune.Part.Two.2024.mkv', lib: 'L1', pid: 'F_DUNE', show: '' };
  const ep = { id: 'V2', name: 'Dark.S01E03.mkv', lib: 'L1', pid: 'F_DARK', show: 'Dark' };
  api.setSubs({
    L1: [
      { id: 'S1', name: 'Dune.Part.Two.2024.pt-PT.srt', size: 12000, pid: 'F_DUNE', dir: 'Dune' },
      { id: 'S2', name: 'Dune.Part.Two.2024.en.forced.ass', size: 15000, pid: 'F_SUBS', dir: 'Dune/Subs' },
      { id: 'S3', name: 'Unrelated.Movie.pt.srt', size: 10000, pid: 'F_OTHER', dir: 'Other', show: '' },
      { id: 'S4', name: 'S01E03.pt.srt', size: 11000, pid: 'F_DARK_SUBS', dir: 'Dark/Subs', show: 'Dark' },
    ],
  });
  const matches = api.findExtSubs(film);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].id, 'S1');
  assert.equal(matches[0].lang, 'por');
  assert.equal(matches[1].id, 'S2');
  assert.equal(matches[1].frc, true);

  const epMatches = api.findExtSubs(ep);
  assert.equal(epMatches.length, 1);
  assert.equal(epMatches[0].id, 'S4');
});

test('Progress persistence: persist() rewatch reset, askStop() validation, reconcileProgress()', async () => {
  const { api, byIdMap, drain } = loadAppContext();
  await drain();
  const f1 = { id: 'VID_OLD', name: 'Movie.2024.1080p.mkv', lib: 'L1', pid: 'P1', mime: 'video/x-matroska', size: 5000 };
  const f1New = { id: 'VID_NEW', name: 'Movie.2024.2160p.mkv', lib: 'L1', pid: 'P1', mime: 'video/x-matroska', size: 8000 };

  api.setLibs([{ id: 'L1', name: 'Filmes', type: 'films' }]);
  api.setCache({ L1: [f1] });

  api.setProg({ VID_OLD: { t: 3500, d: 3600, w: true, at: Date.now() - 10000 } });
  const vid = byIdMap.get('vid');
  vid.duration = 3600;
  vid.currentTime = 120;
  api.setCur(f1);
  api.persist();

  let saved = api.P('VID_OLD');
  assert.equal(saved.w, false, 'Rewatch past 0 must clear watched flag when t/d <= 0.92');
  assert.equal(saved.t, 120);
  assert.ok(saved.key);

  vid.currentTime = 3400;
  api.persist();
  assert.equal(api.P('VID_OLD').w, true);

  api.setPrompt(() => '12:90');
  api.askStop();
  assert.equal(api.P('VID_OLD').t, 3400, 'Invalid seconds > 59 must be rejected');

  api.setPrompt(() => ':');
  api.askStop();
  assert.equal(api.P('VID_OLD').t, 3400, 'Lone colon must be rejected');

  api.setPrompt(() => '0:30:15');
  api.askStop();
  assert.equal(api.P('VID_OLD').t, 1815);
  assert.equal(api.P('VID_OLD').w, false);

  api.setCache({ L1: [f1New] });
  api.reconcileProgress('L1', [f1New]);
  const remapped = api.P('VID_NEW');
  assert.equal(remapped.t, 1815);
});

test('MKV: 8-byte VINT unknown size, bounded blocks, aacCfg, audSupported fallback & stop() abort', async () => {
  const { api, drain } = loadAppContext();
  await drain();
  const { MKV } = api;

  const unk8 = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(plain(MKV.rv(unk8, 0, 0)), [-1, 8]);

  const val8 = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
  assert.deepEqual(plain(MKV.rv(val8, 0, 0)), [1, 8]);

  const out = [];
  MKV.blocks(new Uint8Array([0xa3, 0x82, 0x81, 0x00]), 0, 4, 1e6, out, {});
  assert.equal(out.length, 0);

  assert.deepEqual(Array.from(MKV.aacCfg({ codec: 'A_AAC', sr: 48000, ch: 2 })), [0x11, 0x90]);

  const FakeMS = { isTypeSupported: m => !/ec-3/.test(m) };
  assert.equal(MKV.audSupported({ codec: 'A_EAC3' }, FakeMS), false);
  assert.equal(MKV.audSupported({ codec: 'A_AAC' }, FakeMS), true);

  const stalled = loadAppContext({
    fetchMock: (_u, init = {}) => new Promise((_, rej) => {
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rej(e);
        }, { once: true });
      }
    }),
  });
  await stalled.drain();
  stalled.api.setToken('tok-test', Date.now() + 60000);
  const pending = stalled.api.MKV.start(
    { id: 'TESTMKV', size: 10 << 20 },
    stalled.byIdMap.get('vid'),
    0,
    '',
    {}
  );
  await new Promise(r => setTimeout(r, 15));
  stalled.api.MKV.stop();
  await assert.rejects(pending, err => err && (err.name === 'AbortError' || /Abortado/.test(err.message)));
});

test('Auth silent proactive refresh & single-flight mutex + BFF unauthenticated fallback', async () => {
  const { api, drain } = loadAppContext({ hasBFFMeta: true });
  await drain();

  // Even when BFF meta tag is present, if BFF is NOT authenticated, direct() falls back to client SW/key URL
  assert.equal(api.hasBFF(), true);
  assert.equal(api.BFF.authenticated, false);
  const directUrl = api.direct({ id: 'F1', name: 'A.mp4', size: 100 });
  assert.doesNotMatch(directUrl, /^\/api\/stream\//);

  // Set valid-for-30s token and test force+silent proactive refresh single-flight
  api.setToken('tok-old', Date.now() + 30000);
  let promptCalls = 0;
  api.setGoogleOAuth({
    accounts: {
      oauth2: {
        initTokenClient: cfg => ({
          requestAccessToken: opts => {
            promptCalls++;
            assert.equal(opts.prompt, '');
            setTimeout(() => cfg.callback({ access_token: 'tok-renewed', expires_in: 3600 }), 15);
          },
        }),
      },
    },
  });

  // Two parallel proactive refresh calls share one OAuth prompt='' flight and yield new token
  const [t1, t2] = await Promise.all([
    api.auth({ silent: true, force: true }),
    api.auth({ silent: true, force: true }),
  ]);
  assert.equal(promptCalls, 1);
  assert.equal(t1, 'tok-renewed');
  assert.equal(t2, 'tok-renewed');
});
