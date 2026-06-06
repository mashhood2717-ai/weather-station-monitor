// Lightning alerts backend (dedicated Cloudflare account).
// - Consumes the public lightning SSE stream.
// - Holds all subscriptions in memory + DO SQLite, grid-indexed.
// - For each strike, alerts users within their radius (per-user cooldown).
// - Sends FCM (HTTP v1) using a Firebase service-account secret (FCM_SA).

const DEFAULT_RADIUS_KM = 50;
const MAX_RADIUS_KM = 200;
const COOLDOWN_MS = 10 * 60 * 1000; // one alert per user per 10 min
const BUFFER_MS = 10 * 60 * 1000;   // keep last 10 min of strikes for app backfill
const BUFFER_MAX = 4000;            // cap the /buffer response size
const CELL_DEG = 0.5;               // grid bucket (~55 km)
const CELL_SPAN = 4;                // search +/-4 cells (~220 km) to cover MAX_RADIUS_KM
const SEND_CONCURRENCY = 20;

// Service area = Pakistan (bounding box). Devices located outside are NOT
// registered, so only users in Pakistan ever receive alerts.
const PK_BBOX = { latMin: 23.0, latMax: 37.5, lonMin: 60.5, lonMax: 78.0 };
function inPakistan(lat, lon) {
  return lat >= PK_BBOX.latMin && lat <= PK_BBOX.latMax && lon >= PK_BBOX.lonMin && lon <= PK_BBOX.lonMax;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, corsHeaders()),
  });
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    const url = new URL(request.url);
    // 10-min strike buffer for app backfill, edge-cached so 10k clients don't hammer the DO.
    if (url.pathname === '/buffer') {
      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      let resp = await cache.match(cacheKey);
      if (resp) return resp;
      const stub = env.ALERTS.get(env.ALERTS.idFromName('global'));
      const r = await stub.fetch('https://do/_buffer');
      resp = new Response(r.body, r);
      resp.headers.set('cache-control', 'public, max-age=15');
      resp.headers.set('access-control-allow-origin', '*');
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }
    if (url.pathname.startsWith('/alerts/')) {
      const stub = env.ALERTS.get(env.ALERTS.idFromName('global'));
      return stub.fetch(request);
    }
    return new Response('lightning-alerts', { headers: corsHeaders() });
  },
  async scheduled(_controller, env) {
    // Heartbeat: ensure the stream consumer is alive.
    const stub = env.ALERTS.get(env.ALERTS.idFromName('global'));
    await stub.fetch('https://do/alerts/_ensure').catch(() => {});
  },
};

