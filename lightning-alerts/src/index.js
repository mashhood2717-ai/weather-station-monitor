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
// Initial bearing (degrees, 0=N clockwise) from point A to point B.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
function compass8(b) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
}
// Proximity rings as a fraction of the point's radius: 0=nearby, 1=close, 2=overhead.
// Escalation re-alerts (bypassing the cooldown) only when a strike enters a
// TIGHTER ring than the device was last alerted at this storm.
function ringOf(dkm, radius) {
  if (dkm <= radius * 0.15) return 2;
  if (dkm <= radius * 0.40) return 1;
  return 0;
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
    this.subs = new Map();   // token -> { token, last, points: [{lat,lon,radius}] }
    this.grid = new Map();   // "i_j" -> Set(token)  (token indexed at each of its points' cells)
    this.buffer = [];        // rolling last-10-min strikes: [lat, lon, t]
    this.running = false;
    this.loaded = false;
    this.tokenCache = null;  // { token, exp }
  }

  async ensureLoaded() {
    if (this.loaded) return;
    // subs = per-device cooldown (last); sub_points = 1..N locations per device.
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (token TEXT PRIMARY KEY, lat REAL, lon REAL, radius REAL, last INTEGER DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sub_points (token TEXT, lat REAL, lon REAL, radius REAL, name TEXT)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_sub_points_token ON sub_points(token)');
    // Add the name column to a pre-existing sub_points table (idempotent).
    try { this.sql.exec('ALTER TABLE sub_points ADD COLUMN name TEXT'); } catch (e) {}
    // Per-device escalation ring (tightest ring alerted this storm). Idempotent.
    try { this.sql.exec('ALTER TABLE subs ADD COLUMN ring INTEGER DEFAULT 0'); } catch (e) {}
    // One-time migration: legacy single-location subs -> sub_points (idempotent).
    for (const r of this.sql.exec('SELECT token, lat, lon, radius FROM subs WHERE lat IS NOT NULL').toArray()) {
      const c = this.sql.exec('SELECT COUNT(*) AS c FROM sub_points WHERE token=?', r.token).toArray()[0].c;
      if (!c) this.sql.exec('INSERT INTO sub_points (token,lat,lon,radius,name) VALUES (?,?,?,?,?)', r.token, r.lat, r.lon, r.radius || DEFAULT_RADIUS_KM, 'your area');
    }
    // Build memory: group points by token, attach each device's cooldown.
    const lastBy = new Map();
    const ringBy = new Map();
    for (const r of this.sql.exec('SELECT token, last, ring FROM subs').toArray()) {
      lastBy.set(r.token, r.last || 0);
      ringBy.set(r.token, r.ring || 0);
    }
    const byToken = new Map();
    for (const r of this.sql.exec('SELECT token, lat, lon, radius, name FROM sub_points').toArray()) {
      let arr = byToken.get(r.token); if (!arr) { arr = []; byToken.set(r.token, arr); }
      arr.push({ lat: r.lat, lon: r.lon, radius: r.radius, name: r.name || '' });
    }
    for (const [token, points] of byToken) this._mem({ token, last: lastBy.get(token) || 0, ring: ringBy.get(token) || 0, points });
    this.loaded = true;
  }

  _cellKey(lat, lon) { return Math.floor(lat / CELL_DEG) + '_' + Math.floor(lon / CELL_DEG); }
  _cellsOf(s) { const c = new Set(); for (const pt of s.points) c.add(this._cellKey(pt.lat, pt.lon)); return c; }
  _mem(s) {
    this.subs.set(s.token, s);
    for (const k of this._cellsOf(s)) {
      let set = this.grid.get(k);
      if (!set) { set = new Set(); this.grid.set(k, set); }
      set.add(s.token);
    }
  }
  _unmem(token) {
    const s = this.subs.get(token);
    if (!s) return;
    for (const k of this._cellsOf(s)) {
      const set = this.grid.get(k);
      if (set) { set.delete(token); if (!set.size) this.grid.delete(k); }
    }
    this.subs.delete(token);
  }
  // Remove from memory AND both tables (unsubscribe / dead token / no-PK points).
  _remove(token) {
    this._unmem(token);
    this.sql.exec('DELETE FROM sub_points WHERE token=?', token);
    this.sql.exec('DELETE FROM subs WHERE token=?', token);
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
      let pts = 0; for (const s of this.subs.values()) pts += s.points.length;
      return json({ subscribers: this.subs.size, points: pts, cells: this.grid.size, running: this.running, hasKey: !!this.env.FCM_SA, buffer: this.buffer.length });
    }

    if (p === '/alerts/subscribe' || p === '/alerts/update') {
      const b = await request.json().catch(() => null);
      if (!b || typeof b.token !== 'string') return json({ error: 'token required' }, 400);
      // Accept multi-point { points: [{lat,lon,radius}] } OR legacy single { lat, lon, radius }.
      const raw = Array.isArray(b.points) ? b.points
        : (isFinite(+b.lat) && isFinite(+b.lon) ? [{ lat: b.lat, lon: b.lon, radius: b.radius }] : null);
      if (!raw) return json({ error: 'points or lat/lon required' }, 400);
      // Sanitize, keep only points inside Pakistan, dedupe near-identical points.
      const points = [];
      const seen = new Set();
      for (const p0 of raw) {
        const lat = +p0.lat, lon = +p0.lon;
        if (!isFinite(lat) || !isFinite(lon) || !inPakistan(lat, lon)) continue;
        const radius = Math.max(1, Math.min(MAX_RADIUS_KM, Number(p0.radius) || DEFAULT_RADIUS_KM));
        const name = (typeof p0.name === 'string' ? p0.name.trim().slice(0, 60) : '') || 'your area';
        const key = lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + radius;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push({ lat, lon, radius, name });
      }
      // No valid Pakistan points → drop the device entirely.
      if (!points.length) {
        this._remove(b.token);
        return json({ ok: true, skipped: true, reason: 'no points in Pakistan service area' });
      }
      const prev = this.subs.get(b.token);
      const last = prev ? prev.last : 0;
      const ring = prev ? (prev.ring || 0) : 0;
      this._unmem(b.token);
      this._mem({ token: b.token, last, ring, points });
      // Persist: replace this device's points; keep its cooldown row.
      this.sql.exec('DELETE FROM sub_points WHERE token=?', b.token);
      for (const pt of points) this.sql.exec('INSERT INTO sub_points (token,lat,lon,radius,name) VALUES (?,?,?,?,?)', b.token, pt.lat, pt.lon, pt.radius, pt.name);
      this.sql.exec('INSERT INTO subs (token,last) VALUES (?,?) ON CONFLICT(token) DO NOTHING', b.token, last);
      this.startConsumer();
      return json({ ok: true, subscribers: this.subs.size, points: points.length });
    }

    if (p === '/alerts/remove') {
      const b = await request.json().catch(() => null);
      if (b && b.token) this._remove(b.token);
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
    const toSend = new Map(); // token -> { lat, lon, dkm }  (closest matching point wins)
    for (const st of strikes) {
      const lat = +st[0], lon = +st[1];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const ci = Math.floor(lat / CELL_DEG), cj = Math.floor(lon / CELL_DEG);
      const checked = new Set(); // a token may sit in several cells in the window — check once
      for (let di = -CELL_SPAN; di <= CELL_SPAN; di++) {
        for (let dj = -CELL_SPAN; dj <= CELL_SPAN; dj++) {
          const set = this.grid.get((ci + di) + '_' + (cj + dj));
          if (!set) continue;
          for (const token of set) {
            if (checked.has(token)) continue;
            checked.add(token);
            const s = this.subs.get(token);
            if (!s) continue;
            let best = Infinity, bestPt = null;
            for (const pt of s.points) {
              const dkm = haversine(lat, lon, pt.lat, pt.lon);
              if (dkm <= pt.radius && dkm < best) { best = dkm; bestPt = pt; }
            }
            if (!bestPt) continue;
            // Escalation: re-alert (bypassing the cooldown) ONLY when the strike
            // enters a tighter ring than we last alerted this device; otherwise
            // honour the 10-min per-device cooldown.
            const strikeRing = ringOf(best, bestPt.radius);
            const escalate = strikeRing > (s.ring || 0);
            const cooldownOk = (now - s.last) >= COOLDOWN_MS;
            if (!escalate && !cooldownOk) continue;
            const cur = toSend.get(token);
            if (!cur || best < cur.dkm) {
              toSend.set(token, { lat, lon, dkm: best, pt: bestPt, ring: strikeRing, escalate });
            }
          }
        }
      }
    }
    if (toSend.size) await this.dispatch(toSend, now);
  }

  async dispatch(toSend, now) {
    const tokens = [...toSend.keys()];
    for (const t of tokens) {
      const info = toSend.get(t);
      const ring = info.ring || 0;
      const s = this.subs.get(t);
      if (s) { s.last = now; s.ring = ring; } // every alert (incl. escalation) resets the cooldown
      this.sql.exec('UPDATE subs SET last=?, ring=? WHERE token=?', now, ring, t);
    }
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
    const ring = info.ring || 0; // 0 nearby, 1 close (escalation), 2 overhead
    const pt = info.pt || null;
    const place = (pt && pt.name) ? pt.name : 'your area';
    // Circle centre = the user's matched point (their area); strike = where it hit.
    const cLat = pt ? pt.lat : info.lat;
    const cLon = pt ? pt.lon : info.lon;
    const radius = pt ? pt.radius : DEFAULT_RADIUS_KM;
    // Compass direction of the strike relative to the user's area centre.
    const dir = (pt && (info.lat !== cLat || info.lon !== cLon))
      ? compass8(bearingDeg(cLat, cLon, info.lat, info.lon)) : '';
    const body = {
      message: {
        token,
        notification: {
          title: isTest ? '⚡ Test alert'
            : ring >= 2 ? ('⚡ Lightning OVERHEAD — ' + place)
            : ring === 1 ? ('⚡ Lightning closing in — ' + place)
            : ('⚡ Lightning near ' + place),
          body: isTest ? 'Lightning alerts are working.'
            : ring >= 2 ? ('Strike ~' + km + ' km ' + (dir ? (dir + ' of ') : 'from ') + place + ' — take cover now.')
            : ring === 1 ? ('Getting closer — strike ~' + km + ' km ' + (dir ? (dir + ' of ') : 'from ') + place + '.')
            : ('Lightning detected ~' + km + ' km ' + (dir ? (dir + ' of ') : 'from ') + place + '.'),
        },
        data: {
          type: 'lightning',
          place: String(place),
          zone_name: String(place),
          mode: 'radius',
          lat: String(cLat),
          lng: String(cLon),
          radius: String(radius),
          slat: String(info.lat),
          slon: String(info.lon),
          dkm: String(km),
          dir: String(dir),
          ring: String(ring),
          ts: String(Date.now()),
        },
        android: { priority: 'high', notification: { sound: 'storm_alert', channel_id: 'lightning_alerts_v1', notification_priority: 'PRIORITY_MAX' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'storm_alert.caf' } } },
      },
    };
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Drop dead tokens so the list stays clean.
      if (r.status === 404) this._remove(token);
      try {
        const e = await r.json();
        const code = e && e.error && (e.error.status || (e.error.details && e.error.details[0] && e.error.details[0].errorCode));
        if (code === 'UNREGISTERED' || code === 'NOT_FOUND') this._remove(token);
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
