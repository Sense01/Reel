// REEL Service Worker: streaming autenticado com Range RFC 9110, AbortSignal, retry/backoff e renovação OAuth.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CLAIM') e.waitUntil(self.clients.claim());
});

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  ssa: 'text/plain; charset=utf-8'
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

let refreshPromise = null;
async function requestTokenFromClient(force) {
  const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!cls.length) throw new Error('Sem janela ativa para renovar sessão Google');
  const target = cls.find(c => c.visibilityState === 'visible') || cls[0];
  return new Promise((res, rej) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      try { ch.port1.close(); } catch (_) {}
      rej(new Error('Timeout a renovar token OAuth'));
    }, 12000);
    ch.port1.onmessage = ev => {
      clearTimeout(timer);
      try { ch.port1.close(); } catch (_) {}
      if (ev.data && ev.data.tok) res(ev.data.tok);
      else rej(new Error((ev.data && ev.data.error) || 'Sessão Google expirada'));
    };
    target.postMessage({ type: 'REEL_NEED_TOKEN', force: !!force }, [ch.port2]);
  });
}

async function getValidToken(force = false) {
  if (!force) {
    try {
      const c = await (await caches.open('reel-tok')).match('/__tok');
      if (c) {
        const d = await c.json();
        if (d && d.tok && (!d.exp || Date.now() < d.exp - 15000)) return d.tok;
      }
    } catch (_) {}
  }
  if (!refreshPromise) {
    refreshPromise = requestTokenFromClient(force).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

self.addEventListener('fetch', e => {
  if (!/^(GET|HEAD)$/i.test(e.request.method)) return;
  const u = new URL(e.request.url);
  const m = u.pathname.match(/\/stream\/([\w-]+)$/);
  if (!m) return;

  e.respondWith((async () => {
    const size = Math.max(0, Number(u.searchParams.get('s')) || 0);
    const reqRange = e.request.headers.get('Range');
    const isHead = e.request.method === 'HEAD';
    const range = parseRange(reqRange, size);

    if (range && range.invalid) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': size > 0 ? `bytes */${size}` : 'bytes */*' }
      });
    }

    const upstreamUrl = `https://www.googleapis.com/drive/v3/files/${m[1]}?alt=media&supportsAllDrives=true`;
    const upstreamRange = isHead && !range ? 'bytes=0-0' : (range ? range.header : '');
    let forceRefresh = false;
    let retried401 = false;

    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        let tok;
        try {
          tok = await getValidToken(forceRefresh);
          forceRefresh = false;
        } catch (err) {
          return new Response(JSON.stringify({ error: { message: err.message } }), {
            status: 401,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
          });
        }

        const headers = { Authorization: 'Bearer ' + tok };
        if (upstreamRange) headers.Range = upstreamRange;

        let r;
        try {
          r = await fetch(upstreamUrl, { headers, signal: e.request.signal });
        } catch (err) {
          if (err && err.name === 'AbortError') return new Response(null, { status: 499 });
          if (attempt < 3) {
            await sleepAbortable(500 * 2 ** attempt + Math.random() * 300, e.request.signal);
            continue;
          }
          return new Response(JSON.stringify({ error: { message: err?.message || 'Erro de rede' } }), {
            status: 502,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
          });
        }

        if (r.status === 401 && !retried401) {
          retried401 = true;
          forceRefresh = true;
          try { await r.body?.cancel(); } catch (_) {}
          continue;
        }

        if (r.status === 403 || r.status === 429 || r.status >= 500) {
          let txt = '';
          let reason = '';
          if (r.status === 403) {
            try {
              txt = await r.text();
              reason = JSON.parse(txt)?.error?.errors?.[0]?.reason || '';
            } catch (_) {}
            const retryable403 = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
            if (!retryable403) {
              return new Response(txt, {
                status: r.status,
                headers: {
                  'content-type': r.headers.get('content-type') || 'application/json',
                  'cache-control': 'no-store'
                }
              });
            }
          } else {
            try { await r.body?.cancel(); } catch (_) {}
          }
          if (attempt < 3) {
            const ra = Number(r.headers.get('Retry-After'));
            const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
            await sleepAbortable(Math.min(base + Math.random() * 400, 15000), e.request.signal);
            continue;
          }
          return new Response(txt || JSON.stringify({ error: { message: 'Drive ' + r.status } }), {
            status: r.status,
            headers: {
              'content-type': r.headers.get('content-type') || 'application/json',
              'cache-control': 'no-store'
            }
          });
        }

        if (!r.ok) {
          const errH = {
            'content-type': r.headers.get('content-type') || 'application/json',
            'cache-control': 'no-store'
          };
          if (r.headers.has('content-range')) errH['content-range'] = r.headers.get('content-range');
          return new Response(r.body, { status: r.status, headers: errH });
        }

        const o = new Headers({
          'content-type': inferMime(u.searchParams.get('n'), r.headers.get('content-type')),
          'accept-ranges': 'bytes',
          'cache-control': 'no-store'
        });

        if (isHead) {
          try { await r.body?.cancel(); } catch (_) {}
          const cr = r.headers.get('content-range') || '';
          const total = (cr.match(/\/(\d+)$/) || [])[1] || (size ? String(size) : '');
          if (range) {
            if (cr) o.set('content-range', cr);
            if (r.headers.has('content-length')) o.set('content-length', r.headers.get('content-length'));
            return new Response(null, { status: r.status, headers: o });
          }
          if (total) o.set('content-length', total);
          return new Response(null, { status: 200, headers: o });
        }

        const cr = r.headers.get('content-range');
        const cl = r.headers.get('content-length');
        if (cr) o.set('content-range', cr);
        else if (r.status === 206 && range && !range.raw && size > 0) {
          o.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
        }
        if (cl) o.set('content-length', cl);

        if (u.searchParams.has('dl')) {
          const fname = (u.searchParams.get('n') || 'video.mp4').replace(/[\r\n"]/g, '_');
          const ascii = fname.replace(/[^\x20-\x7E]/g, '_') || 'video.mp4';
          o.set('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
        }

        return new Response(r.body, { status: r.status, headers: o });
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return new Response(null, { status: 499 });
      return new Response(JSON.stringify({ error: { message: err?.message || 'Erro interno SW' } }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }

    return new Response('Drive indisponível', { status: 503 });
  })());
});