export class AlertHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.subs = new Map();   // token -> { token, lat, lon, radius, last }
    this.grid = new Map();   // "i_j" -> Set(token)
    this.buffer = [];        // rolling last-10-min strikes: [lat, lon, t]
    this.running = false;
    this.loaded = false;
    this.tokenCache = null;  // { token, exp }
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (token TEXT PRIMARY KEY, lat REAL, lon REAL, radius REAL, last INTEGER DEFAULT 0)');
    const rows = this.sql.exec('SELECT token, lat, lon, radius, last FROM subs').toArray();
    for (const r of rows) this._mem(r);
    this.loaded = true;
  }

  _cellKey(lat, lon) { return Math.floor(lat / CELL_DEG) + '_' + Math.floor(lon / CELL_DEG); }
  _mem(s) {
    this.subs.set(s.token, s);
    const k = this._cellKey(s.lat, s.lon);
    let set = this.grid.get(k);
    if (!set) { set = new Set(); this.grid.set(k, set); }
    set.add(s.token);
  }
  _unmem(token) {
    const s = this.subs.get(token);
    if (!s) return;
    const k = this._cellKey(s.lat, s.lon);
    const set = this.grid.get(k);
    if (set) { set.delete(token); if (!set.size) this.grid.delete(k); }
    this.subs.delete(token);
  }

  async fetch(request) {
    await this.ensureLoaded();
    this.startConsumer(); // any hit keeps the stream consumer alive
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/_buffer') {
      const arr = this.buffer.length > BUFFER_MAX ? this.buffer.slice(this.buffer.length - BUFFER_MAX) : this.buffer;
      return new Response(JSON.stringify({ serverTime: Date.now(), count: arr.length, strikes: arr }), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }

    if (p === '/alerts/_ensure') { this.startConsumer(); return json({ ok: true, running: this.running }); }

    if (p === '/alerts/status') {
      return json({ subscribers: this.subs.size, cells: this.grid.size, running: this.running, hasKey: !!this.env.FCM_SA, buffer: this.buffer.length });
    }

    if (p === '/alerts/subscribe' || p === '/alerts/update') {
      const b = await request.json().catch(() => null);
      if (!b || typeof b.token !== 'string' || !isFinite(+b.lat) || !isFinite(+b.lon)) return json({ error: 'token, lat, lon required' }, 400);
      const radius = Math.max(1, Math.min(MAX_RADIUS_KM, Number(b.radius) || DEFAULT_RADIUS_KM));
      if (!inPakistan(+b.lat, +b.lon)) {
        this._unmem(b.token); this.sql.exec('DELETE FROM subs WHERE token=?', b.token);
        return json({ ok: true, skipped: true, reason: 'outside Pakistan service area' });
      }
      const prev = this.subs.get(b.token);
      const s = { token: b.token, lat: +b.lat, lon: +b.lon, radius, last: prev ? prev.last : 0 };
      this._unmem(b.token); this._mem(s);
      this.sql.exec('INSERT INTO subs (token,lat,lon,radius,last) VALUES (?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET lat=?,lon=?,radius=?',
        s.token, s.lat, s.lon, s.radius, s.last, s.lat, s.lon, s.radius);
      this.startConsumer();
      return json({ ok: true, subscribers: this.subs.size });
    }

    if (p === '/alerts/remove') {
      const b = await request.json().catch(() => null);
      if (b && b.token) { this._unmem(b.token); this.sql.exec('DELETE FROM subs WHERE token=?', b.token); }
      return json({ ok: true });
    }

    if (p === '/alerts/test') {
      // Send a test push to one token to verify FCM end-to-end.
      const b = await request.json().catch(() => null);
      if (!b || !b.token) return json({ error: 'token required' }, 400);
      const access = await this.getAccessToken();
      if (!access) return json({ error: 'no FCM access token (is FCM_SA set?)' }, 500);
      const r = await this.sendFcm(access, this.projectId, b.token, { lat: b.lat || 0, lon: b.lon || 0, dkm: 0 }, true);
      return json({ ok: true, fcmStatus: r });
    }

    return new Response('AlertHub');
  }

  startConsumer() {
    if (this.running) return;
    this.running = true;
    this.consume().catch(() => {}).finally(() => { this.running = false; });
    this.state.storage.setAlarm(Date.now() + 60000).catch(() => {});
  }

  async alarm() {
    this.startConsumer();
    this.state.storage.setAlarm(Date.now() + 60000).catch(() => {});
  }

  async consume() {
    const resp = await fetch(this.env.STREAM_URL, { headers: { Accept: 'text/event-stream' } });
    if (!resp.ok || !resp.body) return;
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const js = line.slice(5).trim();
        if (!js || js[0] !== '{') continue;
        let d; try { d = JSON.parse(js); } catch (e) { continue; }
        if (d && Array.isArray(d.strikes) && d.strikes.length) await this.onStrikes(d.strikes);
      }
    }
  }

  async onStrikes(strikes) {
    const now = Date.now();
    // Rolling 10-min buffer for app backfill — kept even with zero subscribers.
    for (const st of strikes) {
      const blat = +st[0], blon = +st[1];
      if (!isFinite(blat) || !isFinite(blon)) continue;
      this.buffer.push([blat, blon, st.length > 2 ? +st[2] : now]);
    }
    const cutoff = now - BUFFER_MS;
    while (this.buffer.length && this.buffer[0][2] < cutoff) this.buffer.shift();
    if (this.buffer.length > 60000) this.buffer.splice(0, this.buffer.length - 60000);

    if (!this.subs.size) return;
    const toSend = new Map(); // token -> { lat, lon, dkm }
    for (const st of strikes) {
      const lat = +st[0], lon = +st[1];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const ci = Math.floor(lat / CELL_DEG), cj = Math.floor(lon / CELL_DEG);
      for (let di = -CELL_SPAN; di <= CELL_SPAN; di++) {
        for (let dj = -CELL_SPAN; dj <= CELL_SPAN; dj++) {
          const set = this.grid.get((ci + di) + '_' + (cj + dj));
          if (!set) continue;
          for (const token of set) {
            const s = this.subs.get(token);
            if (!s || now - s.last < COOLDOWN_MS) continue;
            const dkm = haversine(lat, lon, s.lat, s.lon);
            if (dkm <= s.radius) {
              const cur = toSend.get(token);
              if (!cur || dkm < cur.dkm) toSend.set(token, { lat, lon, dkm });
            }
          }
        }
      }
    }
    if (toSend.size) await this.dispatch(toSend, now);
  }

  async dispatch(toSend, now) {
    const tokens = [...toSend.keys()];
    for (const t of tokens) { const s = this.subs.get(t); if (s) s.last = now; this.sql.exec('UPDATE subs SET last=? WHERE token=?', now, t); }
    const access = await this.getAccessToken();
    if (!access) return;
    const projectId = this.projectId;
    const queue = tokens.slice();
    const workers = [];
    for (let i = 0; i < Math.min(SEND_CONCURRENCY, queue.length); i++) {
      workers.push((async () => {
        while (queue.length) {
          const t = queue.shift();
          await this.sendFcm(access, projectId, t, toSend.get(t)).catch(() => {});
        }
      })());
    }
    await Promise.all(workers);
  }

  async sendFcm(access, projectId, token, info, isTest) {
    const km = Math.round(info.dkm);
    const body = {
      message: {
        token,
        notification: {
          title: isTest ? '⚡ Test alert' : '⚡ Lightning nearby',
          body: isTest ? 'Lightning alerts are working.' : ('Lightning detected ~' + km + ' km away.'),
        },
        data: { lat: String(info.lat), lon: String(info.lon), dkm: String(km), ts: String(Date.now()) },
        android: { priority: 'high', notification: { sound: 'default' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    };
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Drop dead tokens so the list stays clean.
      if (r.status === 404) { this._unmem(token); this.sql.exec('DELETE FROM subs WHERE token=?', token); }
      try {
        const e = await r.json();
        const code = e && e.error && (e.error.status || (e.error.details && e.error.details[0] && e.error.details[0].errorCode));
        if (code === 'UNREGISTERED' || code === 'NOT_FOUND') { this._unmem(token); this.sql.exec('DELETE FROM subs WHERE token=?', token); }
        return r.status + ':' + (code || 'err');
      } catch (e) { return r.status + ':err'; }
    }
    return 'ok';
  }

  get projectId() { try { return JSON.parse(this.env.FCM_SA).project_id; } catch (e) { return ''; } }

  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.tokenCache && this.tokenCache.exp - 60 > now) return this.tokenCache.token;
    let sa; try { sa = JSON.parse(this.env.FCM_SA); } catch (e) { return null; }
    if (!sa.client_email || !sa.private_key) return null;
    const jwt = await makeJwt(sa, now);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
    });
    if (!r.ok) return null;
    const j = await r.json();
    this.tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
    return this.tokenCache.token;
  }
}

// ---- FCM service-account JWT (RS256 via WebCrypto) ----
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makeJwt(sa, iat) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  };
  const enc = new TextEncoder();
  const input = b64url(enc.encode(JSON.stringify(header))) + '.' + b64url(enc.encode(JSON.stringify(claim)));
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return input + '.' + b64url(new Uint8Array(sig));
}
async function importPrivateKey(pem) {
  const body = pem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
