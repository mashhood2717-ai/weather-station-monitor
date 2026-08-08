// Cloudflare Worker for Weatherwalay/HubService Station Monitoring

// ============================================================
// ADMIN-ONLY ROUTES
// Maintenance, debug and destructive endpoints. Everything here either mutates
// or deletes data, spends money (email), or exposes HubService credentials by
// proxy. None of them is called by any dashboard.
//
// Fails CLOSED: with ADMIN_TOKEN unset these routes are unreachable rather than
// open, so a missing secret degrades to "maintenance unavailable" instead of
// "anyone can wipe the database".
// ============================================================
// NOT gated, and deliberately so: these are driven by an external cron-job.org
// schedule (Cloudflare's own cron is disabled — `crons = []` in wrangler.toml),
// and that scheduler cannot send an auth header. Gating /api/sync stopped the
// data pipeline dead for ~50 minutes on 2026-08-08; status_logs simply stopped
// growing. They are all INSERT/UPSERT-only, so the exposure is resource use
// rather than data loss:
//   /api/sync                    /api/ingest-station-samples
//   /api/send-daily-report       /api/backfill-downtime
//   /api/backfill-station-samples
// If those move to authenticated calls later, add them back here.
//
// What stays gated is only what cannot be undone or what leaks credentials:
// the two DELETE routes, the DDL route, and the debug/proxy routes.
const ADMIN_ROUTES = new Set([
  '/api/remove-404-stations',
  '/api/cleanup',
  '/api/drop-redundant-indexes',
  '/api/auth-status',
  '/api/test-hubservice',
  '/api/test-fetch',
  '/api/test-hub-endpoint',
]);

// Length-independent comparison. Returns false on any length mismatch first,
// which is fine — the length of a token is not the secret.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdminRequest(request, url, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided =
    request.headers.get('X-Admin-Token') || url.searchParams.get('admin_token') || '';
  return safeEqual(provided, expected);
}

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

// Cache for JWT tokens (in-memory, will refresh on expiry)
const tokenCache = new Map();

// In-memory cache for HubService station data (shared across requests within same isolate)
// This avoids duplicate fetches when multiple endpoints need the same data
let hubStationCache = { data: null, fetchedAt: 0 };
const HUB_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL
// Last COMPLETE station list, kept without expiry as a fallback for when a fetch
// comes back partial (HubService rate limiting). Never overwritten by a partial
// result — that is the whole point of keeping it separate from hubStationCache.
let hubStationLastGood = { data: null, fetchedAt: 0 };
// Beyond this, stale data stops being "better than nothing" and starts being
// misleading — the dashboard would show hours-old readings as if they were live.
const LAST_GOOD_MAX_AGE_MS = 15 * 60 * 1000;

// ============================================================
// API RESPONSE CACHE - Prevents repeated D1 queries for same data
// Cron writes new data every 15 min, so caching for 2 min is safe.
// This alone reduces D1 reads by ~90% under high request volume.
// ============================================================
const apiResponseCache = new Map();
// Entries are whole API responses and the station payload is ~90 KB, so the cap
// is deliberately modest — the working set is a handful of routes.
const API_CACHE_MAX_ENTRIES = 100;
const API_CACHE_EVICT_BATCH = 20;
const API_CACHE_TTL = {
  '/api/dashboard-stats': 600_000,       // 10 min
  '/api/stations-with-uptime': 300_000,  // 5 min — matches the ~5-minute sync cadence
  '/api/uptime-trend-chart': 600_000,    // 10 min
  '/api/uptime-percentages': 600_000,    // 10 min
  '/api/stats': 600_000,                 // 10 min
  '/api/alerts': 600_000,                // 10 min
  '/api/uptime-trend': 600_000,          // 10 min
  '/api/storage-stats': 900_000,         // 15 min
};

function getCachedResponse(cacheKey) {
  const entry = apiResponseCache.get(cacheKey);
  if (entry && (Date.now() - entry.cachedAt) < entry.ttl) {
    return new Response(entry.body, {
      status: entry.status,
      headers: { ...entry.headers, 'X-Cache': 'HIT' },
    });
  }
  apiResponseCache.delete(cacheKey); // expired
  return null;
}

// ============================================================
// EDGE CACHE (shared across isolates)
//
// apiResponseCache above lives in ISOLATE memory. Cloudflare runs many isolates
// per colo and recycles them constantly, so that cache helps far less than it
// looks: measured on production, 8 of 15 sequential requests were misses, each
// paying the full HubService cost (5.5s-59.6s) while hits returned in ~0.8s.
//
// It also made responses inconsistent. Each isolate holds its own copy at its
// own age, so two refreshes seconds apart could be served a fresh response and
// a 10-minute-old one — which reads as "the page won't update".
//
// caches.default is shared by every isolate in the colo, so one fetch warms the
// cache for all of them. The in-memory map stays as a first-level lookup since
// it avoids even the edge round-trip.
// ============================================================
// Cache keys ignore the `t` cache-buster.
//
// The dashboards append ?t=<now> when they want live data. If that param stayed
// in the key, every forced request would write to a key nothing ever reads, the
// canonical entry would keep expiring, and the fast "paint from cache" path
// would be a miss every single time — which is exactly what it was doing.
//
// Reading still respects the buster: presence of `t` skips the lookup entirely.
// Writing always lands on the canonical key, so a background refresh warms the
// cache for the next page load.
function canonicalUrl(url) {
  const u = new URL(url.toString());
  u.searchParams.delete('t');
  return u;
}

function canonicalCacheKey(request, url) {
  const u = canonicalUrl(url);
  return request.method + ':' + u.pathname + u.search;
}

function edgeCacheKey(url) {
  // Cache API keys on the URL. Only GETs are cached — POST bodies are not part
  // of the key, so a shared entry would serve the wrong payload.
  return new Request(canonicalUrl(url).toString(), { method: 'GET' });
}

async function getEdgeCached(request, url) {
  if (request.method !== 'GET') return null;
  try {
    const hit = await caches.default.match(edgeCacheKey(url));
    if (!hit) return null;
    const body = await hit.text();
    const headers = Object.fromEntries(hit.headers.entries());
    // The stored entry carries `Cache-Control: public, max-age=N` — that exists
    // purely so the Cache API expires it. Forwarding it to the browser would add
    // a THIRD cache we don't control: the page would keep serving its own copy
    // for N seconds, so even a reload could miss new data. The Worker decides
    // freshness here, not the browser.
    delete headers['cache-control'];
    delete headers['Cache-Control'];
    return { body, headers };
  } catch {
    return null; // cache trouble must never break the request
  }
}

async function putEdgeCached(request, url, body, headers, ttlMs) {
  if (request.method !== 'GET') return;
  try {
    await caches.default.put(
      edgeCacheKey(url),
      new Response(body, {
        headers: {
          ...headers,
          // Cache API honours this for expiry.
          'Cache-Control': `public, max-age=${Math.floor(ttlMs / 1000)}`,
        },
      })
    );
  } catch {
    // Non-fatal: a failed put just means the next request recomputes.
  }
}

async function cacheAndReturn(cacheKey, ttl, responsePromise, edgeCtx = null) {
  const response = await responsePromise;
  // Never cache a degraded result. It is a 200, but it carries fallback data
  // rather than live data, and caching it turns a momentary upstream blip into
  // ten minutes of blank dashboards.
  if (response.headers.get('X-Degraded') === '1') {
    console.warn(`⚠️ Not caching degraded response for ${cacheKey}`);
    return response;
  }
  // Only cache successful responses
  if (response.status === 200) {
    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    // Bound the map. The key includes the full query string, so any caller
    // sending unique params (a crawler, a cache-busting loop) mints a new entry
    // that lives for the whole TTL — unbounded growth in a 128 MB isolate, with
    // multi-megabyte station payloads as the entries. Evict oldest-first.
    if (apiResponseCache.size >= API_CACHE_MAX_ENTRIES) {
      let evicted = 0;
      for (const key of apiResponseCache.keys()) {
        apiResponseCache.delete(key); // Map preserves insertion order
        if (++evicted >= API_CACHE_EVICT_BATCH) break;
      }
      console.warn(`🧹 Response cache full — evicted ${evicted} oldest entries`);
    }
    apiResponseCache.set(cacheKey, {
      body,
      status: 200,
      headers,
      ttl,
      cachedAt: Date.now(),
    });
    // Populate the shared edge cache too, so the next request on ANY isolate in
    // this colo is a hit rather than another full upstream fetch.
    if (edgeCtx) {
      const put = putEdgeCached(edgeCtx.request, edgeCtx.url, body, headers, ttl);
      if (edgeCtx.ctx?.waitUntil) edgeCtx.ctx.waitUntil(put);
      else await put;
    }
    return new Response(body, { status: 200, headers: { ...headers, 'X-Cache': 'MISS' } });
  }
  return response;
}

// ============================================================
// JWT LIFECYCLE
// HubService issues short-lived JWTs from /ww-Hub/login. Everything below
// exists so an expired token self-heals instead of 401ing forever:
//   - expiry is read from the `exp` claim with base64URL-safe decoding
//   - a token whose `exp` we cannot read is trusted briefly, never for 24h
//   - concurrent callers share one in-flight login instead of stampeding /login
//   - hubFetch() invalidates + re-logins + replays once when HubService 401s
// ============================================================
const TOKEN_CACHE_KEY = 'hubservice_jwt';
// Floor between forced re-logins, so a burst of 401s cannot become a login storm.
let lastForcedRefreshAt = 0;
const FORCED_REFRESH_COOLDOWN_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;  // renew this long before `exp`
const TOKEN_FALLBACK_TTL_MS = 15 * 60 * 1000;  // only when `exp` is unreadable

// Single in-flight login shared by all concurrent callers in this isolate.
let tokenRefreshInFlight = null;

// JWT payloads are base64URL ("-" / "_", padding stripped). Bare atob() throws
// InvalidCharacterError on those characters, which previously fell through to an
// "assume 24 hours" fallback and cached an already-expired token for a full day.
function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const json = decodeURIComponent(
    atob(b64)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
  return JSON.parse(json);
}

// Absolute ms-epoch at which this token stops being valid, or null if undatable.
function getTokenExpiry(token) {
  try {
    const payload = decodeJwtPayload(token);
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch (e) {
    console.warn('Could not parse JWT expiry:', e.message);
  }
  return null;
}

function cacheToken(token) {
  const exp = getTokenExpiry(token);
  // Unreadable `exp` → short TTL so we re-login soon rather than trust it blindly.
  const expiresAt = exp === null
    ? Date.now() + TOKEN_FALLBACK_TTL_MS
    : exp - TOKEN_EXPIRY_BUFFER_MS;
  tokenCache.set(TOKEN_CACHE_KEY, { token, expiresAt, exp });
  const secs = Math.floor((expiresAt - Date.now()) / 1000);
  console.log(exp === null
    ? `⚠️ Cached JWT with unreadable exp; re-checking in ${secs}s`
    : `✅ Cached JWT, refreshing in ${secs}s`);
  return token;
}

// Cached token, or null when absent/expired. Evicts on the way out.
function getCachedToken() {
  const cached = tokenCache.get(TOKEN_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (cached) tokenCache.delete(TOKEN_CACHE_KEY);
  return null;
}

function invalidateToken(reason) {
  if (tokenCache.delete(TOKEN_CACHE_KEY)) {
    console.warn(`🗑️ Discarded cached JWT: ${reason}`);
  }
}

// ============================================================
// ENCRYPTED ENVELOPE (RSA + AES-GCM)
// HubService no longer accepts plaintext Basic auth or Bearer JWTs. Every
// request carries an RSA+AES encrypted envelope, and the session is a cookie:
//   Authorization: Basic <envelope("we@therwalay-<ms>:<basicPassword>")>   [fresh per request]
//   Cookie:        hub_access_token=<jwt>                                  [from /ww-Hub/login]
//
// Envelope layout (must match the server's decryptor byte-for-byte):
//   AES-256-GCM(plaintext) with a random 32-byte key + 12-byte IV; the 16-byte
//   GCM tag is appended to the ciphertext (WebCrypto does this natively). The
//   AES key is wrapped with RSA-OAEP/SHA-256 under the hub's public key. Then:
//     [ wrappedKeyLen (2B big-endian) | wrappedKey | iv (12B) | ciphertext+tag ]
//   base64-encoded.
// ============================================================
const HUB_BASE_URL = 'https://hubservice.weatherwalay.com';
const HUB_BASIC_USER_PREFIX = 'we@therwalay-';
const SESSION_COOKIE_NAME = 'hub_access_token';

// App-level Basic password. NOT a secret: it ships in cleartext inside the public
// frontend bundles (wwhub/b2b `getRotatingAuthToken`), so it is defaulted here and
// only overridden if HUBSERVICE_BASIC_PASSWORD is set. Keeping the default matters
// because the '#' makes it hostile to .dev.vars — wrangler's dotenv parser truncates
// at '#' even inside quotes, silently yielding "we@therwalay_dev" and a 401.
const HUB_APP_BASIC_PASSWORD = 'we@therwalay_dev#7780';

// Ceiling on any single HubService call. Their throttling stalls connections
// instead of rejecting them, and Workers' fetch never times out on its own, so
// this is the only thing bounding a request that would otherwise hang forever.
// Sized for the real payload, not for a ping. The station pages request
// socketLastUpdate.servicesResponses, which is ~1.5 MB per page — about 9 MB
// across the 6 pages — and takes ~500ms/page from a healthy connection. 8s was
// too tight the moment HubService slowed down, and every request then failed
// with TimeoutError and fell through to the Unknown/offline fallback.
const HUB_FETCH_TIMEOUT_MS = 20000;
// The whole station-list fetch (login + 6 pages + retries) must fit in this, so
// a degraded HubService costs one slow response rather than a dead endpoint.
// Kept well under a minute. HubService throttles Cloudflare egress, so retries
// can stack: one measured page load took 60.7s against ~80ms for the same pages
// from a laptop. Nothing waits on this interactively any more — dashboards paint
// from cache and refresh in the background — so a tighter ceiling only costs
// freshness on a bad cycle, never a blank screen.
const HUB_TOTAL_BUDGET_MS = 25000;

// Imported RSA public key, cached per isolate (importKey is not free).
let hubPublicKeyPromise = null;

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Accepts an SPKI PEM, optionally with literal "\n" escapes (env-var friendly).
function importHubPublicKey(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('HUBSERVICE_PUBLIC_KEY is empty');
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(body),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
}

function getHubPublicKey(env) {
  if (!env.HUBSERVICE_PUBLIC_KEY) {
    throw new Error('HUBSERVICE_PUBLIC_KEY is not configured');
  }
  // Cache the promise so concurrent callers share a single import.
  if (!hubPublicKeyPromise) {
    hubPublicKeyPromise = importHubPublicKey(env.HUBSERVICE_PUBLIC_KEY)
      .catch((e) => { hubPublicKeyPromise = null; throw e; });
  }
  return hubPublicKeyPromise;
}

async function encryptEnvelope(plaintext, env) {
  const publicKey = await getHubPublicKey(env);

  // 1) one-time AES-256-GCM key + 12-byte IV
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);

  // 2) encrypt; WebCrypto appends the 16-byte auth tag to the ciphertext
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    new TextEncoder().encode(plaintext)
  ));

  // 3) wrap the raw AES key with RSA-OAEP / SHA-256
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, aesKeyBytes));

  // 4) pack [len(2B BE) | wrappedKey | iv | ciphertext+tag] and base64
  const packed = new Uint8Array(2 + wrappedKey.length + iv.length + ciphertext.length);
  packed[0] = (wrappedKey.length >> 8) & 0xff;
  packed[1] = wrappedKey.length & 0xff;
  packed.set(wrappedKey, 2);
  packed.set(iv, 2 + wrappedKey.length);
  packed.set(ciphertext, 2 + wrappedKey.length + iv.length);
  return bytesToBase64(packed);
}

// Fresh encrypted Basic header. The embedded timestamp rotates every call, so
// this must be rebuilt per request — a cached value is not reusable.
async function buildEncryptedBasicAuth(env) {
  const appPassword = env.HUBSERVICE_BASIC_PASSWORD || HUB_APP_BASIC_PASSWORD;
  const username = `${HUB_BASIC_USER_PREFIX}${Date.now()}`;
  return `Basic ${await encryptEnvelope(`${username}:${appPassword}`, env)}`;
}

// Pull hub_access_token out of Set-Cookie. getSetCookie() is the correct API for
// multiple Set-Cookie headers; fall back to the folded single header if absent.
function extractSessionJwt(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const c of cookies) {
    const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(c);
    if (m) return m[1];
  }
  return null;
}

// POST /ww-Hub/login with the encrypted envelope; returns the session JWT.
async function loginForToken(env) {
  // HUBSERVICE_BASIC_AUTH holds the account credential as "loginParam:password".
  if (String(env.HUBSERVICE_BASIC_AUTH || '').indexOf(':') < 1) {
    console.error('HUBSERVICE_BASIC_AUTH must be formatted "loginParam:password"');
    return null;
  }
  const result = await hubLogin(env, String(env.HUBSERVICE_BASIC_AUTH));
  if (!result.ok) {
    console.error(`Login failed: ${result.status} ${result.msg}`);
    return null;
  }
  return cacheToken(result.token);
}

// Perform one /ww-Hub/login for an arbitrary "loginParam:password" credential.
// Shared by the Worker's own session and by the /api/login browser proxy, so both
// stay on exactly one implementation of the envelope handshake.
// Returns { ok, token, body, status, msg } and never caches (the proxy logs in as
// other users, whose sessions must not land in the Worker's shared token cache).
async function hubLogin(env, credentialString) {
  const credentials = await encryptEnvelope(credentialString, env);

  console.log('🔐 Requesting new session from HubService (encrypted envelope)...');
  const response = await fetch(`${HUB_BASE_URL}/ww-Hub/login`, {
    method: 'POST',
    // Same reasoning as hubFetch: a throttled login stalls rather than failing,
    // and every request funnels through here.
    signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': await buildEncryptedBasicAuth(env),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ credentials })
  });

  // Read the body once; it carries msg/record/accessTo and sometimes the token.
  const body = await response.json().catch(() => null);

  // A rejected *account* password comes back as HTTP 200 with {success:false},
  // while a rejected envelope/app-credential is a 401. Both are auth failures —
  // checking only response.ok reported a bad password as "no token returned".
  if (!response.ok || body?.success === false) {
    return {
      ok: false,
      status: response.ok ? 401 : response.status,
      msg: body?.msg || `HTTP ${response.status}`,
      body,
    };
  }

  // The session arrives as a Set-Cookie; the body also echoes it on this deployment.
  const token = extractSessionJwt(response) || body?.token || body?.accessToken || null;
  if (!token) {
    return {
      ok: false,
      status: response.status,
      msg: `Login succeeded but no ${SESSION_COOKIE_NAME} cookie or body token was returned`,
      body,
    };
  }
  return { ok: true, status: response.status, token, body };
}

// Get a session JWT, reusing the cache and coalescing concurrent logins.
async function getHubServiceToken(env) {
  const cached = getCachedToken();
  if (cached) {
    console.log('🔑 Using cached session JWT');
    return cached;
  }
  // Coalesce: the cron plus several endpoints can miss the cache simultaneously.
  if (!tokenRefreshInFlight) {
    tokenRefreshInFlight = loginForToken(env)
      .catch((error) => {
        console.error('Error getting HubService session:', error);
        return null;
      })
      .finally(() => { tokenRefreshInFlight = null; });
  }
  return tokenRefreshInFlight;
}

// The single decision point for obtaining a session.
// forceRefresh bypasses the cache and is used after HubService rejects a token.
async function getValidToken(env, { forceRefresh = false } = {}) {
  if (forceRefresh) {
    // Throttle forced re-logins. When HubService rejects or stalls requests,
    // every in-flight call lands here and mints another login — which is more
    // load on the thing already refusing us, and turns a brief upstream wobble
    // into a self-sustaining one. Within the cooldown, reuse whatever is cached
    // and let the caller surface the failure instead.
    const sinceLast = Date.now() - lastForcedRefreshAt;
    if (sinceLast < FORCED_REFRESH_COOLDOWN_MS) {
      const cached = getCachedToken();
      if (cached) {
        console.warn(`⏳ Forced refresh suppressed (${sinceLast}ms since last) — reusing cached session`);
        return cached;
      }
    } else {
      lastForcedRefreshAt = Date.now();
      invalidateToken('forced refresh');
    }
  } else {
    const cached = getCachedToken();
    if (cached) return cached;
  }

  if (env.HUBSERVICE_BASIC_AUTH) {
    const token = await getHubServiceToken(env);
    if (token) return token;
    console.error('Login failed; falling back to static session JWT if usable');
  }

  // A static JWT cannot refresh itself, so it is only usable while genuinely
  // valid. Handing an expired one back is what caused permanent 401s.
  if (env.HUBSERVICE_JWT) {
    const exp = getTokenExpiry(env.HUBSERVICE_JWT);
    if (exp !== null && exp - TOKEN_EXPIRY_BUFFER_MS <= Date.now()) {
      console.error(
        `❌ HUBSERVICE_JWT expired at ${new Date(exp).toISOString()} and cannot self-refresh. ` +
        'Set HUBSERVICE_BASIC_AUTH + HUBSERVICE_BASIC_PASSWORD + HUBSERVICE_PUBLIC_KEY so the Worker mints its own sessions.'
      );
      return null;
    }
    if (!env.HUBSERVICE_BASIC_AUTH) {
      console.warn('⚠️ Using static HUBSERVICE_JWT (no auto-refresh configured)');
    }
    return cacheToken(env.HUBSERVICE_JWT);
  }

  // Distinguish "nothing configured" from "configured but rejected" — conflating the
  // two sent us hunting for a missing secret when the credential was simply wrong.
  if (env.HUBSERVICE_BASIC_AUTH) {
    console.error(
      '❌ Could not obtain a session: HubService rejected the login. Verify HUBSERVICE_BASIC_AUTH ' +
      '("loginParam:password"), HUBSERVICE_BASIC_PASSWORD, and that HUBSERVICE_PUBLIC_KEY is the ' +
      "hub's current key. NOTE: in .dev.vars a value containing '#' must be quoted or dotenv " +
      'truncates it at the # as a comment.'
    );
  } else {
    console.error('❌ No HubService credentials configured (need HUBSERVICE_BASIC_AUTH)');
  }
  return null;
}

// Authenticated HubService fetch. Sends a FRESH encrypted Basic header plus the
// session cookie. On 401/403 it discards the session, logs in again, and replays
// the request once — this is what lets an expired session self-heal.
async function hubFetch(env, url, init = {}) {
  const token = await getValidToken(env);
  if (!token) throw new Error('No valid session token available');

  const send = async (jwt) => fetch(url, {
    ...init,
    // HARD TIMEOUT — do not remove.
    // When HubService throttles us it does NOT reply 429 on these routes; nginx
    // holds the connection open. Workers' fetch has no default timeout, so an
    // untimed call waits indefinitely and takes the whole request with it. That
    // is exactly how /api/stations-with-uptime went from 1s to hanging past 90s
    // while HubService was answering other callers in 60ms.
    signal: init.signal || AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
    headers: {
      ...(init.headers || {}),
      // Rebuilt per attempt: the envelope embeds a rotating timestamp.
      'Authorization': await buildEncryptedBasicAuth(env),
      'Cookie': `${SESSION_COOKIE_NAME}=${jwt}`
    }
  });

  const response = await send(token);
  if (response.status !== 401 && response.status !== 403) return response;

  invalidateToken(`HubService returned ${response.status}`);
  const fresh = await getValidToken(env, { forceRefresh: true });
  // Nothing new to try (no refreshable credential) → surface the original error.
  if (!fresh || fresh === token) return response;

  console.log('♻️ Retrying HubService request with refreshed session');
  return send(fresh);
}

// Helper function to convert Fahrenheit to Celsius
function fahrenheitToCelsius(fahrenheit) {
  if (fahrenheit === null || fahrenheit === undefined) return null;
  return Math.round((fahrenheit - 32) * 5 / 9 * 10) / 10; // Round to 1 decimal
}

// Normalize apiSource: auto-detect correct source for stations with missing/incorrect values
const VALID_SOURCES = new Set(['Davis', 'Misol', 'WU']);
function normalizeApiSource(station) {
  const raw = station.apiSource;
  // If already a known valid source, return as-is
  if (raw && VALID_SOURCES.has(raw)) return raw;

  // Try apiType field (often correct even when apiSource is wrong)
  if (station.apiType && VALID_SOURCES.has(station.apiType)) return station.apiType;

  // ownedBy === 'WU' → Weather Underground
  if (station.ownedBy === 'WU') return 'WU';

  // WU station IDs follow pattern: starts with "I" followed by uppercase letter (e.g. IKARAC25)
  const sid = String(station.stationID || '');
  if (/^I[A-Z]/.test(sid)) return 'WU';

  // Default: most WeatherWalay stations with numeric IDs are Davis
  return 'Davis';
}

// ============================================================
// NOWCAST FALLBACK — the only source of rain/wind for Misol stations
//
// /wms/stations returns `socketLastUpdate.servicesResponses`, which carries the
// raw upstream payload for Davis (rainfall_daily_mm) and WU (imperial.precipTotal).
// Misol stations get NO weather in that array — their entries are either `null` or
// bare {_id,date,time,timestamp} stubs — so the parser below always yielded null and
// the dashboard showed "-" for all 13 active Misol gauges even though HubService had
// the data. It lives on a different route:
//
//   POST /wms/recentStats/all-recent-data  {"stationID":"C13"}
//     -> record[0].nowcast.rainfall  (mm, daily accumulation)
//     -> record[0].nowcast.windGust  (km/h)
//
// Verified 2026-08-07 against stations where BOTH sources exist: nowcast.rainfall
// and nowcast.windGust match the servicesResponses parse exactly (Davis 224681
// 0.6/0.6mm and 6.4/6.44km/h, WU IKUNRI2 0/0mm and 17.7/17.7km/h). So this is the
// same measurement, not a model estimate — safe to use as a drop-in fallback.
//
// NOTE the field choice: nowcast.windSpeed is the *average* and does NOT match
// (2.41 vs 6.4). windGust is the metric this dashboard already reports.
// ============================================================
const NOWCAST_URL = 'https://hubservice.weatherwalay.com/wms/recentStats/all-recent-data';
// This route is rate limited to 10 requests per window, counted separately from
// /wms/stations. Stay under it: 5 at a time, with a pause between batches.
const NOWCAST_BATCH_SIZE = 5;
const NOWCAST_BATCH_PAUSE_MS = 300;
// Only 13 stations need this today. The cap stops a HubService change that nulls
// every servicesResponse from turning one sync into 294 subrequests (Workers caps
// subrequests per invocation, and we already spend 6 on the station pages).
const NOWCAST_MAX_STATIONS = 30;
// Wall-clock ceiling for the whole fallback.
const NOWCAST_BUDGET_MS = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One nowcast lookup. Returns { rainfall, windSpeed } — either may be null.
async function fetchNowcastFor(env, stationID) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await hubFetch(env, NOWCAST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationID: String(stationID) })
    });

    // 429 is expected under burst; the window is ~1s, so one honoured retry clears it.
    if (response.status === 429 && attempt === 0) {
      const retryAfter = parseFloat(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 1500) : 800);
      continue;
    }
    if (!response.ok) {
      console.warn(`Nowcast for ${stationID}: HTTP ${response.status}`);
      return { rainfall: null, windSpeed: null, rateLimited: response.status === 429 };
    }

    const data = await response.json().catch(() => null);
    const nowcast = data?.record?.[0]?.nowcast;
    if (!nowcast) return { rainfall: null, windSpeed: null };

    const num = (v) => {
      if (v === undefined || v === null || v === 'N/A') return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };
    return { rainfall: num(nowcast.rainfall), windSpeed: num(nowcast.windGust) };
  }
  return { rainfall: null, windSpeed: null };
}

// Fill rainfall/windSpeed for stations the servicesResponses parse could not resolve.
// Mutates the records in place; failures leave the existing nulls untouched.
async function applyNowcastFallback(env, stations) {
  // Offline stations have no current reading to report, so spending a rate-limited
  // request on them would only surface a stale number.
  const needsNowcast = stations.filter(
    (s) => s.status === 'Active' && (s.rainfall === null || s.windSpeed === null)
  );
  if (needsNowcast.length === 0) return 0;

  const targets = needsNowcast.slice(0, NOWCAST_MAX_STATIONS);
  if (needsNowcast.length > targets.length) {
    console.warn(`⚠️ ${needsNowcast.length} stations need nowcast; capped at ${NOWCAST_MAX_STATIONS}`);
  }

  let filled = 0;
  // This is a nice-to-have on a latency-critical path: rainfall for a handful of
  // Misol stations must never be the reason the whole station list is late.
  const deadline = Date.now() + NOWCAST_BUDGET_MS;
  for (let i = 0; i < targets.length; i += NOWCAST_BATCH_SIZE) {
    if (Date.now() > deadline) {
      console.warn('⏱️ Nowcast budget exhausted — remaining stations keep their nulls');
      break;
    }
    const batch = targets.slice(i, i + NOWCAST_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((s) =>
        fetchNowcastFor(env, s.stationID).catch((e) => {
          console.warn(`Nowcast for ${s.stationID} failed:`, e.message);
          return { rainfall: null, windSpeed: null };
        })
      )
    );
    batch.forEach((station, idx) => {
      const { rainfall, windSpeed } = results[idx];
      // Never overwrite a value servicesResponses already gave us.
      if (station.rainfall === null && rainfall !== null) { station.rainfall = rainfall; filled++; }
      if (station.windSpeed === null && windSpeed !== null) station.windSpeed = windSpeed;
    });

    // Circuit breaker. If a whole batch came back rate limited, the window is
    // saturated and grinding through the rest just burns seconds for nothing —
    // and that added latency is what widens the window in which concurrent
    // station-list fetches collide and get truncated. Bail and keep the nulls.
    if (results.every((r) => r.rateLimited)) {
      console.warn('⏭️ Nowcast rate limited across a full batch — skipping the rest this cycle');
      break;
    }

    if (i + NOWCAST_BATCH_SIZE < targets.length) await sleep(NOWCAST_BATCH_PAUSE_MS);
  }

  console.log(`🌧️ Nowcast fallback: filled rainfall for ${filled}/${targets.length} stations`);
  return filled;
}

// Station-page fetch with 429 handling.
//
// /wms/stations is rate limited to ~10 requests per short window, counted per
// route. One dashboard load spends 6 of those, so two concurrent cache misses
// are already enough to start getting 429s on the later pages. Without this
// retry the caller silently dropped 50 stations per rejected page.
const HUB_PAGE_ATTEMPTS = 3;
async function hubPageFetch(env, url, page) {
  let response;
  for (let attempt = 1; attempt <= HUB_PAGE_ATTEMPTS; attempt++) {
    try {
      response = await hubFetch(env, url);
    } catch (e) {
      // AbortSignal.timeout rejects — a stalled page must not kill the whole
      // fetch, so surface it as a failed page and let the caller decide.
      console.warn(`HubService page ${page} attempt ${attempt} failed: ${e.name || e.message}`);
      if (attempt === HUB_PAGE_ATTEMPTS) return new Response(null, { status: 504 });
      await sleep(500 * attempt);
      continue;
    }
    if (response.status !== 429) return response;

    if (attempt < HUB_PAGE_ATTEMPTS) {
      const retryAfter = parseFloat(response.headers.get('retry-after'));
      // Back off a little further each attempt, and add jitter so concurrent
      // isolates don't retry in lockstep and collide again on the same window.
      const base = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 3000) : 1000;
      await sleep(base * attempt + Math.random() * 250);
      console.warn(`↻ Retrying HubService page ${page} after 429 (attempt ${attempt + 1}/${HUB_PAGE_ATTEMPTS})`);
    }
  }
  return response;
}

// ============================================================
// TWO-TIER STATION FETCH
//
// The station list used to be requested with `socketLastUpdate: 1`, which drags
// in socketLastUpdate.servicesResponses — the raw upstream payload per station.
// That is ~1.5 MB per page, ~9 MB for the six pages, and it is 99% of the bytes.
// Everything the dashboard actually shows except rainfall and wind comes from a
// handful of scalar fields.
//
// Measured against the live API:
//     socketLastUpdate.temp only          12 KB/page,   68 ms
//     ...plus servicesResponses         1569 KB/page,  545 ms
//
// So the identity/status/temperature fetch is now LIGHT, and the rain/wind data
// is fetched separately on a slower cycle. The point is not just speed: when
// HubService slows down, a 9 MB read is the first thing to time out, and that
// was taking the whole endpoint with it — every station came back Unknown and
// offline because one oversized request missed its deadline.
//
// HubService supports dotted sub-field projection; verified 2026-08-08.
// ============================================================
const HUB_LIGHT_FIELDS = JSON.stringify({
  // Verified 2026-07-28: HubService returns `long`, not `lng`. Both are requested
  // so a rename upstream cannot silently drop coordinates; readers use `lng ?? long`.
  stationID: 1, stationName: 1, poi: 1, lat: 1, lng: 1, long: 1,
  status: 1, apiSource: 1, apiType: 1, ownedBy: 1, 'socketLastUpdate.temp': 1,
});
const HUB_RAINWIND_FIELDS = JSON.stringify({
  stationID: 1, 'socketLastUpdate.servicesResponses': 1,
});

// stationID -> { rainfall, windSpeed }. Refreshed on its own schedule and kept
// across failures: stale rain totals are far better than a dead station list.
let hubRainWind = { map: new Map(), fetchedAt: 0, nextAttemptAt: 0 };
const RAINWIND_TTL_MS = 10 * 60 * 1000;
// After a failure, wait before paying the cost again rather than making every
// request re-attempt an expensive read that is currently failing.
const RAINWIND_FAIL_BACKOFF_MS = 5 * 60 * 1000;

// Paginated station fetch shared by both tiers.
async function fetchStationPages(env, fields, label, budgetMs) {
  const records = [];
  let failedPages = 0;
  const deadline = Date.now() + budgetMs;

  for (let page = 1; page <= 6; page++) {
    // Stop rather than pile more retries onto an already-slow HubService.
    if (Date.now() > deadline) {
      console.warn(`⏱️ ${label} fetch budget exhausted at page ${page}`);
      failedPages += (7 - page);
      break;
    }
    const response = await hubPageFetch(
      env,
      `https://hubservice.weatherwalay.com/wms/stations?page=${page}&limit=50&filter={}&search={}&fields=${encodeURIComponent(fields)}&globalSearch=`,
      page
    );
    if (!response.ok) {
      console.warn(`HubService ${label} page ${page} error: ${response.status}`);
      failedPages++;
      continue;
    }
    const data = await response.json();
    if (data.record && Array.isArray(data.record)) records.push(...data.record);
  }
  return { records, failedPages };
}

// Pull rainfall + wind out of one station's servicesResponses. Unchanged logic,
// lifted out so both the heavy refresh and any future caller share it.
function parseRainWind(station) {
  let rainfall = null;
  let windSpeed = null;
  const responses = station.socketLastUpdate?.servicesResponses;
  if (!Array.isArray(responses) || responses.length === 0) return { rainfall, windSpeed };

  // Walk backwards: the last entry is the most recent reading.
  for (let i = responses.length - 1; i >= 0 && (rainfall === null || windSpeed === null); i--) {
    const svcResp = responses[i];

    // Davis: response is an array of readings.
    if (svcResp.response && Array.isArray(svcResp.response) && svcResp.response.length > 0) {
      const reading = svcResp.response[0];
      if (rainfall === null && reading.rainfall_daily_mm !== undefined && reading.rainfall_daily_mm !== null) {
        rainfall = reading.rainfall_daily_mm;
      }
      // Highest gust in the last 10 min, mph -> km/h.
      if (windSpeed === null && reading.wind_speed_hi_last_10_min !== undefined && reading.wind_speed_hi_last_10_min !== null) {
        windSpeed = parseFloat((reading.wind_speed_hi_last_10_min * 1.60934).toFixed(1));
      }
    }

    // WU: response.observations[0].imperial.
    if ((rainfall === null || windSpeed === null) && svcResp.response && Array.isArray(svcResp.response.observations) && svcResp.response.observations.length > 0) {
      const obs = svcResp.response.observations[0];
      if (obs.imperial) {
        if (rainfall === null && obs.imperial.precipTotal !== undefined && obs.imperial.precipTotal !== null) {
          rainfall = parseFloat((obs.imperial.precipTotal * 25.4).toFixed(1)); // in -> mm
        }
        if (windSpeed === null && obs.imperial.windGust !== undefined && obs.imperial.windGust !== null) {
          windSpeed = parseFloat((obs.imperial.windGust * 1.60934).toFixed(1)); // mph -> km/h
        }
      }
    }
  }
  return { rainfall, windSpeed };
}

// Refresh the rain/wind map. Never throws: on failure the previous map is kept
// and retried after a backoff, so a slow HubService costs freshness, not uptime.
async function refreshRainWindIfStale(env) {
  const now = Date.now();
  if (now < hubRainWind.nextAttemptAt) return;
  if (hubRainWind.map.size > 0 && now - hubRainWind.fetchedAt < RAINWIND_TTL_MS) return;

  try {
    const { records, failedPages } = await fetchStationPages(env, HUB_RAINWIND_FIELDS, 'rain/wind', HUB_TOTAL_BUDGET_MS);
    if (failedPages > 0 || records.length === 0) {
      throw new Error(`incomplete rain/wind fetch (${failedPages} pages failed, ${records.length} records)`);
    }
    const map = new Map();
    for (const rec of records) map.set(String(rec.stationID), parseRainWind(rec));
    hubRainWind = { map, fetchedAt: Date.now(), nextAttemptAt: 0 };
    console.log(`🌧️ Rain/wind map refreshed for ${map.size} stations`);
  } catch (e) {
    hubRainWind.nextAttemptAt = Date.now() + RAINWIND_FAIL_BACKOFF_MS;
    const ageMin = hubRainWind.fetchedAt ? Math.floor((Date.now() - hubRainWind.fetchedAt) / 60000) : null;
    console.warn(
      `⚠️ Rain/wind refresh failed (${e.message}); ` +
      (ageMin === null ? 'no previous data' : `keeping ${ageMin}m-old values`) +
      `, retrying in ${RAINWIND_FAIL_BACKOFF_MS / 60000}m`
    );
    // The map lives in isolate memory, so a cold isolate that also fails this
    // fetch has NO rainfall at all and every Rain cell renders "-". D1 already
    // holds what the last successful cycle recorded, so seed from there.
    if (hubRainWind.map.size === 0) await seedRainWindFromD1(env);
  }
}

// Last-resort rain/wind source: the most recent status_logs row per station.
// Deliberately does NOT stamp fetchedAt — this is a stopgap, so the next
// opportunity still goes to HubService for live values.
async function seedRainWindFromD1(env) {
  try {
    const res = await env.DB.prepare(`
      SELECT station_id, rainfall, wind_speed FROM (
        SELECT station_id, rainfall, wind_speed,
               ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) AS rn
        FROM status_logs
        WHERE timestamp >= datetime('now', '-6 hours') AND rainfall IS NOT NULL
      ) WHERE rn = 1
    `).all();

    const map = new Map();
    for (const row of res.results || []) {
      map.set(String(row.station_id), {
        rainfall: row.rainfall ?? null,
        windSpeed: row.wind_speed ?? null,
      });
    }
    if (map.size > 0) {
      hubRainWind.map = map;
      console.log(`🗄️ Rain/wind seeded from D1 for ${map.size} stations`);
    }
  } catch (e) {
    console.warn('D1 rain/wind seed failed:', e.message);
  }
}

// Fetch all stations from HubService API (your main API)
async function fetchAllStationsFromHubService(env) {
  try {
    const { records, failedPages } = await fetchStationPages(env, HUB_LIGHT_FIELDS, 'stations', HUB_TOTAL_BUDGET_MS);

    if (records.length === 0) {
      throw new Error('No stations retrieved from HubService API');
    }

    // A partial page set is NOT a success. This used to `continue` past a failed
    // page and return whatever it had, so a rate-limited fetch produced 100 or 150
    // stations instead of 294 — reported as success, cached for 10 minutes, and
    // served to every dashboard as if the missing stations did not exist.
    // Throwing here hands control to the cached wrapper, which serves the last
    // known-good list rather than a silently truncated one.
    if (failedPages > 0) {
      throw new Error(
        `Incomplete station list: ${failedPages} of 6 pages failed, got only ${records.length} stations`
      );
    }

    // Rain/wind rides its own cache and must never break the station list.
    await refreshRainWindIfStale(env);
    const rainWindFresh = hubRainWind.map.size > 0;

    const allStations = records.map((station) => {
      let temperature = null;
      const rawTemp = station.socketLastUpdate?.temp;
      if (rawTemp !== undefined && rawTemp !== null && rawTemp !== 'N/A') {
        const parsed = parseFloat(rawTemp);
        if (!isNaN(parsed)) temperature = parsed;
      }

      const rw = hubRainWind.map.get(String(station.stationID)) || { rainfall: null, windSpeed: null };

      return {
        ...station,
        apiSource: normalizeApiSource(station),
        temperature,
        rainfall: rw.rainfall,
        windSpeed: rw.windSpeed,
      };
    });

    // Misol stations carry no weather in servicesResponses, so they need the
    // nowcast route. Only run it when the rain/wind map is populated: if that
    // fetch failed, EVERY station reads null and this would fan out across the
    // whole network instead of the ~13 Misol ones, hammering a rate-limited
    // route for nothing.
    if (rainWindFresh) {
      try {
        await applyNowcastFallback(env, allStations);
      } catch (e) {
        console.warn('Nowcast fallback failed:', e.message);
      }
    } else {
      console.warn('⏭️ Skipping nowcast fallback — no rain/wind baseline this cycle');
    }

    console.log(`✅ Fetched ${allStations.length} stations from HubService`);
    return allStations;
  } catch (error) {
    console.error('Error fetching from HubService:', error);
    throw error;
  }
}

// Cached wrapper - reuses data within TTL to avoid redundant HubService calls
async function fetchAllStationsFromHubServiceCached(env) {
  const now = Date.now();
  if (hubStationCache.data && (now - hubStationCache.fetchedAt) < HUB_CACHE_TTL_MS) {
    console.log(`📦 Using cached HubService data (age: ${Math.floor((now - hubStationCache.fetchedAt) / 1000)}s, ${hubStationCache.data.length} stations)`);
    return hubStationCache.data;
  }
  try {
    const data = await fetchAllStationsFromHubService(env);
    hubStationCache = { data, fetchedAt: Date.now() };
    hubStationLastGood = { data, fetchedAt: Date.now() };
    return data;
  } catch (error) {
    // A complete-but-stale list beats a fresh truncated one. Station metadata
    // barely moves, so the worst case here is slightly old temperature/rain
    // readings — versus whole regions vanishing from the dashboard.
    // Bounded staleness. This used to serve the last good list forever with no
    // age check and degraded=false, so once a fetch started failing the
    // dashboard could sit on old readings indefinitely and look fine — the
    // "page won't update even after refresh" symptom. Past the cap we throw, so
    // the caller falls back to D1 and flags the response degraded, which is at
    // least honest about being stale.
    const age = Date.now() - hubStationLastGood.fetchedAt;
    if (hubStationLastGood.data && age < LAST_GOOD_MAX_AGE_MS) {
      console.warn(
        `⚠️ Serving last-good station list (${hubStationLastGood.data.length} stations, ${Math.floor(age / 60000)}m old): ${error.message}`
      );
      return hubStationLastGood.data;
    }
    if (hubStationLastGood.data) {
      console.warn(`⚠️ Last-good station list is ${Math.floor(age / 60000)}m old — too stale to serve`);
    }
    throw error;
  }
}



// Sync stations from HubService API
async function syncNewStations(env) {
  try {
    // Get all stations from HubService API (no token required)
    const apiStations = await fetchAllStationsFromHubServiceCached(env);

    if (apiStations.length === 0) {
      console.log('No stations found from HubService API');
      return { added: 0, stations: [] };
    }

    // Get existing stations from database
    const existingStations = await env.DB.prepare(`
      SELECT station_id FROM stations
    `).all();

    const existingIds = new Set(existingStations.results.map(s => s.station_id.toString()));

    // Transform HubService stations to our format (using new field names: lat, long, temperature, rainfall, status, apiSource, stationName, stationID)
    const newStations = apiStations
      .filter(s => !existingIds.has(s.stationID.toString()))
      .map(s => ({
        stationID: s.stationID,
        stationName: s.stationName,
        status: s.status,
        lat: s.lat,
        lng: s.lng ?? s.long,
        temperature: s.temperature,
        rainfall: s.rainfall,
        apiSource: s.apiSource
      }));

    if (newStations.length === 0) {
      console.log('No new stations to add');
      return { added: 0, stations: [] };
    }

    console.log(`Found ${newStations.length} new stations to add`);

    // Insert all new stations
    const addedStations = [];
    for (const station of newStations) {
      try {
        await env.DB.prepare(`
          INSERT INTO stations (station_id, station_name, location, latitude, longitude, install_date)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          station.stationID,
          station.stationName,
          station.stationName,
          parseFloat(station.lat) || 0,
          parseFloat(station.lng) || 0,
          new Date().toISOString().split('T')[0]
        ).run();

        addedStations.push({ id: station.stationID, name: station.stationName });
      } catch (err) {
        console.warn(`Failed to insert station ${station.stationID}:`, err);
      }
    }

    return {
      added: addedStations.length,
      stations: addedStations
    };
  } catch (error) {
    console.error('Error syncing new stations:', error);
    return { added: 0, stations: [], error: error.message };
  }
}

// Fetch station data from HubService API

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      // Browsers must not hold their own copy. Freshness is decided here — the
      // Worker already runs a two-tier cache — and a browser-side copy on top of
      // that means a reload can serve stale data with no way to force past it.
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Log all API requests to identify mystery callers
      if (path.startsWith('/api/')) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ua = request.headers.get('User-Agent') || 'unknown';
        const referer = request.headers.get('Referer') || 'none';
        console.log(`API_HIT: ${path} | IP: ${ip} | UA: ${ua.substring(0, 80)} | Ref: ${referer}`);
      }

      // ---- Cacheable API Routes (check in-memory cache first) ----
      const cacheTTL = API_CACHE_TTL[path];
      // `?t=` means the caller explicitly wants live data, so skip the lookup.
      // The result is still WRITTEN to the canonical key below, which is what
      // keeps the fast paint path warm for the next page load.
      const forceFresh = url.searchParams.has('t');
      const cacheKey = canonicalCacheKey(request, url);
      if (cacheTTL && !forceFresh) {
        // L1: this isolate's memory — cheapest, but only helps if we land on the
        // same isolate again, which is roughly half the time.
        const cached = getCachedResponse(cacheKey);
        if (cached) return cached;
        // L2: the colo-wide edge cache — one upstream fetch now serves every
        // isolate here, which is what removes the 5-60s cold-start responses.
        const edge = await getEdgeCached(request, url);
        if (edge) {
          // Refill L1 so repeat hits on this isolate skip the edge lookup too.
          apiResponseCache.set(cacheKey, {
            body: edge.body, status: 200, headers: edge.headers, ttl: cacheTTL, cachedAt: Date.now(),
          });
          return new Response(edge.body, { status: 200, headers: { ...edge.headers, 'X-Cache': 'EDGE' } });
        }
      }
      // Passed to cacheAndReturn so successful responses populate the edge cache.
      const edgeCtx = { request, url, ctx };

      // API Routes
      // Build cache key matching early lookup: method:path+search
      const routeCacheKey = cacheKey; // canonical: ignores the ?t= buster

      // ---- Admin guard ----
      // These routes had no authentication and no method check, on a Worker URL
      // that ships in the public dashboard JavaScript. A plain GET was enough to
      // DELETE FROM status_logs / station_samples / downtime_records
      // (/api/cleanup), delete station rows (/api/remove-404-stations), drop D1
      // indexes (/api/drop-redundant-indexes), send the report to the whole
      // mailing list (/api/send-daily-report), or proxy arbitrary HubService
      // paths using the Worker's own credentials (/api/test-hub-endpoint).
      //
      // No dashboard calls any of them, so gating them changes nothing for users.
      if (ADMIN_ROUTES.has(path) && !isAdminRequest(request, url, env)) {
        // 404, not 401 — an unauthenticated caller should not learn these exist.
        return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ---- Login proxy ----
      // The browser cannot log in to HubService directly: HubService only returns
      // Access-Control-Allow-Origin for its own allowlisted origin (wwhub), and the
      // login now needs an RSA+AES envelope. Both are solved by doing it here — the
      // Worker is same-origin-friendly (corsHeaders below) and already holds the key.
      if (path === '/api/login' && request.method === 'POST') {
        const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
          status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        let creds;
        try {
          creds = await request.json();
        } catch {
          return json({ success: false, msg: 'Invalid JSON body' }, 400);
        }
        const loginParam = String(creds?.loginParam ?? '').trim();
        const password = String(creds?.password ?? '');
        if (!loginParam || !password) {
          return json({ success: false, msg: 'loginParam and password are required' }, 400);
        }
        try {
          const result = await hubLogin(env, `${loginParam}:${password}`);
          if (!result.ok) {
            return json({ success: false, msg: result.msg || 'Auth not matched' }, result.status || 401);
          }
          // HubService echoes the user's password back in `record`. Never relay it.
          const record = { ...(result.body?.record || {}) };
          delete record.password;
          return json({
            success: true,
            msg: result.body?.msg || 'Login Successfull',
            token: result.token,
            record,
            accessTo: result.body?.accessTo || [],
          });
        } catch (e) {
          console.error('Login proxy error:', e);
          return json({ success: false, msg: 'Login service unavailable' }, 502);
        }
      }

      if (path === '/api/stations-with-uptime') {
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleStationsWithUptimeRequest(env, corsHeaders), edgeCtx);
      }
      if (path === '/api/stations') {
        return await handleStationsRequest(env, corsHeaders);
      } else if (path === '/api/stats') {
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleStatsRequest(env, corsHeaders), edgeCtx);
      } else if (path === '/api/alerts') {
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleAlertsRequest(env, corsHeaders), edgeCtx);
      } else if (path === '/api/station') {
        const stationId = url.searchParams.get('id');
        return await handleStationDetailRequest(env, stationId, corsHeaders);
      } else if (path === '/api/sync') {
        // Manual trigger for testing
        return await syncAllStations(env, corsHeaders);
      } else if (path === '/api/uptime-trend') {
        // Get 24-hour uptime trend for all stations
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleUptimeTrendRequest(env, corsHeaders), edgeCtx);
      } else if (path === '/api/uptime-percentages') {
        // Get uptime percentages for all stations or specific ones
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleUptimePercentagesRequest(env, request, corsHeaders), edgeCtx);
      } else if (path === '/api/ingest-station-samples') {
        // Aggregate recent status_logs into hourly samples and persist
        return await handleIngestStationSamples(env, corsHeaders);
      } else if (path === '/api/backfill-station-samples') {
        return await handleBackfillStationSamples(env, url, corsHeaders);
      } else if (path.startsWith('/api/station-samples/')) {
        const stationId = path.replace('/api/station-samples/', '');
        return await handleStationSamplesRequest(env, stationId, url, corsHeaders);
      } else if (path.startsWith('/api/station-history/')) {
        // Get detailed history for a specific station
        const stationId = path.replace('/api/station-history/', '');
        return await handleStationHistoryRequest(env, stationId, url, corsHeaders);
      } else if (path === '/api/remove-404-stations') {
        // Remove stations that return 404 errors
        return await handleRemove404Stations(env, corsHeaders);
      } else if (path === '/api/cleanup') {
        // Manual cleanup - delete logs older than N days (default 180 = 6 months)
        const days = parseInt(url.searchParams.get('days')) || 180;
        const deleted = await cleanupOldLogs(env, days);
        return new Response(JSON.stringify({ success: true, deleted, days_kept: days }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/api/drop-redundant-indexes') {
        // Drop 3 redundant indexes to save ~60% storage
        // Keep only idx_status_logs_station_timestamp and idx_status_logs_ts_station_online
        try {
          await env.DB.batch([
            env.DB.prepare('DROP INDEX IF EXISTS idx_status_logs_station'),
            env.DB.prepare('DROP INDEX IF EXISTS idx_status_logs_timestamp'),
            env.DB.prepare('DROP INDEX IF EXISTS idx_status_logs_online'),
          ]);
          return new Response(JSON.stringify({ success: true, message: 'Dropped 3 redundant indexes. Run VACUUM via wrangler to reclaim space.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } else if (path === '/api/auth-status') {
        // Diagnose HubService auth without exposing the token itself.
        // ?refresh=1 forces a fresh login instead of reporting the cached token.
        const staticExp = env.HUBSERVICE_JWT ? getTokenExpiry(env.HUBSERVICE_JWT) : undefined;
        const cachedEntry = tokenCache.get(TOKEN_CACHE_KEY);
        const force = url.searchParams.get('refresh') === '1';
        let live = null;
        try {
          const token = await getValidToken(env, { forceRefresh: force });
          if (token) {
            const probe = await hubFetch(env, 'https://hubservice.weatherwalay.com/wms/stations?page=1&limit=1&filter={}&search={}&fields={"stationID":1}&globalSearch=');
            live = { tokenAcquired: true, stationsProbeStatus: probe.status, ok: probe.ok };
          } else {
            live = { tokenAcquired: false, reason: 'no usable credential — see below' };
          }
        } catch (e) {
          live = { tokenAcquired: false, error: e.message };
        }
        const after = tokenCache.get(TOKEN_CACHE_KEY);
        return new Response(JSON.stringify({
          authScheme: 'RSA-OAEP(SHA-256) + AES-256-GCM encrypted envelope; session via hub_access_token cookie',
          // Shapes only, never values — catches truncation/quoting damage to secrets.
          secretShapes: {
            basicAuthLen: (env.HUBSERVICE_BASIC_AUTH || '').length,
            basicAuthHasColon: String(env.HUBSERVICE_BASIC_AUTH || '').includes(':'),
            basicPasswordLen: (env.HUBSERVICE_BASIC_PASSWORD || '').length,
            basicPasswordHasHash: String(env.HUBSERVICE_BASIC_PASSWORD || '').includes('#'),
            basicPasswordQuoted: /^["']|["']$/.test(String(env.HUBSERVICE_BASIC_PASSWORD || '')),
            publicKeyLen: (env.HUBSERVICE_PUBLIC_KEY || '').length,
            publicKeyHasRealNewlines: String(env.HUBSERVICE_PUBLIC_KEY || '').includes('\n'),
          },
          credentials: {
            HUBSERVICE_BASIC_AUTH: env.HUBSERVICE_BASIC_AUTH ? 'set (account "loginParam:password")' : 'NOT SET',
            HUBSERVICE_BASIC_PASSWORD: env.HUBSERVICE_BASIC_PASSWORD ? 'set (app Basic password)' : 'NOT SET',
            HUBSERVICE_PUBLIC_KEY: env.HUBSERVICE_PUBLIC_KEY
              ? (await getHubPublicKey(env).then(() => 'set (valid SPKI, imported OK)').catch((e) => `set but INVALID: ${e.message}`))
              : 'NOT SET',
            HUBSERVICE_JWT: env.HUBSERVICE_JWT
              ? {
                  state: 'set (static, cannot self-refresh)',
                  expiresAt: staticExp === null ? 'unreadable exp claim' : new Date(staticExp).toISOString(),
                  expired: staticExp !== null && staticExp <= Date.now(),
                }
              : 'NOT SET',
          },
          cachedTokenBefore: cachedEntry
            ? { refreshAt: new Date(cachedEntry.expiresAt).toISOString(), expiresAt: cachedEntry.exp ? new Date(cachedEntry.exp).toISOString() : 'unknown' }
            : null,
          cachedTokenAfter: after
            ? { refreshAt: new Date(after.expiresAt).toISOString(), expiresAt: after.exp ? new Date(after.exp).toISOString() : 'unknown' }
            : null,
          liveCheck: live,
          forcedRefresh: force,
          // Only the genuinely required ones. HUBSERVICE_BASIC_PASSWORD is optional —
          // it falls back to HUB_APP_BASIC_PASSWORD, which is the correct public value.
          missingRequiredSecrets: ['HUBSERVICE_BASIC_AUTH', 'HUBSERVICE_PUBLIC_KEY'].filter((k) => !env[k]),
          appBasicPasswordSource: env.HUBSERVICE_BASIC_PASSWORD ? 'env override' : 'code default (expected)',
        }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/api/test-hubservice') {
        // Debug endpoint to test HubService API response
        const stationName = url.searchParams.get('name') || 'saad';
        // Request all fields including socketData
        const apiUrl = `https://hubservice.weatherwalay.com/wms/stations?page=1&limit=5&filter={}&search={"stationName":"${stationName}"}&fields={}&globalSearch=`;
        let resp;
        try {
          resp = await hubFetch(env, apiUrl);
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const data = await resp.json();
        return new Response(JSON.stringify(data, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/api/test-fetch') {
        // Test the fetchAllStationsFromHubService function
        try {
          const stations = await fetchAllStationsFromHubServiceCached(env);
          // Find stations with temperature
          const withTemp = stations.filter(s => s.temperature !== null && s.temperature !== undefined);
          const sample = stations.slice(0, 10).map(s => ({
            stationID: s.stationID,
            stationName: s.stationName,
            temp: s.temp,
            temperature: s.temperature,
            rainfall: s.rainfall
          }));
          return new Response(JSON.stringify({
            total: stations.length,
            withTempCount: withTemp.length,
            sample
          }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } else if (path === '/api/test-hub-endpoint') {
        // Debug: proxy any HubService endpoint with auth to discover API surface
        const ep = url.searchParams.get('ep') || '/wms/livedata';
        const sid = url.searchParams.get('sid') || 'C14';
        // Defence in depth behind the admin guard: keep this pointed at
        // HubService. Without the check a value like "//evil.example.com/x" or
        // one containing "@" re-targets the URL, and the Worker would send its
        // encrypted credentials to whatever host was named.
        if (!/^\/[A-Za-z0-9\-._~/]*$/.test(ep) || ep.startsWith('//') || ep.includes('..')) {
          return new Response(JSON.stringify({ error: 'Invalid ep: must be a plain HubService path' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // /ww-Hub/ routes take only the encrypted Basic envelope (no session cookie);
        // everything else goes through hubFetch, which adds the cookie too.
        const isBasicRoute = ep.startsWith('/ww-Hub/');
        const tryUrls = [
          `https://hubservice.weatherwalay.com${ep}?stationID=${sid}`,
          `https://hubservice.weatherwalay.com${ep}/${sid}`,
        ];
        const results = [];
        for (const u of tryUrls) {
          try {
            const r = isBasicRoute
              ? await fetch(u, { headers: { 'Authorization': await buildEncryptedBasicAuth(env) } })
              : await hubFetch(env, u);
            const body = await r.text();
            results.push({ url: u, status: r.status, body: body.substring(0, 2000) });
          } catch (e) {
            results.push({ url: u, error: e.message });
          }
        }
        return new Response(JSON.stringify(results, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/api/storage-stats') {
        // Get storage statistics
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleStorageStats(env, corsHeaders), edgeCtx);
      } else if (path === '/api/daily-report') {
        // Generate daily report JSON
        return await handleDailyReportRequest(env, corsHeaders);
      } else if (path === '/api/daily-report/excel') {
        // Download daily report as Excel/CSV
        return await handleDailyReportExcel(env, corsHeaders);
      } else if (path === '/api/backfill-downtime') {
        // Backfill historical downtime records from status_logs (batched to avoid rate limits)
        try {
          const batchSize = parseInt(url.searchParams.get('batch_size')) || 10;
          const offset = parseInt(url.searchParams.get('offset')) || 0;

          console.log(`Starting downtime backfill batch: offset=${offset}, batch_size=${batchSize}`);

          // Get stations in batches
          const stations = await env.DB.prepare(`
            SELECT station_id FROM stations
            ORDER BY station_id
            LIMIT ? OFFSET ?
          `).bind(batchSize, offset).all();

          if (stations.results.length === 0) {
            return new Response(JSON.stringify({
              success: true,
              message: 'Backfill complete - no more stations to process',
              offset: offset,
              batch_size: batchSize,
              processed: 0
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          let totalRecords = 0;
          let processedStations = 0;

          for (const station of stations.results) {
            const stationId = station.station_id;
            processedStations++;

            // Get all status logs for this station, ordered by timestamp
            const logs = await env.DB.prepare(`
              SELECT timestamp, is_online
              FROM status_logs
              WHERE station_id = ?
              ORDER BY timestamp ASC
            `).bind(stationId).all();

            if (logs.results.length === 0) continue;

            let currentDowntimeStart = null;

            for (let i = 0; i < logs.results.length; i++) {
              const log = logs.results[i];
              const isOnline = log.is_online === 1;

              if (!isOnline && currentDowntimeStart === null) {
                // Station just went offline
                currentDowntimeStart = log.timestamp;
              } else if (isOnline && currentDowntimeStart !== null) {
                // Station just came back online - create downtime record
                const startTime = currentDowntimeStart;
                const endTime = log.timestamp;

                // Calculate duration in minutes
                const start = new Date(startTime);
                const end = new Date(endTime);
                const durationMinutes = Math.floor((end - start) / (1000 * 60));

                // Only create records for outages longer than 15 minutes (avoid noise)
                if (durationMinutes >= 15) {
                  try {
                    await env.DB.prepare(`
                      INSERT OR IGNORE INTO downtime_records
                      (station_id, start_time, end_time, duration_minutes, status)
                      VALUES (?, ?, ?, ?, 'resolved')
                    `).bind(stationId, startTime, endTime, durationMinutes).run();
                    totalRecords++;
                  } catch (e) {
                    // Ignore duplicate key errors
                  }
                }

                currentDowntimeStart = null;
              }
            }

            // Handle case where station is still offline at the end
            if (currentDowntimeStart !== null) {
              // Calculate duration from start to now
              const start = new Date(currentDowntimeStart);
              const now = new Date();
              const durationMinutes = Math.floor((now - start) / (1000 * 60));

              if (durationMinutes >= 15) {
                try {
                  await env.DB.prepare(`
                    INSERT OR IGNORE INTO downtime_records
                    (station_id, start_time, duration_minutes, status)
                    VALUES (?, ?, ?, 'active')
                  `).bind(stationId, currentDowntimeStart, durationMinutes).run();
                  totalRecords++;
                } catch (e) {
                  // Ignore duplicate key errors
                }
              }
            }
          }

          return new Response(JSON.stringify({
            success: true,
            message: `Processed batch: ${processedStations} stations, ${totalRecords} records created`,
            offset: offset,
            batch_size: batchSize,
            processed: processedStations,
            records_created: totalRecords,
            next_offset: offset + batchSize
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        } catch (error) {
          console.error('Backfill error:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error.message
          }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } else if (path === '/api/dashboard-stats') {
        // Get avg uptime/downtime and daily extremes (since midnight PKT)
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleDashboardStats(env, corsHeaders), edgeCtx);
      } else if (path === '/api/rain-gauges') {
        return await cacheAndReturn(routeCacheKey, 600_000, handleRainGaugesRequest(env, url, corsHeaders));
      } else if (path === '/api/uptime-trend-chart') {
        // Get uptime trend chart data with configurable range (24h, 7d, 30d, 1y)
        return await cacheAndReturn(routeCacheKey, API_CACHE_TTL[path], handleUptimeTrendChart(env, url, corsHeaders), edgeCtx);
      } else if (path === '/api/send-daily-report') {
        // Send the daily email report. Guarded to once per PKT day; append
        // ?force=1 to send regardless.
        return await handleSendDailyReport(env, corsHeaders, url);

      // ---- Issue Tracking & Call Log Routes ----
      } else if (path === '/api/issues' && request.method === 'GET') {
        // List issues, optionally filtered by station_id and/or status
        const stationId = url.searchParams.get('station_id');
        const status = url.searchParams.get('status');
        let query = 'SELECT * FROM station_issues WHERE 1=1';
        const binds = [];
        if (stationId) { query += ' AND station_id = ?'; binds.push(stationId); }
        if (status) { query += ' AND status = ?'; binds.push(status); }
        query += ' ORDER BY created_at DESC';
        const result = await env.DB.prepare(query).bind(...binds).all();
        return new Response(JSON.stringify(result.results), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path === '/api/issues' && request.method === 'POST') {
        // Create a new issue
        const body = await request.json();
        const { station_id, title, description, priority, assigned_to, created_by } = body;
        if (!station_id || !title) {
          return new Response(JSON.stringify({ error: 'station_id and title are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const result = await env.DB.prepare(
          `INSERT INTO station_issues (station_id, title, description, priority, assigned_to, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(station_id, title, description || null, priority || 'medium', assigned_to || null, created_by || null).run();
        return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path.match(/^\/api\/issues\/\d+$/) && request.method === 'PATCH') {
        // Update issue status/fields
        const issueId = parseInt(path.split('/').pop());
        const body = await request.json();
        const updates = [];
        const binds = [];
        for (const field of ['status', 'priority', 'assigned_to', 'title', 'description']) {
          if (body[field] !== undefined) { updates.push(`${field} = ?`); binds.push(body[field]); }
        }
        if (body.status === 'resolved' || body.status === 'unresolvable') {
          updates.push("resolved_at = datetime('now')");
        }
        updates.push("updated_at = datetime('now')");
        binds.push(issueId);
        await env.DB.prepare(`UPDATE station_issues SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path.match(/^\/api\/issues\/\d+$/) && request.method === 'DELETE') {
        // Delete an issue
        const issueId = parseInt(path.split('/').pop());
        await env.DB.prepare('DELETE FROM station_issues WHERE id = ?').bind(issueId).run();
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path.match(/^\/api\/issues\/\d+\/calls$/) && request.method === 'GET') {
        // Get calls for an issue
        const issueId = parseInt(path.split('/')[3]);
        const result = await env.DB.prepare('SELECT * FROM issue_calls WHERE issue_id = ? ORDER BY call_time DESC').bind(issueId).all();
        return new Response(JSON.stringify(result.results), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path.match(/^\/api\/issues\/\d+\/calls$/) && request.method === 'POST') {
        // Log a call for an issue
        const issueId = parseInt(path.split('/')[3]);
        const body = await request.json();
        const { caller_name, contact_person, duration_minutes, outcome, notes } = body;
        if (!caller_name) {
          return new Response(JSON.stringify({ error: 'caller_name is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Get station_id from the issue
        const issue = await env.DB.prepare('SELECT station_id FROM station_issues WHERE id = ?').bind(issueId).first();
        if (!issue) {
          return new Response(JSON.stringify({ error: 'Issue not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const result = await env.DB.prepare(
          `INSERT INTO issue_calls (issue_id, station_id, caller_name, contact_person, duration_minutes, outcome, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(issueId, issue.station_id, caller_name, contact_person || null, duration_minutes || null, outcome || 'no_answer', notes || null).run();
        // Auto-update issue status to in_progress if it's open
        await env.DB.prepare("UPDATE station_issues SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'open'").bind(issueId).run();
        return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path === '/api/call-stats' && request.method === 'GET') {
        // Aggregated call stats by range
        const range = url.searchParams.get('range') || '24h';
        let timeFilter;
        if (range === '24h') timeFilter = "datetime('now', '-1 day')";
        else if (range === '7d') timeFilter = "datetime('now', '-7 days')";
        else if (range === '30d') timeFilter = "datetime('now', '-30 days')";
        else if (range === '1y') timeFilter = "datetime('now', '-1 year')";
        else timeFilter = "datetime('now', '-1 day')";

        const [byPerson, byStation, byOutcome, summary] = await Promise.all([
          env.DB.prepare(`SELECT caller_name, COUNT(*) as total_calls, COUNT(DISTINCT issue_id) as issues_handled
            FROM issue_calls WHERE call_time >= ${timeFilter} GROUP BY caller_name ORDER BY total_calls DESC`).all(),
          env.DB.prepare(`SELECT c.station_id, s.station_name, COUNT(*) as total_calls
            FROM issue_calls c LEFT JOIN stations s ON c.station_id = s.station_id
            WHERE c.call_time >= ${timeFilter} GROUP BY c.station_id ORDER BY total_calls DESC LIMIT 20`).all(),
          env.DB.prepare(`SELECT outcome, COUNT(*) as count FROM issue_calls
            WHERE call_time >= ${timeFilter} GROUP BY outcome`).all(),
          env.DB.prepare(`SELECT
            COUNT(*) as total_calls,
            COUNT(DISTINCT issue_id) as total_issues,
            COUNT(DISTINCT caller_name) as active_callers
            FROM issue_calls WHERE call_time >= ${timeFilter}`).first(),
        ]);

        // Issue resolution stats (filtered by range - created_at)
        const issueStats = await env.DB.prepare(`SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_issues,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN status = 'unresolvable' THEN 1 ELSE 0 END) as unresolvable
          FROM station_issues WHERE created_at >= ${timeFilter}`).first();

        return new Response(JSON.stringify({
          range,
          summary: summary || { total_calls: 0, total_issues: 0, active_callers: 0 },
          issue_stats: issueStats || { total: 0, open_issues: 0, in_progress: 0, resolved: 0, unresolvable: 0 },
          by_person: byPerson.results,
          by_station: byStation.results,
          by_outcome: byOutcome.results,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path === '/api/calls' && request.method === 'GET') {
        // Per-caller call detail records, optionally filtered by caller_name.
        // Powers the "click team-member name to see full call history" drill-down.
        const range = url.searchParams.get('range') || '7d';
        const callerFilter = url.searchParams.get('caller') || '';

        let timeFilter;
        if (range === '24h') timeFilter = "datetime('now', '-1 day')";
        else if (range === '7d') timeFilter = "datetime('now', '-7 days')";
        else if (range === '30d') timeFilter = "datetime('now', '-30 days')";
        else if (range === '1y') timeFilter = "datetime('now', '-1 year')";
        else timeFilter = "datetime('now', '-7 days')";

        let query = `
          SELECT c.id, c.call_time, c.caller_name, c.contact_person, c.station_id,
            s.station_name,
            c.issue_id, i.title as issue_title, i.status as issue_status, i.assigned_to,
            c.duration_minutes, c.outcome, c.notes
          FROM issue_calls c
          LEFT JOIN station_issues i ON c.issue_id = i.id
          LEFT JOIN stations s ON c.station_id = s.station_id
          WHERE c.call_time >= ${timeFilter}
        `;
        const binds = [];
        if (callerFilter) { query += ' AND c.caller_name = ?'; binds.push(callerFilter); }
        query += ' ORDER BY c.call_time DESC';

        const result = await env.DB.prepare(query).bind(...binds).all();
        const calls = result.results || [];

        // Derive small per-caller summary from the same result set
        const stations = new Set(), issues = new Set(), outcomes = {};
        let totalDuration = 0;
        for (const c of calls) {
          if (c.station_id) stations.add(c.station_id);
          if (c.issue_id) issues.add(c.issue_id);
          if (c.outcome) outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
          if (c.duration_minutes) totalDuration += c.duration_minutes;
        }

        return new Response(JSON.stringify({
          caller_name: callerFilter || null,
          range,
          total_calls: calls.length,
          stations_called: stations.size,
          issues_handled: issues.size,
          total_duration_minutes: totalDuration,
          by_outcome: Object.entries(outcomes).map(([outcome, count]) => ({ outcome, count })),
          calls,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      } else if (path === '/api/export/calls' && request.method === 'GET') {
        const range = url.searchParams.get('range') || 'all';
        const callerFilter = url.searchParams.get('caller') || '';

        let timeCondition = '';
        if (range === '24h') timeCondition = "AND c.call_time >= datetime('now', '-1 day')";
        else if (range === '7d') timeCondition = "AND c.call_time >= datetime('now', '-7 days')";
        else if (range === '30d') timeCondition = "AND c.call_time >= datetime('now', '-30 days')";
        else if (range === '1y') timeCondition = "AND c.call_time >= datetime('now', '-1 year')";

        let query = `
          SELECT c.call_time, c.caller_name, c.contact_person, c.station_id,
            i.title as issue_title, i.status as issue_status, i.assigned_to,
            c.duration_minutes, c.outcome, c.notes
          FROM issue_calls c
          LEFT JOIN station_issues i ON c.issue_id = i.id
          WHERE 1=1 ${timeCondition}
        `;
        const binds = [];
        if (callerFilter) { query += ' AND c.caller_name = ?'; binds.push(callerFilter); }
        query += ' ORDER BY c.call_time DESC';

        const result = await env.DB.prepare(query).bind(...binds).all();

        const csvHeaders = ['Date/Time (UTC)', 'Caller Name', 'Contact Person', 'Station ID', 'Issue Title', 'Issue Status', 'Assigned To', 'Duration (min)', 'Outcome', 'Notes'];
        const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = result.results.map(r => [
          r.call_time || '',
          r.caller_name || '',
          r.contact_person || '',
          r.station_id || '',
          r.issue_title || '',
          r.issue_status || '',
          r.assigned_to || '',
          r.duration_minutes ?? '',
          r.outcome || '',
          r.notes || '',
        ].map(escape).join(','));

        const csv = [csvHeaders.join(','), ...rows].join('\r\n');
        const filename = `call-logs-${range}-${new Date().toISOString().slice(0, 10)}.csv`;

        return new Response(csv, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });

      }

      // API-only worker. The dashboards are served by Cloudflare Pages
      // (weatherwalay-dashboard / -staging / -react.pages.dev) — visit
      // those URLs for the UI. Any non-matching path here returns a 404
      // with a JSON body so misrouted requests show a clear error
      // instead of silently serving a stale HTML snapshot.
      return new Response(
        JSON.stringify({
          error: 'Not Found',
          hint: 'This is the API worker. The dashboard is served from Cloudflare Pages — see https://weatherwalay-dashboard.pages.dev',
          path,
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  // Cron trigger - runs every 30 minutes (reduced from 15 min to save D1 writes)
  async scheduled(event, env, ctx) {
    const now = new Date();
    console.log('Cron triggered:', now.toISOString());

    // Daily report. Timing and the once-per-day guard both live in
    // maybeSendDailyReport, so this path and the HTTP one cannot drift apart —
    // the old hard-coded 03:00-03:30 UTC window here was a second, different
    // schedule that also happened to be wide enough to fire twice.
    try {
      const outcome = await maybeSendDailyReport(env);
      if (outcome.skipped) console.log(`Daily report skipped: ${outcome.reason}`);
      else if (outcome.success) console.log(`Daily report sent at ${outcome.sentAt}`);
    } catch (e) {
      console.error('Failed to send daily email report:', e.message);
    }

    // Sync stations (now uses D1 batch for ~10x fewer DB round-trips)
    await syncAllStations(env);

    // Ingest samples only at the top of each hour (:07 trigger only)
    if (utcMinute < 15) {
      try {
        console.log('Ingesting samples (hourly)...');
        await handleIngestStationSamples(env, {});
      } catch (e) {
        console.warn('Scheduled ingest failed:', e.message);
      }
    }

    // Cleanup old data only once per day (at 4 AM UTC / 9 AM PKT)
    if (utcHour === 4 && utcMinute < 30) {
      try {
        console.log('Cleaning up old logs (keeping 180 days / 6 months)...');
        await cleanupOldLogs(env, 180);
      } catch (e) {
        console.warn('Cleanup failed:', e.message);
      }
    }
  },
};

// ============================================================
// CLEANUP OLD LOGS - Keep only N days of data
// ============================================================
async function cleanupOldLogs(env, daysToKeep = 180) {
  try {
    // Delete status_logs older than N days
    const logsResult = await env.DB.prepare(`
      DELETE FROM status_logs 
      WHERE timestamp < datetime('now', '-${daysToKeep} days')
    `).run();

    // Delete station_samples older than N days
    const samplesResult = await env.DB.prepare(`
      DELETE FROM station_samples 
      WHERE sample_time < datetime('now', '-${daysToKeep} days')
    `).run();

    // Delete downtime_records older than N days
    const downtimeResult = await env.DB.prepare(`
      DELETE FROM downtime_records 
      WHERE start_time < datetime('now', '-${daysToKeep} days')
    `).run();

    const totalDeleted = (logsResult.meta?.changes || 0) + (samplesResult.meta?.changes || 0) + (downtimeResult.meta?.changes || 0);
    if (totalDeleted > 0) {
      console.log(`Cleaned up ${totalDeleted} old records (logs: ${logsResult.meta?.changes || 0}, samples: ${samplesResult.meta?.changes || 0}, downtime: ${downtimeResult.meta?.changes || 0})`);
    }
    return totalDeleted;
  } catch (error) {
    console.error('Error cleaning up old logs:', error);
    return 0;
  }
}

// ============================================================
// STORAGE STATS - Check database usage
// ============================================================
async function handleStorageStats(env, corsHeaders = {}) {
  try {
    // Use lightweight queries to avoid full table scans on large tables
    // stations is small (~288 rows) so COUNT(*) is fine
    const stationsCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM stations`).first();
    // Use MAX(id) as a fast proxy for row count (avoids full scan on 8K+ rows)
    const downtimeMax = await env.DB.prepare(`SELECT MAX(id) as count FROM downtime_records`).first();
    const downtimeCount = { count: downtimeMax?.count || 0 };
    // Use MAX(id) for station_samples too (avoids 172K row scan)
    const samplesMax = await env.DB.prepare(`SELECT MAX(id) as count FROM station_samples`).first();
    const samplesCount = { count: samplesMax?.count || 0 };

    // Get newest timestamp efficiently (uses index on timestamp DESC)
    const newest = await env.DB.prepare(`SELECT MAX(timestamp) as newest FROM status_logs`).first();
    // Get oldest timestamp efficiently (uses index) 
    const oldest = await env.DB.prepare(`SELECT MIN(timestamp) as oldest FROM status_logs`).first();

    // Estimate row count from date range instead of COUNT(*) full scan
    // ~143 stations × 4 checks/hour = ~572 rows/hour
    const oldestDate = oldest?.oldest ? new Date(oldest.oldest + 'Z') : null;
    const newestDate = newest?.newest ? new Date(newest.newest + 'Z') : null;
    let estimatedLogCount = 0;
    if (oldestDate && newestDate) {
      const hoursSpan = (newestDate - oldestDate) / (1000 * 60 * 60);
      estimatedLogCount = Math.round(hoursSpan * 572);
    }

    // Estimate size (rough: ~150 bytes per log row)
    const estimatedSizeMB = ((estimatedLogCount) * 150 + (samplesCount?.count || 0) * 100) / (1024 * 1024);

    return new Response(JSON.stringify({
      success: true,
      counts: {
        status_logs: estimatedLogCount,
        station_samples: samplesCount?.count || 0,
        stations: stationsCount?.count || 0,
        downtime_records: downtimeCount?.count || 0
      },
      date_range: {
        oldest: oldest?.oldest || null,
        newest: newest?.newest || null
      },
      estimated_size_mb: estimatedSizeMB.toFixed(2),
      free_tier_limit_mb: 5120,
      usage_percent: ((estimatedSizeMB / 5120) * 100).toFixed(4)
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// ============================================================
// DAILY REPORT - Generate comprehensive station report
// ============================================================

// Station category mapping (same as dashboard)
const STATION_CATEGORIES = {
  '217041': 'community', '160484': 'corporate', '224681': 'community', '160497': 'community',
  '169631': 'corporate', 'ILAHOR38': 'wu', '165743': 'community', '165799': 'community',
  '169682': 'corporate', '169694': 'corporate', 'C13': 'community', '165897': 'community',
  '176678': 'community', '176749': 'community', '169767': 'corporate', 'C14': 'reference',
  '188154': 'corporate', '188166': 'corporate', '163674': 'community', '163691': 'community',
  '163746': 'community', '192287': 'corporate', '176854': 'corporate', '177200': 'community',
  '169859': 'corporate', 'IPASRU1': 'wu', '161483': 'community', '207397': 'community',
  'C20': 'community', '163831': 'community', '163843': 'community', '169947': 'corporate',
  '172461': 'reference', '172475': 'reference', '174619': 'community', '161580': 'community',
  '188331': 'corporate', '188337': 'corporate', '177303': 'reference', '177310': 'reference',
  '198090': 'corporate', '177389': 'community', '172577': 'community', '177408': 'corporate',
  'C11': 'community', 'C15': 'community', '186109': 'corporate', '1294980': 'corporate',
  '159738': 'corporate', '163601': 'corporate', '163333': 'community', '158829': 'corporate',
  'C21': 'community', '164176': 'corporate', '169205': 'corporate', 'C16': 'community',
  'C17': 'reference', '160691': 'reference', '160700': 'community', '170332': 'community',
  '175132': 'corporate', '147761': 'community', '147492': 'community', '162057': 'community',
  '162130': 'community', '164315': 'community', '164179': 'corporate', '164181': 'corporate',
  '170382': 'community', '175222': 'corporate', 'C12': 'community', '188822': 'corporate',
  '188834': 'corporate', '177683': 'community', '170426': 'community', '170433': 'community',
  '175318': 'corporate', '175407': 'reference', '162345': 'community', '162329': 'community',
  '177740': 'community', '177802': 'community', '170462': 'community', '170469': 'community',
  '175416': 'community', '202114': 'corporate', '168681': 'community', '170481': 'community',
  '170556': 'corporate', '162416': 'community', '162474': 'community', 'C23': 'community',
  '164594': 'corporate', '164604': 'community', '168729': 'community', '170638': 'corporate',
  '173079': 'corporate', '173126': 'corporate', '199831': 'corporate', '199834': 'corporate',
  '175472': 'community', '175480': 'corporate', 'IPINDI7': 'wu', '162498': 'reference',
  '164690': 'community', '191766': 'corporate', '168734': 'community', '170712': 'community',
  '175682': 'community', '166840': 'corporate', '166842': 'community', '168851': 'community',
  '178269': 'corporate', '170725': 'community', '170765': 'community', '175830': 'corporate',
  '174057': 'community', '162588': 'community', '166865': 'community', '166868': 'community',
  '168865': 'community', '175970': 'corporate', '166904': 'community', '166907': 'community',
  '169020': 'community', '178395': 'community', '178386': 'community', '166990': 'community',
  '167006': 'community', '192289': 'corporate', '202668': 'corporate', '160726': 'community',
  '160777': 'corporate', 'C7': 'reference', '178475': 'reference', '178480': 'community',
  'IMURREE2': 'wu', '167088': 'community', '167102': 'community', '169126': 'community',
  'C26': 'community', '205861': 'corporate', 'C4': 'community', 'C5': 'community',
  '168781': 'community', 'C19': 'community', '185206': 'corporate', 'C22': 'community',
  '165326': 'community', '160873': 'community', '163264': 'community', 'C25': 'community',
  '169407': 'corporate', '169438': 'corporate', '169455': 'corporate', 'C6': 'corporate',
  '160951': 'community', '169497': 'corporate',
  '169500': 'corporate', '174130': 'community', '163360': 'community', '163347': 'community',
  '169639': 'community', 'IKUNRI2': 'wu', '165656': 'corporate', '174221': 'community',
  'C8': 'community', 'C9': 'community', 'C10': 'reference', '165665': 'community',
  '165726': 'corporate', '165732': 'community', '165757': 'community', '127500': 'community',
  '128168': 'reference', '128522': 'community', 'IISLAMAB22': 'wu', 'IISLAM13': 'wu',
  'IISLAM9': 'wu', 'IPUNJA24': 'wu', 'IISLAM1': 'wu',
  'IPUNJA22': 'wu', 'IRAWAL3': 'wu', 'IISLAMAB7': 'wu', 'IISLAM11': 'wu',
  'IPUNJABR2': 'wu', 'IRAWAL18': 'wu', 'IRAWAL29': 'wu', 'IRAWAL16': 'wu',
  'INUSHK12': 'wu', 'IFEDERAL8': 'wu', 'IKMILPUR2': 'wu', 'IKHYBERP3': 'wu',
  'IKHYBE2': 'wu', 'ILAHOR14': 'wu', 'I90582126': 'wu', 'I90582706': 'wu',
  'ISINDH20': 'wu', 'ISINDH23': 'wu', 'ISINDH25': 'wu', 'IMURID1': 'wu',
  'ITURBA4': 'wu', 'IKARAC33': 'wu', 'IKARAC12': 'wu', 'IKARAC25': 'wu',
  'IKARAC24': 'wu', 'IKARAC17': 'wu', 'ITANDO3': 'wu', 'IKARAC38': 'wu',
  'IJATI2': 'wu', '101361': 'corporate', '104536': 'corporate', '117090': 'corporate',
  '211337': 'corporate', '128962': 'corporate', '129010': 'community', '129104': 'community',
  '180025': 'community', '180027': 'reference', '129644': 'community', '129727': 'community',
  '182269': 'community', '130584': 'community', '130787': 'community', '194398': 'community',
  '183871': 'community', '144841': 'krews', '131374': 'community', '147435': 'community',
  '131643': 'community', '131893': 'community', '220024': 'corporate', '132393': 'community',
  '132465': 'community', '132463': 'community', '206075': 'community', '133029': 'reference',
  '133035': 'corporate', '133150': 'community', '133253': 'community', '133425': 'community',
  '133509': 'community', '130231': 'community', '134031': 'reference', '134038': 'reference',
  '201736': 'community', '129498': 'corporate', '134268': 'community', '134297': 'community',
  'IKARAC41': 'wu', 'IISLAM21': 'wu', '137535': 'reference', '137991': 'corporate',
  'IISLAM25': 'wu', 'IISLAM26': 'wu', '146260': 'corporate', '147145': 'corporate',
  'C3': 'reference', '147425': 'community', 'C1': 'reference', '150067': 'community',
  '150367': 'reference', '150967': 'community', '131812': 'reference', '129090': 'community',
  '129952': 'community', '142628': 'community', '139347': 'community', '133500': 'community',
  '217831': 'community',
  // WOW - Toll Plaza Stations
  '216612': 'wow', '221544': 'wow', '221563': 'wow', '221555': 'wow', '221695': 'wow',
  '221726': 'wow', '221703': 'wow', '221746': 'wow', '221873': 'wow', '221910': 'wow',
  '221938': 'wow', '221876': 'wow', '221803': 'wow', '221884': 'wow', '228127': 'wow',
  // KREWS Stations
  '232277': 'krews', '232279': 'krews', '232280': 'krews', '232281': 'krews',
  '232282': 'krews', '236172': 'krews',
  // Reference
  '232283': 'reference'
};

async function generateDailyReportData(env) {
  // Fetch all stations with current status
  const hubStations = await fetchAllStationsFromHubServiceCached(env);

  // Get 24h uptime data from database
  const uptimeQuery = await env.DB.prepare(`
    SELECT 
      station_id,
      COUNT(*) as total_checks,
      SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
      AVG(temperature) as avg_temp
    FROM status_logs 
    WHERE timestamp > datetime('now', '-24 hours')
    GROUP BY station_id
  `).all();

  const uptimeMap = {};
  (uptimeQuery.results || []).forEach(row => {
    uptimeMap[row.station_id] = {
      uptime: row.total_checks > 0 ? ((row.online_checks / row.total_checks) * 100) : 0,
      checks: row.total_checks,
      avgTemp: row.avg_temp
    };
  });

  // Process stations
  const stations = hubStations.map(s => {
    const upData = uptimeMap[s.stationID] || { uptime: 0, checks: 0, avgTemp: null };
    const category = STATION_CATEGORIES[s.stationID] || 'community';
    return {
      station_id: s.stationID,
      station_name: s.stationName,
      poi: s.poi,
      status: s.status,
      category: category,
      api_source: s.apiSource || 'N/A',
      temperature: s.temperature,
      rainfall: s.rainfall,
      latitude: s.lat,
      longitude: s.lng ?? s.long,
      uptime_24h: upData.uptime.toFixed(1),
      checks_24h: upData.checks,
      last_seen: s.lastUpdated || null
    };
  });

  // Calculate summary stats
  const online = stations.filter(s => s.status === 'Active').length;
  const offline = stations.filter(s => s.status !== 'Active').length;
  const total = stations.length;

  // Category breakdown
  const categories = ['corporate', 'community', 'reference', 'wu'];
  const categoryStats = {};
  categories.forEach(cat => {
    const catStations = stations.filter(s => s.category === cat);
    const catOnline = catStations.filter(s => s.status === 'Active').length;
    categoryStats[cat] = {
      total: catStations.length,
      online: catOnline,
      offline: catStations.length - catOnline,
      uptime_pct: catStations.length > 0 ? ((catOnline / catStations.length) * 100).toFixed(1) : '0.0'
    };
  });

  // Source breakdown
  const sources = ['Davis', 'Misol', 'WU'];
  const sourceStats = {};
  sources.forEach(src => {
    const srcStations = stations.filter(s => s.api_source === src);
    const srcOnline = srcStations.filter(s => s.status === 'Active').length;
    sourceStats[src] = {
      total: srcStations.length,
      online: srcOnline,
      offline: srcStations.length - srcOnline,
      uptime_pct: srcStations.length > 0 ? ((srcOnline / srcStations.length) * 100).toFixed(1) : '0.0'
    };
  });

  // Find MAX temperature with station name (only from stations online in last 24h)
  const stationsWithTemp = stations
    .filter(s => s.status === 'Active' && s.temperature !== null && s.checks_24h > 0 && parseFloat(s.uptime_24h) > 0)
    .map(s => ({ name: s.poi || s.station_name, temp: parseFloat(s.temperature) }))
    .filter(s => !isNaN(s.temp));

  let maxTemp = null;
  let maxTempStation = null;
  if (stationsWithTemp.length > 0) {
    const maxTempObj = stationsWithTemp.reduce((max, s) => s.temp > max.temp ? s : max, stationsWithTemp[0]);
    maxTemp = maxTempObj.temp.toFixed(1);
    maxTempStation = maxTempObj.name;
  }

  // Find MAX rainfall with station name (only from stations that had at least 1 online check in last 24h)
  const stationsWithRain = stations
    .filter(s => s.rainfall !== null && s.checks_24h > 0 && parseFloat(s.uptime_24h) > 0)
    .map(s => ({ name: s.poi || s.station_name, rain: parseFloat(s.rainfall) }))
    .filter(s => !isNaN(s.rain) && s.rain > 0);

  let maxRainfall = '0.0';
  let maxRainfallStation = 'No rainfall';
  if (stationsWithRain.length > 0) {
    const maxRainObj = stationsWithRain.reduce((max, s) => s.rain > max.rain ? s : max, stationsWithRain[0]);
    maxRainfall = maxRainObj.rain.toFixed(1);
    maxRainfallStation = maxRainObj.name;
  }

  // Offline stations list
  const offlineStations = stations
    .filter(s => s.status !== 'Active')
    .map(s => ({
      station_id: s.station_id,
      station_name: s.poi || s.station_name,
      api_source: s.api_source,
      category: s.category,
      last_seen: s.last_seen
    }));

  const now = new Date();
  const reportDate = now.toLocaleString('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return {
    report_date: reportDate,
    generated_at: now.toISOString(),
    summary: {
      total_stations: total,
      online: online,
      offline: offline,
      uptime_percentage: total > 0 ? ((online / total) * 100).toFixed(1) : '0.0',
      max_temperature: maxTemp,
      max_temp_station: maxTempStation,
      max_rainfall: maxRainfall,
      max_rainfall_station: maxRainfallStation
    },
    category_breakdown: categoryStats,
    source_breakdown: sourceStats,
    offline_stations: offlineStations,
    all_stations: stations
  };
}

async function handleDailyReportRequest(env, corsHeaders) {
  try {
    const report = await generateDailyReportData(env);
    return new Response(JSON.stringify(report, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleDailyReportExcel(env, corsHeaders) {
  try {
    const report = await generateDailyReportData(env);

    // Category colors for styling
    const categoryColors = {
      'Corporate': { bg: '#dbeafe', text: '#1e40af' },
      'Community': { bg: '#dcfce7', text: '#166534' },
      'Reference': { bg: '#fef3c7', text: '#92400e' },
      'WU': { bg: '#ffe4e6', text: '#be123c' },
      'KREWS': { bg: '#fce7f3', text: '#9d174d' },
      'Unknown': { bg: '#f1f5f9', text: '#475569' }
    };

    // Get status color
    const getStatusStyle = (status) => {
      return status === 'Active'
        ? 'background-color:#dcfce7; color:#166534; font-weight:bold;'
        : 'background-color:#fee2e2; color:#dc2626; font-weight:bold;';
    };

    // Get category style
    const getCategoryStyle = (category) => {
      const cat = categoryColors[category] || categoryColors['Unknown'];
      return `background-color:${cat.bg}; color:${cat.text}; font-weight:500;`;
    };

    // Get uptime color
    const getUptimeStyle = (uptime) => {
      const val = parseFloat(uptime) || 0;
      if (val >= 95) return 'background-color:#dcfce7; color:#166534;';
      if (val >= 80) return 'background-color:#fef3c7; color:#92400e;';
      return 'background-color:#fee2e2; color:#dc2626;';
    };

    // Build HTML Excel file
    const html = `
<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
  <meta charset="UTF-8">
  <meta name="ProgId" content="Excel.Sheet">
  <style>
    body { font-family: Calibri, Arial, sans-serif; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
    th { background-color: #0284c7; color: white; font-weight: bold; }
    .title { font-size: 24px; font-weight: bold; color: #0284c7; border: none; padding: 15px 0; }
    .subtitle { font-size: 14px; color: #64748b; border: none; padding: 5px 0; }
    .section-header { font-size: 16px; font-weight: bold; background-color: #f1f5f9; color: #1e293b; padding: 10px; margin-top: 20px; }
    .summary-table td { border: 1px solid #e2e8f0; }
    .summary-label { background-color: #f8fafc; font-weight: 600; width: 200px; }
    .summary-value { font-weight: bold; }
    .online { color: #16a34a; font-weight: bold; }
    .offline { color: #dc2626; font-weight: bold; }
    .zebra-even { background-color: #f8fafc; }
    .stat-box { text-align: center; padding: 15px; }
    .stat-value { font-size: 28px; font-weight: bold; }
    .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
  </style>
</head>
<body>
  <!-- Report Header -->
  <table>
    <tr><td class="title" colspan="9">🌤️ Weather Station Daily Report</td></tr>
    <tr><td class="subtitle" colspan="9">Generated: ${report.report_date} PKT</td></tr>
    <tr><td colspan="9" style="border:none; height:20px;"></td></tr>
  </table>
  
  <!-- Summary Stats -->
  <table class="summary-table" style="width:auto; margin-bottom:20px;">
    <tr style="background-color:#0284c7; color:white;">
      <th style="text-align:center; width:120px;">Total</th>
      <th style="text-align:center; width:120px;">Online</th>
      <th style="text-align:center; width:120px;">Offline</th>
      <th style="text-align:center; width:120px;">Uptime</th>
      <th style="text-align:center; width:150px;">Max Temp</th>
      <th style="text-align:center; width:150px;">Max Rainfall</th>
    </tr>
    <tr>
      <td style="text-align:center; font-size:20px; font-weight:bold;">${report.summary.total_stations}</td>
      <td style="text-align:center; font-size:20px; font-weight:bold; color:#16a34a;">${report.summary.online}</td>
      <td style="text-align:center; font-size:20px; font-weight:bold; color:#dc2626;">${report.summary.offline}</td>
      <td style="text-align:center; font-size:20px; font-weight:bold;">${report.summary.uptime_percentage}%</td>
      <td style="text-align:center; font-size:16px; font-weight:bold;">${report.summary.max_temperature || 'N/A'}°C<br><span style="font-size:11px; color:#64748b;">${report.summary.max_temp_station || ''}</span></td>
      <td style="text-align:center; font-size:16px; font-weight:bold;">${report.summary.max_rainfall} mm<br><span style="font-size:11px; color:#64748b;">${report.summary.max_rainfall_station}</span></td>
    </tr>
  </table>
  
  <!-- Category Breakdown -->
  <table style="width:auto; margin-bottom:20px;">
    <tr><td colspan="5" class="section-header">📊 Category Breakdown</td></tr>
    <tr style="background-color:#0284c7; color:white;">
      <th style="width:150px;">Category</th>
      <th style="width:80px; text-align:center;">Online</th>
      <th style="width:80px; text-align:center;">Offline</th>
      <th style="width:80px; text-align:center;">Total</th>
      <th style="width:100px; text-align:center;">Uptime %</th>
    </tr>
    ${Object.entries(report.category_breakdown).map(([cat, stats], idx) => `
    <tr${idx % 2 === 1 ? ' class="zebra-even"' : ''}>
      <td style="${getCategoryStyle(cat.charAt(0).toUpperCase() + cat.slice(1))}">${cat.charAt(0).toUpperCase() + cat.slice(1)}</td>
      <td style="text-align:center;" class="online">${stats.online}</td>
      <td style="text-align:center;" class="offline">${stats.offline}</td>
      <td style="text-align:center; font-weight:bold;">${stats.total}</td>
      <td style="text-align:center; ${getUptimeStyle(stats.uptime_pct)}">${stats.uptime_pct}%</td>
    </tr>`).join('')}
  </table>
  
  <!-- Source Breakdown -->
  <table style="width:auto; margin-bottom:20px;">
    <tr><td colspan="5" class="section-header">🔌 Source Breakdown</td></tr>
    <tr style="background-color:#0284c7; color:white;">
      <th style="width:150px;">Source</th>
      <th style="width:80px; text-align:center;">Online</th>
      <th style="width:80px; text-align:center;">Offline</th>
      <th style="width:80px; text-align:center;">Total</th>
      <th style="width:100px; text-align:center;">Uptime %</th>
    </tr>
    ${Object.entries(report.source_breakdown).map(([src, stats], idx) => `
    <tr${idx % 2 === 1 ? ' class="zebra-even"' : ''}>
      <td style="font-weight:500;">${src}</td>
      <td style="text-align:center;" class="online">${stats.online}</td>
      <td style="text-align:center;" class="offline">${stats.offline}</td>
      <td style="text-align:center; font-weight:bold;">${stats.total}</td>
      <td style="text-align:center; ${getUptimeStyle(stats.uptime_pct)}">${stats.uptime_pct}%</td>
    </tr>`).join('')}
  </table>
  
  <!-- Station Details -->
  <table>
    <tr><td colspan="9" class="section-header">📋 Station Details (${report.all_stations.length} stations)</td></tr>
    <tr style="background-color:#0284c7; color:white;">
      <th>Station ID</th>
      <th>Station Name</th>
      <th>Source</th>
      <th style="text-align:center;">Status</th>
      <th>Category</th>
      <th style="text-align:center;">Temp (°C)</th>
      <th style="text-align:center;">Rain (mm)</th>
      <th style="text-align:center;">Uptime 24h</th>
      <th>Last Seen</th>
    </tr>
    ${report.all_stations.map((s, idx) => `
    <tr${idx % 2 === 1 ? ' class="zebra-even"' : ''}>
      <td>${s.station_id}</td>
      <td style="font-weight:500;">${s.station_name || ''}</td>
      <td>${s.api_source || ''}</td>
      <td style="text-align:center; ${getStatusStyle(s.status)}">${s.status === 'Active' ? '● Online' : '● Offline'}</td>
      <td style="${getCategoryStyle(s.category)}">${s.category || 'Unknown'}</td>
      <td style="text-align:center;">${s.temperature !== null ? s.temperature : '-'}</td>
      <td style="text-align:center;">${s.rainfall !== null ? s.rainfall : '-'}</td>
      <td style="text-align:center; ${getUptimeStyle(s.uptime_24h)}">${s.uptime_24h}%</td>
      <td style="font-size:11px; color:#64748b;">${s.last_seen || '-'}</td>
    </tr>`).join('')}
  </table>
  
  <!-- Footer -->
  <table>
    <tr><td colspan="9" style="border:none; height:20px;"></td></tr>
    <tr><td colspan="9" style="border:none; text-align:center; color:#64748b; font-size:11px;">
      Generated by WeatherWalay Dashboard • ${report.report_date}
    </td></tr>
  </table>
</body>
</html>`;

    const now = new Date();
    const filename = `weather_report_${now.toISOString().split('T')[0]}.xls`;

    return new Response(html, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Once-per-day guard for the daily report.
//
// This endpoint had no guard at all: every hit sent an email immediately. The
// scheduled() handler checks for the 03:00-03:30 UTC window before sending, but
// Cloudflare cron is disabled here, so the report is driven by an external
// scheduler hitting this URL — and it emailed the whole recipient list on every
// single fire. Whatever interval that scheduler runs at was the interval the
// mailing list received reports at.
//
// The date key is Asia/Karachi, matching what the report itself covers, so
// "today" means the same thing to the guard as it does in the email.
async function alreadySentToday(env, dateKey) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)'
  ).run();
  const row = await env.DB.prepare(
    "SELECT value FROM app_state WHERE key = 'last_daily_report'"
  ).first();
  return row?.value === dateKey;
}

async function markSentToday(env, dateKey) {
  await env.DB.prepare(
    `INSERT INTO app_state (key, value) VALUES ('last_daily_report', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(dateKey).run();
}

// Local time in Asia/Karachi. Built from formatToParts rather than string
// parsing so it is not at the mercy of locale formatting, and because some ICU
// builds report midnight as hour 24.
function pktNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`, // YYYY-MM-DD, sorts cleanly
    hour,
    minute: parseInt(parts.minute, 10),
  };
}

// The daily report goes out at 10:00 PKT, once per day.
//
// The external scheduler fires on its own interval and knows nothing about
// this, so the timing has to be enforced here: hold until 10:00 local, send on
// the first fire at or after it, then suppress the rest of the day. There is no
// upper bound on purpose — if the scheduler is down at 10 and only comes back
// at 14:00, a late report beats no report.
const DAILY_REPORT_HOUR_PKT = 10;

async function maybeSendDailyReport(env, { force = false } = {}) {
  const { dateKey, hour, minute } = pktNow();
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} PKT`;

  if (!force) {
    if (hour < DAILY_REPORT_HOUR_PKT) {
      return { success: true, skipped: true, reason: `Before ${DAILY_REPORT_HOUR_PKT}:00 PKT (now ${clock})`, date: dateKey };
    }
    if (await alreadySentToday(env, dateKey)) {
      return { success: true, skipped: true, reason: `Already sent for ${dateKey}`, date: dateKey };
    }
  }

  const result = await sendDailyEmailReport(env);
  // Only record a success, so a failed send is retried on the next fire.
  if (result?.success) await markSentToday(env, dateKey);
  return { ...result, date: dateKey, sentAt: clock, forced: force || undefined };
}

async function handleSendDailyReport(env, corsHeaders, url) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
  try {
    // 200 even when skipped: a scheduler firing more often than daily is the
    // expected case and should see a calm no-op, not a failure.
    return json(await maybeSendDailyReport(env, { force: url?.searchParams.get('force') === '1' }));
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

async function sendDailyEmailReport(env) {
  // Check if Resend API key is configured
  if (!env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY not configured, skipping email');
    return { success: false, error: 'Email not configured' };
  }

  // Get email recipients from env (comma-separated)
  const recipients = (env.REPORT_EMAILS || '').split(',').map(e => e.trim()).filter(e => e);
  if (recipients.length === 0) {
    console.log('No REPORT_EMAILS configured');
    return { success: false, error: 'No recipients configured' };
  }

  // Generate report data
  const report = await generateDailyReportData(env);

  // Build HTML email
  const html = `
<!DOCTYPE html>
<html>
<head>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; max-width: 700px; margin: 0 auto; padding: 20px; line-height: 1.6; font-size: 14px; }
    h1 { color: #0284c7; border-bottom: 2px solid #0284c7; padding-bottom: 12px; font-weight: 700; font-size: 24px; letter-spacing: -0.5px; }
    h2 { font-size: 16px; font-weight: 600; color: #334155; margin: 25px 0 12px; letter-spacing: -0.3px; }
    p { margin: 8px 0; }
    .summary { display: flex; gap: 12px; margin: 24px 0; flex-wrap: wrap; }
    .stat-box { background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 16px 20px; border-radius: 12px; text-align: center; min-width: 115px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .stat-box h3 { margin: 0; color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
    .stat-box .value { font-size: 26px; font-weight: 700; margin: 6px 0 0; letter-spacing: -1px; }
    .online { color: #10b981; }
    .offline { color: #ef4444; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; border-radius: 8px; overflow: hidden; }
    th, td { border: 1px solid #e2e8f0; padding: 10px 14px; text-align: left; }
    th { background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; color: #475569; }
    tr:nth-child(even) { background: #f8fafc; }
    tr:hover { background: #f1f5f9; }
    .footer { margin-top: 35px; color: #64748b; font-size: 12px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 24px; }
    .alert { background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border: 1px solid #fca5a5; border-radius: 12px; padding: 16px; margin: 20px 0; }
    .alert h3 { color: #dc2626; margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <h1>🌤️ Weather Station Daily Report</h1>
  <p><strong>Generated:</strong> ${report.report_date} PKT</p>
  
  <div class="summary">
    <div class="stat-box">
      <h3>Online</h3>
      <div class="value online">${report.summary.online}</div>
    </div>
    <div class="stat-box">
      <h3>Offline</h3>
      <div class="value offline">${report.summary.offline}</div>
    </div>
    <div class="stat-box">
      <h3>Uptime</h3>
      <div class="value">${report.summary.uptime_percentage}%</div>
    </div>
    <div class="stat-box">
      <h3>Max Temp</h3>
      <div class="value">${report.summary.max_temperature || 'N/A'}°C</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px;">${report.summary.max_temp_station || ''}</div>
    </div>
    <div class="stat-box">
      <h3>Max Rain</h3>
      <div class="value">${report.summary.max_rainfall}mm</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px;">${report.summary.max_rainfall_station}</div>
    </div>
  </div>
  
  <h2>📊 Category Breakdown</h2>
  <table>
    <thead>
      <tr><th>Category</th><th>Online</th><th>Offline</th><th>Total</th><th>Uptime</th></tr>
    </thead>
    <tbody>
      ${Object.entries(report.category_breakdown).map(([cat, stats]) => `
        <tr>
          <td>${cat.charAt(0).toUpperCase() + cat.slice(1)}</td>
          <td class="online">${stats.online}</td>
          <td class="offline">${stats.offline}</td>
          <td>${stats.total}</td>
          <td>${stats.uptime_pct}%</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  
  <h2>🔌 Source Breakdown</h2>
  <table>
    <thead>
      <tr><th>Source</th><th>Online</th><th>Offline</th><th>Total</th><th>Uptime</th></tr>
    </thead>
    <tbody>
      ${Object.entries(report.source_breakdown).map(([src, stats]) => `
        <tr>
          <td>${src}</td>
          <td class="online">${stats.online}</td>
          <td class="offline">${stats.offline}</td>
          <td>${stats.total}</td>
          <td>${stats.uptime_pct}%</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  
  ${report.offline_stations.length > 0 ? `
  <div class="alert">
    <h3>⚠️ Offline Stations (${report.offline_stations.length})</h3>
    <table>
      <thead>
        <tr><th>Station</th><th>Source</th><th>Category</th></tr>
      </thead>
      <tbody>
        ${report.offline_stations.slice(0, 20).map(s => `
          <tr>
            <td>${s.station_name || s.station_id}</td>
            <td>${s.api_source}</td>
            <td>${s.category}</td>
          </tr>
        `).join('')}
        ${report.offline_stations.length > 20 ? `<tr><td colspan="3">... and ${report.offline_stations.length - 20} more</td></tr>` : ''}
      </tbody>
    </table>
  </div>
  ` : '<p style="color: #10b981;">✅ All stations are online!</p>'}
  
  <div class="footer">
    <p>© Weatherwalay - Weather Station Monitoring System</p>
    <p>Total Stations: ${report.summary.total_stations} | Report generated automatically at 8:00 AM PKT</p>
  </div>
</body>
</html>
  `;

  // Send via Resend API
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.REPORT_FROM_EMAIL || 'Weather Monitor <onboarding@resend.dev>',
      to: recipients,
      subject: `🌤️ Weather Station Report - ${dateStr} | ${report.summary.online}/${report.summary.total_stations} Online`,
      html: html
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Resend API error:', errorText);
    return { success: false, error: errorText };
  }

  const result = await response.json();
  console.log('Email sent successfully:', result);
  return { success: true, messageId: result.id, recipients: recipients };
}

// ============================================================
// WEATHERWALAY/HUBSERVICE API ONLY
// ============================================================

// ============================================================
// SYNC ALL STATIONS - With Batch Processing
// ============================================================

const BATCH_SIZE = 29; // Process 29 stations per batch for optimal performance

// Helper function to prepare station data without executing DB calls
function prepareStationData(station) {
  const stationId = String(station.stationID);
  const isDisabled = station.status === 'Disabled';
  const isOnline = station.status === 'Active' ? 1 : 0;
  const displayName = station.poi || station.stationName || 'Unknown';
  const stationName = station.stationName || 'Unknown';
  const apiSource = station.apiSource || null;

  let temperature = null;
  if (station.temperature !== undefined && station.temperature !== null && station.temperature !== 'N/A') {
    temperature = parseFloat(station.temperature);
    if (isNaN(temperature)) temperature = null;
  }
  let rainfall = station.rainfall !== undefined && station.rainfall !== null ? parseFloat(station.rainfall) : null;
  let windSpeed = station.windSpeed !== undefined && station.windSpeed !== null ? parseFloat(station.windSpeed) : null;
  // Fallback: use socketLastUpdate.ws for stations (e.g. WOW) where servicesResponses parsing yields null
  if (windSpeed === null && station.socketLastUpdate && station.socketLastUpdate.ws !== undefined && station.socketLastUpdate.ws !== null) {
    windSpeed = parseFloat(station.socketLastUpdate.ws);
    if (isNaN(windSpeed)) windSpeed = null;
  }

  return { stationId, isDisabled, isOnline, displayName, stationName, apiSource, temperature, rainfall, windSpeed };
}

// Process ALL stations using D1 batch() to minimize round-trips
// Instead of 3-5 DB calls per station (750-1250 total), this does ~3 batch calls total
async function syncAllStationsBatched(env, apiStations) {
  // Phase 1: Batch upsert all stations
  const upsertStatements = apiStations.map(station => {
    const d = prepareStationData(station);
    return env.DB.prepare(`
      INSERT INTO stations (station_id, station_name, location, latitude, longitude, api_source, install_date)
      VALUES (?, ?, ?, ?, ?, ?, date('now'))
      ON CONFLICT(station_id) DO UPDATE SET
        station_name = excluded.station_name,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        api_source = excluded.api_source
    `).bind(d.stationId, d.displayName, d.stationName, parseFloat(station.lat) || 0, parseFloat(station.lng ?? station.long) || 0, d.apiSource);
  });

  // Phase 2: Batch insert status_logs (skip Disabled stations)
  const logStatements = apiStations
    .filter(s => s.status !== 'Disabled')
    .map(station => {
      const d = prepareStationData(station);
      return env.DB.prepare(`
        INSERT INTO status_logs (station_id, timestamp, is_online, temperature, rainfall, wind_speed, response_time_ms)
        VALUES (?, datetime('now'), ?, ?, ?, ?, 0)
      `).bind(d.stationId, d.isOnline, d.temperature, d.rainfall, d.windSpeed);
    });

  // Execute in batches of 100 (D1 batch limit)
  const D1_BATCH_LIMIT = 100;
  let totalSuccess = 0;
  let totalFailed = 0;

  // Batch upserts
  for (let i = 0; i < upsertStatements.length; i += D1_BATCH_LIMIT) {
    const chunk = upsertStatements.slice(i, i + D1_BATCH_LIMIT);
    try {
      await env.DB.batch(chunk);
      totalSuccess += chunk.length;
    } catch (e) {
      console.warn(`Upsert batch ${Math.floor(i / D1_BATCH_LIMIT) + 1} failed:`, e.message);
      totalFailed += chunk.length;
    }
  }

  // Batch status logs
  for (let i = 0; i < logStatements.length; i += D1_BATCH_LIMIT) {
    const chunk = logStatements.slice(i, i + D1_BATCH_LIMIT);
    try {
      await env.DB.batch(chunk);
    } catch (e) {
      console.warn(`Status log batch ${Math.floor(i / D1_BATCH_LIMIT) + 1} failed:`, e.message);
    }
  }

  // Phase 3: Handle downtime tracking in batch
  // Get current active downtimes in one query
  const activeDowntimes = await env.DB.prepare(`
    SELECT station_id, id, start_time FROM downtime_records WHERE status = 'active'
  `).all();
  const activeDowntimeMap = {};
  (activeDowntimes.results || []).forEach(r => { activeDowntimeMap[String(r.station_id)] = r; });

  const downtimeStatements = [];
  for (const station of apiStations) {
    if (station.status === 'Disabled') continue;
    const stationId = String(station.stationID);
    const isOnline = station.status === 'Active';
    const hasActiveDowntime = activeDowntimeMap[stationId];

    if (!isOnline && !hasActiveDowntime) {
      // Station offline with no active downtime → create new record
      downtimeStatements.push(
        env.DB.prepare(`INSERT INTO downtime_records (station_id, start_time, status) VALUES (?, datetime('now'), 'active')`).bind(stationId)
      );
    } else if (isOnline && hasActiveDowntime) {
      // Station online with active downtime → resolve it
      const startTime = new Date(hasActiveDowntime.start_time);
      const durationMinutes = Math.floor((Date.now() - startTime.getTime()) / 1000 / 60);
      downtimeStatements.push(
        env.DB.prepare(`UPDATE downtime_records SET end_time = datetime('now'), duration_minutes = ?, status = 'resolved' WHERE id = ?`).bind(durationMinutes, hasActiveDowntime.id)
      );
    }
  }

  // Execute downtime updates in batch
  if (downtimeStatements.length > 0) {
    for (let i = 0; i < downtimeStatements.length; i += D1_BATCH_LIMIT) {
      const chunk = downtimeStatements.slice(i, i + D1_BATCH_LIMIT);
      try {
        await env.DB.batch(chunk);
      } catch (e) {
        console.warn(`Downtime batch failed:`, e.message);
      }
    }
  }

  return { totalSuccess, totalFailed };
}

async function syncAllStations(env, corsHeaders = {}) {
  console.log('Starting station sync with D1 batch processing...');
  const startTime = Date.now();

  try {
    // Fetch ALL stations from HubService API in one go (uses cache if available)
    const apiStations = await fetchAllStationsFromHubServiceCached(env);

    if (!apiStations || apiStations.length === 0) {
      console.warn('No stations fetched from HubService');
      return new Response(JSON.stringify({
        success: false,
        synced: 0,
        failed: 0,
        message: 'Failed to fetch stations from HubService',
        timestamp: new Date().toISOString(),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Fetched ${apiStations.length} stations, syncing with D1 batch...`);

    // Use batched D1 operations instead of individual queries
    const { totalSuccess, totalFailed } = await syncAllStationsBatched(env, apiStations);

    const duration = Date.now() - startTime;
    const result = {
      success: true,
      synced: totalSuccess,
      failed: totalFailed,
      total: apiStations.length,
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    };

    console.log('Sync completed:', JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Sync error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// New endpoint: return stations joined with 24h uptime in a single query
async function handleStationsWithUptimeRequest(env, corsHeaders = {}) {
  try {
    // Simplified query - just fetch from HubService and add basic uptime from a single query
    let stations = [];

    // True when we fell back to the local DB, which knows station names and
    // coordinates but nothing live — every row comes back Unknown/offline.
    let degraded = false;

    // Fetch live data from HubService
    try {
      const hubStations = await fetchAllStationsFromHubServiceCached(env);
      stations = hubStations.map(s => ({
        station_id: s.stationID,
        station_name: s.stationName,
        location: s.poi || s.stationName,
        latitude: s.lat,
        longitude: s.lng ?? s.long,
        temperature: s.temperature,
        rainfall: s.rainfall,
        api_source: s.apiSource,
        status: s.status,
        is_active: s.status === 'Active' ? 1 : 0,
        last_update: null,
        last_seen: null,
        checks_24h: 0,
        uptime_24h: null
      }));
    } catch (e) {
      console.warn('Failed to fetch HubService:', e.message);
      degraded = true;
      // Fallback to local DB
      const res = await env.DB.prepare(`SELECT * FROM stations ORDER BY station_name`).all();
      stations = (res.results || []).map(r => ({
        station_id: r.station_id,
        station_name: r.station_name,
        location: r.location,
        latitude: r.latitude,
        longitude: r.longitude,
        api_source: r.api_source,
        status: 'Unknown',
        is_active: 0,
        temperature: null,
        rainfall: null,
        last_update: null,
        last_seen: null,
        checks_24h: 0,
        uptime_24h: null
      }));
    }

    // Single optimized query for all uptime data
    // uptime_1h / checks_1h / tracking_since were the ONLY fields the dashboards
    // still needed /api/uptime-percentages for. Everything else that endpoint
    // returned duplicated this one — and the dashboards used it to overwrite
    // these same fields, which is how a stale second call could replace fresh
    // data. Computing them here as extra aggregates over the same scan removes
    // the second request entirely; no additional table scan.
    const uptimeSQL = `
      SELECT station_id,
             COUNT(*) as checks_24h,
             SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as uptime_24h,
             MAX(CASE WHEN is_online = 1 THEN datetime(timestamp, '+5 hours') END) as last_seen,
             SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) as checks_1h,
             SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') AND is_online = 1 THEN 1 ELSE 0 END) as online_1h,
             MIN(timestamp) as tracking_since
      FROM status_logs
      WHERE timestamp >= datetime('now', '-24 hours')
      GROUP BY station_id
    `;

    const uptimeMap = {};
    try {
      const uptimeRes = await env.DB.prepare(uptimeSQL).all();
      (uptimeRes.results || []).forEach(r => {
        uptimeMap[String(r.station_id)] = {
          checks_24h: r.checks_24h || 0,
          uptime_24h: r.uptime_24h !== null ? Number(parseFloat(r.uptime_24h).toFixed(2)) : null,
          last_seen: r.last_seen,
          checks_1h: r.checks_1h || 0,
          uptime_1h: r.checks_1h > 0 ? Number(((r.online_1h / r.checks_1h) * 100).toFixed(2)) : null,
          tracking_since: r.tracking_since || null,
        };
      });
    } catch (e) {
      console.warn('Uptime query failed:', e.message);
    }

    // Merge uptime data
    stations = stations.map(s => {
      const up = uptimeMap[String(s.station_id)] || {};
      return {
        ...s,
        checks_24h: up.checks_24h || 0,
        uptime_24h: up.uptime_24h !== undefined ? up.uptime_24h : null,
        last_seen: up.last_seen || null,
        // Carried so the dashboards no longer need /api/uptime-percentages.
        checks_1h: up.checks_1h || 0,
        uptime_1h: up.uptime_1h !== undefined ? up.uptime_1h : null,
        tracking_since: up.tracking_since || null,
      };
    });

    return new Response(JSON.stringify({ success: true, total: stations.length, stations, degraded }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // Tells cacheAndReturn NOT to store this. Without it, one transient
        // HubService failure got frozen into the 10-minute response cache and
        // every dashboard showed all 294 stations as Unknown/offline with no
        // readings for the next 10 minutes — long after HubService recovered.
        ...(degraded ? { 'X-Degraded': '1' } : {}),
      }
    });
  } catch (err) {
    console.error('Error in stations-with-uptime:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Legacy function to sync a single station by ID from HubService API
async function syncSingleStationById(env, stationId) {
  const syncStart = Date.now();

  try {
    // Get current station data from HubService
    const response = await hubFetch(
      env,
      `https://hubservice.weatherwalay.com/wms/stations?filter={"stationID":"${stationId}"}&fields={"stationID":1,"stationName":1,"status":1,"socketLastUpdate":1}&limit=1`
    );

    if (!response.ok) {
      console.warn(`Failed to fetch station ${stationId}: ${response.status}`);
      throw new Error(`Failed to fetch station data: ${response.status}`);
    }

    const data = await response.json();
    const station = data.record && data.record[0];

    if (!station) {
      throw new Error(`Station ${stationId} not found`);
    }

    // Determine online status
    const isOnline = station.status === 'Active' ? 1 : 0;

    // Extract temperature if available
    let temperature = null;
    if (station.socketLastUpdate && station.socketLastUpdate.temp && station.socketLastUpdate.temp !== 'N/A') {
      temperature = parseFloat(station.socketLastUpdate.temp);
    }

    const responseTime = Date.now() - syncStart;

    // Insert status log
    await env.DB.prepare(`
      INSERT INTO status_logs 
      (station_id, timestamp, is_online, temperature, response_time_ms)
      VALUES (?, datetime('now'), ?, ?, ?)
    `).bind(
      stationId,
      isOnline,
      temperature,
      responseTime
    ).run();

    // Track downtime events
    if (!isOnline) {
      await handleStationOffline(env, stationId);
    } else {
      await handleStationOnline(env, stationId);
    }

    return { success: true, station_id: stationId, is_online: isOnline };
  } catch (error) {
    console.warn(`Error syncing station ${stationId}:`, error.message);
    // Don't log status on error - just skip
    return { success: false, error: error.message };
  }
}

// ============================================================
// DOWNTIME TRACKING
// ============================================================

async function handleStationOffline(env, stationId) {
  // Check if there's already an active downtime record
  const existing = await env.DB.prepare(`
    SELECT id FROM downtime_records 
    WHERE station_id = ? AND status = 'active'
    ORDER BY start_time DESC LIMIT 1
  `).bind(stationId).first();

  if (!existing) {
    // Create new downtime record
    await env.DB.prepare(`
      INSERT INTO downtime_records (station_id, start_time, status)
      VALUES (?, datetime('now'), 'active')
    `).bind(stationId).run();
  }
}

async function handleStationOnline(env, stationId) {
  // Close any active downtime records
  const activeDowntime = await env.DB.prepare(`
    SELECT id, start_time FROM downtime_records 
    WHERE station_id = ? AND status = 'active'
    ORDER BY start_time DESC LIMIT 1
  `).bind(stationId).first();

  if (activeDowntime) {
    // Calculate duration
    const startTime = new Date(activeDowntime.start_time);
    const endTime = new Date();
    const durationMinutes = Math.floor((endTime - startTime) / 1000 / 60);

    await env.DB.prepare(`
      UPDATE downtime_records 
      SET end_time = datetime('now'), duration_minutes = ?, status = 'resolved'
      WHERE id = ?
    `).bind(durationMinutes, activeDowntime.id).run();
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

async function handleStationsRequest(env, corsHeaders) {
  // Get all stations with current status
  const stations = await env.DB.prepare(`
    SELECT 
      s.station_id,
      s.station_name as name,
      s.location,
      s.latitude as lat,
      s.longitude as lon,
      CASE 
        WHEN sl.is_online = 1 THEN 'online'
        ELSE 'offline'
      END as status,
      sl.temperature,
      datetime(sl.timestamp, '+5 hours') as last_seen,
      COALESCE(
        CASE 
          WHEN (SELECT COUNT(*) FROM status_logs WHERE station_id = s.station_id AND timestamp > datetime('now', '-24 hours')) > 0
          THEN (SELECT COUNT(*) * 100.0 / 
               (SELECT COUNT(*) FROM status_logs WHERE station_id = s.station_id AND timestamp > datetime('now', '-24 hours'))
               FROM status_logs 
               WHERE station_id = s.station_id AND is_online = 1 AND timestamp > datetime('now', '-24 hours'))
          ELSE CASE WHEN sl.is_online = 1 THEN 100.0 ELSE 0.0 END
        END,
        0
      ) as uptime
    FROM stations s
    LEFT JOIN (
      SELECT station_id, is_online, temperature, timestamp,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
    ) sl ON s.station_id = sl.station_id AND sl.rn = 1
    ORDER BY s.station_name
  `).all();

  // Get stats
  const stats = await getStats(env);

  // Get alerts
  const alerts = await getAlerts(env);

  // Convert temperatures to Celsius
  const stationsWithCelsius = stations.results.map(station => ({
    ...station,
    temperature: fahrenheitToCelsius(station.temperature)
  }));

  return new Response(
    JSON.stringify({
      stations: stationsWithCelsius,
      stats,
      alerts,
    }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

async function handleStatsRequest(env, corsHeaders) {
  const stats = await getStats(env);
  return new Response(JSON.stringify(stats), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleAlertsRequest(env, corsHeaders) {
  const alerts = await getAlerts(env);
  return new Response(JSON.stringify(alerts), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleStationDetailRequest(env, stationId, corsHeaders) {
  if (!stationId) {
    return new Response(JSON.stringify({ error: 'Station ID required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Get station details with recent logs
  const station = await env.DB.prepare(`
    SELECT 
      s.*,
      sl.is_online,
      sl.temperature,
      sl.humidity,
      sl.pressure,
      sl.wind_speed,
      sl.timestamp as last_seen
    FROM stations s
    LEFT JOIN (
      SELECT * FROM status_logs 
      WHERE station_id = ?
      ORDER BY timestamp DESC LIMIT 1
    ) sl ON s.station_id = sl.station_id
  `).bind(stationId).first();

  // Get recent history (last 24 hours)
  const history = await env.DB.prepare(`
    SELECT * FROM status_logs
    WHERE station_id = ? AND timestamp > datetime('now', '-24 hours')
    ORDER BY timestamp DESC
  `).bind(stationId).all();

  return new Response(
    JSON.stringify({
      station,
      history: history.results,
    }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function getStats(env) {
  const total = await env.DB.prepare('SELECT COUNT(*) as count FROM stations').first();

  // Get current online/offline count from latest status per station
  // Only scan last 2 hours (cron runs every 15 min, so latest status is always within this window)
  const online = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM (
      SELECT station_id, is_online,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
      WHERE timestamp >= datetime('now', '-2 hours')
    ) latest
    WHERE rn = 1 AND is_online = 1
  `).first();

  const avgResponse = await env.DB.prepare(`
    SELECT AVG(response_time_ms) as avg
    FROM status_logs
    WHERE timestamp > datetime('now', '-24 hours')
  `).first();

  return {
    total: total.count,
    online: online.count,
    offline: total.count - online.count,
    avgResponse: `${Math.round(avgResponse.avg || 0)}ms`,
  };
}

async function getAlerts(env) {
  // Get all currently offline stations with their actual offline start time
  // IMPORTANT: Calculate duration using Pakistan time to avoid timezone issues
  const recent = await env.DB.prepare(`
    SELECT 
      s.station_id,
      s.station_name,
      s.location,
      COALESCE(
        datetime(d.start_time, '+5 hours'),
        datetime(
          (SELECT MIN(timestamp) 
           FROM status_logs 
           WHERE station_id = s.station_id 
           AND is_online = 0 
           AND timestamp > COALESCE(
             (SELECT MAX(timestamp) 
              FROM status_logs 
              WHERE station_id = s.station_id AND is_online = 1
              AND timestamp >= datetime('now', '-30 days')),
             '2000-01-01'
           )
           AND timestamp >= datetime('now', '-30 days')
          ), '+5 hours'
        )
      ) as went_offline_at
    FROM stations s
    JOIN (
      SELECT station_id, is_online, timestamp,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
      WHERE timestamp >= datetime('now', '-2 hours')
    ) sl ON s.station_id = sl.station_id AND sl.rn = 1
    LEFT JOIN downtime_records d ON s.station_id = d.station_id AND d.status = 'active'
    WHERE sl.is_online = 0
    ORDER BY went_offline_at DESC
    LIMIT 10
  `).all();

  // Longest downtime (currently offline, sorted by duration)
  const longest = await env.DB.prepare(`
    SELECT 
      s.station_id,
      s.station_name,
      s.location,
      COALESCE(
        datetime(d.start_time, '+5 hours'),
        datetime(
          (SELECT MIN(timestamp) 
           FROM status_logs 
           WHERE station_id = s.station_id 
           AND is_online = 0 
           AND timestamp > COALESCE(
             (SELECT MAX(timestamp) 
              FROM status_logs 
              WHERE station_id = s.station_id AND is_online = 1
              AND timestamp >= datetime('now', '-30 days')),
             '2000-01-01'
           )
           AND timestamp >= datetime('now', '-30 days')
          ), '+5 hours'
        )
      ) as went_offline_at,
      COALESCE(
        (julianday(datetime('now', '+5 hours')) - julianday(datetime(d.start_time, '+5 hours'))) * 24 * 60,
        (julianday(datetime('now', '+5 hours')) - julianday(datetime(
          (SELECT MIN(timestamp) 
           FROM status_logs 
           WHERE station_id = s.station_id 
           AND is_online = 0 
           AND timestamp > COALESCE(
             (SELECT MAX(timestamp) 
              FROM status_logs 
              WHERE station_id = s.station_id AND is_online = 1
              AND timestamp >= datetime('now', '-30 days')),
             '2000-01-01'
           )
           AND timestamp >= datetime('now', '-30 days')
          ), '+5 hours'
        ))) * 24 * 60
      ) as minutes
    FROM stations s
    JOIN (
      SELECT station_id, is_online, timestamp,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
      WHERE timestamp >= datetime('now', '-2 hours')
    ) sl ON s.station_id = sl.station_id AND sl.rn = 1
    LEFT JOIN downtime_records d ON s.station_id = d.station_id AND d.status = 'active'
    WHERE sl.is_online = 0
    ORDER BY minutes DESC
    LIMIT 10
  `).all();

  return {
    recent: recent.results,
    longest: longest.results,
  };
}

async function handleUptimeTrendRequest(env, corsHeaders) {
  // Get hourly status for last 24 hours for all stations
  const trendData = await env.DB.prepare(`
    SELECT 
      s.station_id,
      s.station_name,
      strftime('%Y-%m-%d %H:00:00', sl.timestamp) as hour,
      CASE WHEN AVG(sl.is_online) >= 0.5 THEN 1 ELSE 0 END as status
    FROM stations s
    JOIN status_logs sl ON s.station_id = sl.station_id
    WHERE sl.timestamp > datetime('now', '-24 hours')
    GROUP BY s.station_id, hour
    ORDER BY s.station_name, hour
  `).all();

  return new Response(
    JSON.stringify({ trend: trendData.results }),
    {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}

async function handleUptimePercentagesRequest(env, request, corsHeaders) {
  try {
    let stationIds = [];

    // Get time range from query parameter
    const url = new URL(request.url);
    const range = url.searchParams.get('range') || '24h';
    const startDate = url.searchParams.get('start'); // For custom range
    const endDate = url.searchParams.get('end'); // For custom range

    // Calculate time filter based on range
    let timeFilter = "datetime('now', '-24 hours')";
    if (range === 'daily') {
      timeFilter = "date('now', 'start of day')";
    } else if (range === '7d') {
      timeFilter = "datetime('now', '-7 days')";
    } else if (range === '30d') {
      timeFilter = "datetime('now', '-30 days')";
    } else if (range === '1y') {
      timeFilter = "datetime('now', '-1 year')";
    } else if (range === 'custom' && startDate && endDate) {
      timeFilter = `'${startDate}'`;
    }

    // Check if this is a POST request with station IDs
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        stationIds = body.station_ids || []; // Array of station IDs from dashboard
      } catch (e) {
        console.warn('Could not parse POST body');
      }
    }

    // Fetch from HubService to get all stations with their status (uses cache)
    try {
      const allHubStations = await fetchAllStationsFromHubServiceCached(env);

      // Map to a consistent format (the cached data has stationID, stationName, poi, status, etc.)
      const allStations = allHubStations.map(s => ({
        stationID: s.stationID,
        poi: s.poi,
        stationName: s.stationName,
        status: s.status,
        socketLastUpdate: s.socketLastUpdate || null,
        latitude: s.lat,
        longitude: s.lng ?? s.long
      }));

      console.log(`📦 Using ${allStations.length} stations for uptime-percentages`);

      // If station IDs provided, filter; otherwise return all
      let result = [];

      if (stationIds.length > 0) {
        const stationIdSet = new Set(stationIds.map(id => String(id)));
        result = allStations.filter(s => stationIdSet.has(String(s.stationID)));
      } else {
        result = allStations;
      }

      // Get uptime data from database for all stations based on time range.
      // We also compute a separate 1-hour aggregate from the same row scan so the
      // dashboard can offer a snappy "last hour" view without an extra query —
      // the WHERE clause already pulls all rows in the broader window, and the
      // 1h subset is just two more CASE evaluations per row.
      let uptimeSQL = `
        SELECT
          station_id,
          COUNT(*) as total_checks,
          SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
          SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) as checks_1h,
          SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') AND is_online = 1 THEN 1 ELSE 0 END) as online_1h,
          MIN(timestamp) as first_check
        FROM status_logs
        WHERE timestamp >= ${timeFilter}
        GROUP BY station_id
      `;

      // For custom range, add end date filter
      if (range === 'custom' && startDate && endDate) {
        uptimeSQL = `
          SELECT
            station_id,
            COUNT(*) as total_checks,
            SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
            SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) as checks_1h,
            SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') AND is_online = 1 THEN 1 ELSE 0 END) as online_1h,
            MIN(timestamp) as first_check
          FROM status_logs
          WHERE timestamp >= '${startDate}' AND timestamp <= '${endDate}'
          GROUP BY station_id
        `;
      }

      const uptimeQuery = await env.DB.prepare(uptimeSQL).all();

      const uptimeMap = {};
      for (const row of (uptimeQuery.results || [])) {
        uptimeMap[String(row.station_id)] = {
          total: row.total_checks,
          online: row.online_checks,
          percentage: row.total_checks > 0 ? ((row.online_checks / row.total_checks) * 100).toFixed(1) : 0,
          checks_1h: row.checks_1h || 0,
          uptime_1h: row.checks_1h > 0 ? parseFloat(((row.online_1h / row.checks_1h) * 100).toFixed(1)) : null,
          first_check: row.first_check
        };
      }

      // Transform to response format with status and real uptime
      const responseData = result.map(s => {
        const stationId = String(s.stationID);
        const uptimeInfo = uptimeMap[stationId];

        // Calculate uptime: use database if available, otherwise based on current status
        let uptimePercentage = s.status === 'Active' ? 100 : 0;
        if (uptimeInfo && uptimeInfo.total > 0) {
          uptimePercentage = parseFloat(uptimeInfo.percentage);
        }

        return {
          station_id: s.stationID,
          station_name: s.poi || s.stationName,
          status: s.status,
          is_active: s.status === 'Active' ? 1 : 0,
          temperature: s.socketLastUpdate?.temp || null,
          last_update: s.socketLastUpdate?.lastUpdate || null,
          latitude: s.latitude,
          longitude: s.longitude,
          uptime_24h: uptimePercentage,
          checks_24h: uptimeInfo?.total || 0,
          uptime_1h: uptimeInfo?.uptime_1h ?? null,
          checks_1h: uptimeInfo?.checks_1h ?? 0,
          tracking_since: uptimeInfo?.first_check || null
        };
      });

      console.log(`📍 Returning data for ${responseData.length} stations`);

      return new Response(
        JSON.stringify({
          uptime_data: responseData,
          total: responseData.length,
          timestamp: new Date().toISOString()
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('Error fetching from HubService:', err);
      // Return error response
      return new Response(
        JSON.stringify({
          error: err.message,
          uptime_data: [],
          timestamp: new Date().toISOString()
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (error) {
    console.error('Error in uptime percentages:', error);
    return new Response(
      JSON.stringify({ error: error.message, uptime_data: [] }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================
// STATION HISTORY ENDPOINT
// Get detailed history and uptime for a specific station
// ============================================================
async function handleStationHistoryRequest(env, stationId, url, corsHeaders) {
  try {
    // Get time range from query params (default: 24 hours)
    const hours = parseInt(url.searchParams.get('hours')) || 24;
    const days = parseInt(url.searchParams.get('days')) || 0;
    const hoursToFetch = days > 0 ? days * 24 : hours;

    // Determine aggregation granularity based on requested period
    // default: hourly; days ==7 -> 6-hourly, days >=30 -> daily, days >=90 -> monthly, days >=1095 -> yearly
    let granularity = 'hour';
    if (days >= 1095) granularity = 'year';
    else if (days >= 90) granularity = 'month';
    else if (days >= 30) granularity = 'day';
    else if (days === 7) granularity = '6hour';

    // Get station info from cached HubService data (avoids extra API call)
    let stationInfo = null;
    try {
      const allStations = await fetchAllStationsFromHubServiceCached(env);
      const s = allStations.find(st => String(st.stationID) === String(stationId));
      if (s) {
        stationInfo = {
          station_id: s.stationID,
          station_name: s.poi || s.stationName,
          status: s.status,
          is_active: s.status === 'Active' ? 1 : 0,
          temperature: s.temperature || (s.socketLastUpdate?.temp || null),
          humidity: s.socketLastUpdate?.hum || null,
          wind_speed: s.windSpeed || (s.socketLastUpdate?.ws || null),
          pressure: s.socketLastUpdate?.bp || null,
          latitude: s.lat,
          longitude: s.lng ?? s.long,
          owned_by: s.ownedBy
        };
      }
    } catch (e) {
      console.warn('Could not fetch station info from HubService cache:', e.message);
    }

    // Choose SQL grouping expression and time filter
    let timeFilter = `timestamp >= datetime('now', '-${hoursToFetch} hours')`;
    let groupExpr = "strftime('%Y-%m-%d %H:00:00', timestamp)";
    let labelFormatter = (v) => new Date(v + 'Z').toISOString();

    if (granularity === 'day') {
      timeFilter = `timestamp >= datetime('now', '-${days} days')`;
      groupExpr = "strftime('%Y-%m-%d', timestamp)";
      labelFormatter = (v) => v; // YYYY-MM-DD
    } else if (granularity === '6hour') {
      timeFilter = `timestamp >= datetime('now', '-${days} days')`;
      // Bucket to 6-hour checkpoints (00,06,12,18) in UTC
      groupExpr = "strftime('%Y-%m-%d ', timestamp) || printf('%02d:00:00', (CAST(strftime('%H', timestamp) AS INTEGER)/6)*6)";
      labelFormatter = (v) => v;
    } else if (granularity === 'month') {
      timeFilter = `timestamp >= datetime('now', '-${days} days')`;
      groupExpr = "strftime('%Y-%m', timestamp)";
      labelFormatter = (v) => v; // YYYY-MM
    } else if (granularity === 'year') {
      timeFilter = `timestamp >= datetime('now', '-${days} days')`;
      groupExpr = "strftime('%Y', timestamp)";
      labelFormatter = (v) => v; // YYYY
    }

    // Aggregate status_logs into buckets according to granularity
    const aggSQL = `
      SELECT
        ${groupExpr} as bucket,
        COUNT(*) as total_checks,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
        AVG(CASE WHEN temperature IS NOT NULL THEN temperature END) as avg_temp
      FROM status_logs
      WHERE station_id = ? AND ${timeFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const aggResult = await env.DB.prepare(aggSQL).bind(stationId).all();
    const aggRows = aggResult.results || [];

    // Build timeseries from aggRows. If no DB logs exist, synthesize a single-point
    // timeseries using `stationInfo` (HubService) so frontend charts can render.
    const timeseries = [];

    if (!aggRows || aggRows.length === 0) {
      const now = new Date();
      let period = null;
      let period_label = null;

      if (granularity === 'hour') {
        period = now.toISOString().slice(0, 13) + ':00:00';
        period_label = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });
      } else if (granularity === 'day') {
        period = now.toISOString().slice(0, 10);
        period_label = period;
      } else if (granularity === 'month') {
        period = now.toISOString().slice(0, 7);
        period_label = period;
      } else if (granularity === 'year') {
        period = String(now.getFullYear());
        period_label = period;
      }

      const uptime = stationInfo ? (stationInfo.is_active ? 100 : 0) : null;
      const avgTemp = stationInfo ? stationInfo.temperature : null;

      timeseries.push({
        period,
        period_label,
        uptime: uptime !== null ? Number(uptime) : null,
        checks: 1,
        online: stationInfo ? (stationInfo.is_active ? 1 : 0) : 0,
        avg_temperature: avgTemp
      });
    } else {
      if (granularity === 'hour') {
        // create hourly buckets for hoursToFetch
        for (let i = hoursToFetch - 1; i >= 0; i--) {
          const dt = new Date(Date.now() - i * 60 * 60 * 1000);
          const bucket = dt.toISOString().slice(0, 13) + ':00:00'; // YYYY-MM-DDTHH:00:00Z
          // Find matching row (aggRows bucket is in format YYYY-MM-DD HH:00:00)
          const match = aggRows.find(r => r.bucket.replace(' ', 'T') === bucket.replace('Z', '')) || aggRows.find(r => r.bucket === bucket.replace('T', ' '));
          const total = match ? match.total_checks : 0;
          const online = match ? match.online_checks : 0;
          const uptime = total > 0 ? (online / total) * 100 : null;
          const avgTemp = match && match.avg_temp !== null ? parseFloat(match.avg_temp) : null;
          timeseries.push({
            period: bucket,
            period_label: dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }),
            uptime: uptime !== null ? Number(uptime.toFixed(1)) : null,
            checks: total,
            online: online,
            avg_temperature: avgTemp
          });
        }
      } else if (granularity === 'day') {
        for (let i = days - 1; i >= 0; i--) {
          const dt = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const bucket = dt.toISOString().slice(0, 10); // YYYY-MM-DD
          const match = aggRows.find(r => r.bucket === bucket);
          const total = match ? match.total_checks : 0;
          const online = match ? match.online_checks : 0;
          const uptime = total > 0 ? (online / total) * 100 : null;
          const avgTemp = match && match.avg_temp !== null ? parseFloat(match.avg_temp) : null;
          timeseries.push({
            period: bucket,
            period_label: bucket,
            uptime: uptime !== null ? Number(uptime.toFixed(1)) : null,
            checks: total,
            online: online,
            avg_temperature: avgTemp
          });
        }
      } else if (granularity === '6hour') {
        // 7 days × 4 buckets/day = 28 points, anchored to 00/06/12/18 UTC
        const totalBuckets = days * 4;
        const nowUtc = new Date();
        // Anchor to the current 6-hour block
        const anchor = new Date(Date.UTC(
          nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(),
          Math.floor(nowUtc.getUTCHours() / 6) * 6, 0, 0
        ));
        for (let i = totalBuckets - 1; i >= 0; i--) {
          const dt = new Date(anchor.getTime() - i * 6 * 60 * 60 * 1000);
          const y = dt.getUTCFullYear();
          const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
          const d = String(dt.getUTCDate()).padStart(2, '0');
          const h = String(dt.getUTCHours()).padStart(2, '0');
          const bucket = `${y}-${mo}-${d} ${h}:00:00`;
          const match = aggRows.find(r => r.bucket === bucket);
          const total = match ? match.total_checks : 0;
          const online = match ? match.online_checks : 0;
          const uptime = total > 0 ? (online / total) * 100 : null;
          const avgTemp = match && match.avg_temp !== null ? parseFloat(match.avg_temp) : null;
          timeseries.push({
            period: bucket,
            period_label: dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }),
            uptime: uptime !== null ? Number(uptime.toFixed(1)) : null,
            checks: total,
            online: online,
            avg_temperature: avgTemp
          });
        }
      } else if (granularity === 'month') {
        // build month buckets from now back 'days' days — approximate via iterating months
        const months = [];
        const now = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);
        let cur = new Date(start.getFullYear(), start.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 1);
        while (cur <= end) {
          months.push(new Date(cur));
          cur.setMonth(cur.getMonth() + 1);
        }
        months.forEach(dt => {
          const bucket = dt.toISOString().slice(0, 7); // YYYY-MM
          const match = aggRows.find(r => r.bucket === bucket);
          const total = match ? match.total_checks : 0;
          const online = match ? match.online_checks : 0;
          const uptime = total > 0 ? (online / total) * 100 : null;
          const avgTemp = match && match.avg_temp !== null ? parseFloat(match.avg_temp) : null;
          timeseries.push({ period: bucket, period_label: bucket, uptime: uptime !== null ? Number(uptime.toFixed(1)) : null, checks: total, online: online, avg_temperature: avgTemp });
        });
      } else if (granularity === 'year') {
        const years = [];
        const now = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);
        for (let y = start.getFullYear(); y <= now.getFullYear(); y++) years.push(y);
        years.forEach(y => {
          const bucket = String(y);
          const match = aggRows.find(r => r.bucket === bucket);
          const total = match ? match.total_checks : 0;
          const online = match ? match.online_checks : 0;
          const uptime = total > 0 ? (online / total) * 100 : null;
          const avgTemp = match && match.avg_temp !== null ? parseFloat(match.avg_temp) : null;
          timeseries.push({ period: bucket, period_label: bucket, uptime: uptime !== null ? Number(uptime.toFixed(1)) : null, checks: total, online: online, avg_temperature: avgTemp });
        });
      }
    }

    // Calculate downtime from the same status_logs data used for uptime
    // This ensures consistency between uptime and downtime calculations
    let totalDowntimeMinutes = 0;
    let downtimeIncidents = 0;
    let currentOfflineStart = null;

    // Use the same time filter as the uptime calculation
    const downtimeTimeFilter = hours > 0 ? `timestamp >= datetime('now', '-${hoursToFetch} hours')` : `timestamp >= datetime('now', '-24 hours')`;

    const statusLogs = await env.DB.prepare(`
      SELECT timestamp, is_online
      FROM status_logs
      WHERE station_id = ? AND ${downtimeTimeFilter}
      ORDER BY timestamp ASC
    `).bind(stationId).all();

    const logs = statusLogs.results || [];

    // If the first log shows station offline, assume it was offline from the start of the period
    if (logs.length > 0 && logs[0].is_online === 0) {
      const periodStart = new Date(Date.now() - (hoursToFetch * 60 * 60 * 1000));
      currentOfflineStart = periodStart;
      downtimeIncidents++;
    }

    for (const log of logs) {
      const isOnline = log.is_online === 1;

      if (!isOnline && currentOfflineStart === null) {
        // Station just went offline
        currentOfflineStart = new Date(log.timestamp);
        downtimeIncidents++;
      } else if (isOnline && currentOfflineStart !== null) {
        // Station just came back online - calculate downtime duration
        const offlineEnd = new Date(log.timestamp);
        const durationMinutes = Math.floor((offlineEnd - currentOfflineStart) / (1000 * 60));
        totalDowntimeMinutes += durationMinutes;
        currentOfflineStart = null;
      }
    }

    // Handle case where station is still offline at the end of the period
    if (currentOfflineStart !== null) {
      const periodEnd = new Date();
      const durationMinutes = Math.floor((periodEnd - currentOfflineStart) / (1000 * 60));
      totalDowntimeMinutes += durationMinutes;
    }

    // Get recent downtime records for display (last 10 incidents)
    const downtimeResult = await env.DB.prepare(`
      SELECT start_time, end_time, duration_minutes, status, reason
      FROM downtime_records
      WHERE station_id = ? AND start_time >= datetime('now', '-30 days')
      ORDER BY start_time DESC
      LIMIT 10
    `).bind(stationId).all();
    const recentDowntimes = downtimeResult.results || [];

    // Overall uptime based on aggregated checks if available
    const overallTotal = aggRows.reduce((a, b) => a + (b.total_checks || 0), 0);
    const overallOnline = aggRows.reduce((a, b) => a + (b.online_checks || 0), 0);
    const overallUptime = overallTotal > 0 ? ((overallOnline / overallTotal) * 100).toFixed(2) : 0;

    // Get first log timestamp (when tracking started)
    const firstLogResult = await env.DB.prepare(`SELECT MIN(timestamp) as first_log FROM status_logs WHERE station_id = ?`).bind(stationId).first();
    const trackingSince = firstLogResult?.first_log || null;

    return new Response(JSON.stringify({
      success: true,
      station: stationInfo || { station_id: stationId, station_name: 'Unknown' },
      uptime: {
        percentage: parseFloat(overallUptime),
        total_checks: overallTotal,
        online_checks: overallOnline,
        offline_checks: overallTotal - overallOnline,
        period_hours: hoursToFetch,
        granularity
      },
      downtime: {
        total_minutes: totalDowntimeMinutes,
        total_hours: (totalDowntimeMinutes / 60).toFixed(2),
        incidents: downtimeIncidents,
        records: recentDowntimes
      },
      hourly_data: timeseries,
      tracking_since: trackingSince,
      last_updated: new Date().toISOString()
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error getting station history:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleRemove404Stations(env, corsHeaders) {
  // Stations that return 404 - no API access
  const stations404 = [130584, 160726, 162130]; // As integers, not strings

  try {
    let removed = 0;

    for (const stationId of stations404) {
      // Delete status logs
      await env.DB.prepare(`
        DELETE FROM status_logs WHERE station_id = ?
      `).bind(stationId).run();

      // Delete downtime records
      await env.DB.prepare(`
        DELETE FROM downtime_records WHERE station_id = ?
      `).bind(stationId).run();

      // Delete station
      const result = await env.DB.prepare(`
        DELETE FROM stations WHERE station_id = ?
      `).bind(stationId).run();

      if (result.meta.changes > 0) removed++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        removed: removed,
        station_ids: stations404,
        message: `Removed ${removed} stations with 404 errors`
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================
// Ingest station samples - aggregate recent status_logs and write to station_samples
// ============================================================
async function handleIngestStationSamples(env, corsHeaders = {}) {
  try {
    // Aggregate last hour into hourly buckets
    const aggSQL = `
      SELECT station_id,
             strftime('%Y-%m-%d %H:00:00', timestamp) as bucket,
             COUNT(*) as total_checks,
             SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
             AVG(temperature) as avg_temp
      FROM status_logs
      WHERE timestamp >= datetime('now', '-1 hour')
      GROUP BY station_id, bucket
    `;

    const aggRes = await env.DB.prepare(aggSQL).all();
    const rows = aggRes.results || [];

    let inserted = 0;
    for (const r of rows) {
      const uptime = r.total_checks > 0 ? (r.online_checks * 100.0 / r.total_checks) : null;
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO station_samples (station_id, sample_time, uptime_pct, checks, avg_temp, source)
          VALUES (?, ?, ?, ?, ?, 'aggregated')
        `).bind(String(r.station_id), r.bucket, uptime !== null ? Number(uptime.toFixed(2)) : null, r.total_checks || 0, r.avg_temp !== null ? Number(r.avg_temp) : null).run();
        inserted++;
      } catch (e) {
        console.warn('Failed to insert sample for', r.station_id, e.message);
      }
    }

    return new Response(JSON.stringify({ success: true, inserted, rows: rows.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error ingesting station samples:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// ============================================================
// Station samples API - return persisted samples for a station
// ============================================================
async function handleStationSamplesRequest(env, stationId, url, corsHeaders = {}) {
  try {
    if (!stationId) return new Response(JSON.stringify({ success: false, error: 'station id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Range params: ?hours=24 or ?days=7 or ?range=24h
    const hours = parseInt(url.searchParams.get('hours')) || 0;
    const days = parseInt(url.searchParams.get('days')) || 0;
    let timeFilter = "timestamp >= datetime('now', '-24 hours')";
    if (hours > 0) timeFilter = `sample_time >= datetime('now', '-${hours} hours')`;
    else if (days > 0) timeFilter = `sample_time >= datetime('now', '-${days} days')`;
    else if (url.searchParams.get('range') === '7d') timeFilter = `sample_time >= datetime('now', '-7 days')`;

    const sql = `
      SELECT sample_time as period, uptime_pct as uptime, checks, avg_temp
      FROM station_samples
      WHERE station_id = ? AND ${timeFilter}
      ORDER BY sample_time ASC
    `;

    const res = await env.DB.prepare(sql).bind(stationId).all();
    const samples = (res.results || []).map(r => ({ period: r.period, uptime: r.uptime !== null ? Number(r.uptime) : null, checks: r.checks || 0, avg_temperature: r.avg_temp !== null ? Number(r.avg_temp) : null }));

    return new Response(JSON.stringify({ success: true, station_id: stationId, samples, total: samples.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error fetching station samples:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// ============================================================
// Backfill station samples over a date range
// Usage: GET /api/backfill-station-samples?start=2025-12-01&end=2025-12-07
// or GET /api/backfill-station-samples?days=7 (last 7 days)
// ============================================================
async function handleBackfillStationSamples(env, url, corsHeaders = {}) {
  try {
    const startParam = url.searchParams.get('start'); // YYYY-MM-DD
    const endParam = url.searchParams.get('end'); // YYYY-MM-DD
    const days = parseInt(url.searchParams.get('days')) || 0;

    let whereClause = "timestamp >= datetime('now', '-7 days') AND timestamp < datetime('now')";
    const binds = [];

    if (startParam && endParam) {
      // use provided inclusive dates: start 00:00:00 to end 23:59:59
      whereClause = "timestamp >= ? AND timestamp < ?";
      binds.push(`${startParam} 00:00:00`);
      // move end to next day 00:00:00 to make it exclusive
      const endNext = new Date(endParam + 'T00:00:00Z');
      endNext.setUTCDate(endNext.getUTCDate() + 1);
      const endNextStr = endNext.toISOString().slice(0, 19).replace('T', ' ');
      binds.push(endNextStr);
    } else if (days > 0) {
      whereClause = `timestamp >= datetime('now', '-${days} days') AND timestamp < datetime('now')`;
    }

    // Aggregate by station_id and hourly bucket across the range
    const aggSQL = `
      SELECT station_id,
             strftime('%Y-%m-%d %H:00:00', timestamp) as bucket,
             COUNT(*) as total_checks,
             SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
             AVG(temperature) as avg_temp
      FROM status_logs
      WHERE ${whereClause}
      GROUP BY station_id, bucket
      ORDER BY bucket ASC
    `;

    const stmt = env.DB.prepare(aggSQL);
    const aggRes = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
    const rows = aggRes.results || [];

    let inserted = 0;
    for (const r of rows) {
      const uptime = r.total_checks > 0 ? (r.online_checks * 100.0 / r.total_checks) : null;
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO station_samples (station_id, sample_time, uptime_pct, checks, avg_temp, source)
          VALUES (?, ?, ?, ?, ?, 'backfill')
        `).bind(String(r.station_id), r.bucket, uptime !== null ? Number(uptime.toFixed(2)) : null, r.total_checks || 0, r.avg_temp !== null ? Number(r.avg_temp) : null).run();
        inserted++;
      } catch (e) {
        console.warn('Backfill insert failed for', r.station_id, r.bucket, e.message);
      }
    }

    return new Response(JSON.stringify({ success: true, inserted, scanned: rows.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error during backfill:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleCleanupBlacklistedStations(env, corsHeaders) {
  const BLACKLISTED_STATIONS = ['130584', '160726', '162130'];

  try {
    // Delete status logs
    await env.DB.prepare(`
      DELETE FROM status_logs WHERE station_id IN (?, ?, ?)
    `).bind(...BLACKLISTED_STATIONS).run();

    // Delete downtime records
    await env.DB.prepare(`
      DELETE FROM downtime_records WHERE station_id IN (?, ?, ?)
    `).bind(...BLACKLISTED_STATIONS).run();

    // Delete stations
    await env.DB.prepare(`
      DELETE FROM stations WHERE station_id IN (?, ?, ?)
    `).bind(...BLACKLISTED_STATIONS).run();

    return new Response(
      JSON.stringify({
        success: true,
        removed: BLACKLISTED_STATIONS,
        message: 'Blacklisted stations removed successfully'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

// ============================================================
// DASHBOARD STATS - Avg uptime/downtime, daily extremes (since midnight PKT from D1)
// ============================================================
async function handleDashboardStats(env, corsHeaders) {
  try {
    // Get midnight PKT (UTC+5) in UTC format - correctly handle timezone conversion
    const now = new Date();
    const PKT_OFFSET = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
    
    // Get current time in PKT
    const pktNow = new Date(now.getTime() + PKT_OFFSET);
    
    // Get the date components in PKT (year, month, day)
    const pktYear = pktNow.getUTCFullYear();
    const pktMonth = pktNow.getUTCMonth();
    const pktDay = pktNow.getUTCDate();
    
    // Create midnight at start of today in PKT timezone, then convert back to UTC
    // Midnight PKT = Date.UTC(year, month, day, 0, 0, 0) - 5 hours
    const midnightPKT_UTC = Date.UTC(pktYear, pktMonth, pktDay, 0, 0, 0);
    const midnightUTC_ms = midnightPKT_UTC - PKT_OFFSET;
    const midnightUTC = new Date(midnightUTC_ms);
    
    const midnightStr = midnightUTC.toISOString().slice(0, 19).replace('T', ' ');
    const twoHoursBeforeMidnight = new Date(midnightUTC.getTime() - (2 * 60 * 60 * 1000)).toISOString().slice(0, 19).replace('T', ' ');
    const twoHoursAfterMidnight = new Date(midnightUTC.getTime() + (2 * 60 * 60 * 1000)).toISOString().slice(0, 19).replace('T', ' ');

    // Seasonal temperature validation for Pakistan
    const currentMonth = now.getMonth() + 1;
    const isSummer = currentMonth >= 4 && currentMonth <= 9;
    const MIN_VALID_TEMP = isSummer ? -5 : -15;
    const MAX_VALID_TEMP = isSummer ? 52 : 40;

    // OPTIMIZED: Two lightweight queries instead of one massive CTE
    // Query 1: Get top 5 candidates for each extreme (small result, ~20 rows)
    const extremesQuery = await env.DB.prepare(`
      WITH today_online AS (
        SELECT sl.station_id, s.station_name as display_name,
               sl.temperature, sl.rainfall, sl.wind_speed
        FROM status_logs sl
        LEFT JOIN stations s ON sl.station_id = s.station_id
        WHERE sl.timestamp > datetime(?, '+5 minutes')
          AND sl.timestamp <= datetime('now')
          AND sl.is_online = 1
      )
      SELECT * FROM (
        SELECT station_id, display_name, temperature as value, 'max_temp' as metric
        FROM today_online WHERE temperature IS NOT NULL AND temperature BETWEEN ${MIN_VALID_TEMP} AND ${MAX_VALID_TEMP}
        ORDER BY temperature DESC LIMIT 5
      )
      UNION ALL SELECT * FROM (
        SELECT station_id, display_name, temperature as value, 'min_temp' as metric
        FROM today_online WHERE temperature IS NOT NULL AND temperature BETWEEN ${MIN_VALID_TEMP} AND ${MAX_VALID_TEMP}
        ORDER BY temperature ASC LIMIT 5
      )
      UNION ALL SELECT * FROM (
        SELECT station_id, display_name, rainfall as value, 'max_rain' as metric
        FROM today_online WHERE rainfall IS NOT NULL AND rainfall > 0 AND rainfall < 500
        ORDER BY rainfall DESC LIMIT 5
      )
      UNION ALL SELECT * FROM (
        SELECT station_id, display_name, wind_speed as value, 'max_wind' as metric
        FROM today_online WHERE wind_speed IS NOT NULL AND wind_speed > 0
        ORDER BY wind_speed DESC LIMIT 5
      )
    `).bind(midnightStr).all();

    // Query 2: Lightweight stale detection — get distinct temps per station around midnight (small scan)
    const staleCheck = await env.DB.prepare(`
      SELECT station_id, COUNT(DISTINCT ROUND(temperature, 1)) as distinct_temps, COUNT(*) as readings
      FROM status_logs
      WHERE timestamp >= ? AND timestamp <= ?
        AND temperature IS NOT NULL AND is_online = 1
      GROUP BY station_id
      HAVING readings >= 4 AND distinct_temps = 1
    `).bind(twoHoursBeforeMidnight, twoHoursAfterMidnight).all();

    // Build stale station sets in JS (fast, no DB cost)
    const staleStationIds = new Set((staleCheck.results || []).map(r => r.station_id));

    // Filter stale stations in JS from the candidates
    let maxTemp = null, maxTempStation = null;
    let minTemp = null, minTempStation = null;
    let maxRainfall = '0.0', maxRainfallStation = 'No rainfall';
    let maxWind = '0.0', maxWindStation = 'No wind data';

    for (const row of (extremesQuery.results || [])) {
      if (row.value === null) continue;
      const isStale = staleStationIds.has(row.station_id);

      if (row.metric === 'max_temp' && maxTemp === null && !isStale) {
        maxTemp = parseFloat(row.value).toFixed(1);
        maxTempStation = row.display_name;
      } else if (row.metric === 'min_temp' && minTemp === null && !isStale) {
        minTemp = parseFloat(row.value).toFixed(1);
        minTempStation = row.display_name;
      } else if (row.metric === 'max_rain' && maxRainfall === '0.0') {
        // Rain stale detection not needed — simplified (rare edge case)
        maxRainfall = parseFloat(row.value).toFixed(1);
        maxRainfallStation = row.display_name || 'Unknown';
      } else if (row.metric === 'max_wind' && maxWind === '0.0') {
        maxWind = parseFloat(row.value).toFixed(1);
        maxWindStation = row.display_name || 'Unknown';
      }
    }

    // OPTIMIZED: Single query for uptime stats (combined count + uptime)
    const uptimeQuery = await env.DB.prepare(`
      SELECT 
        COUNT(DISTINCT station_id) as station_count,
        COUNT(*) as total_checks,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
        SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as records_since_midnight
      FROM status_logs 
      WHERE timestamp >= datetime('now', '-24 hours')
    `).bind(midnightStr).first();

    const stationCount = uptimeQuery?.station_count || 0;
    const totalChecks = uptimeQuery?.total_checks || 0;
    const onlineChecks = uptimeQuery?.online_checks || 0;
    const recordCount = uptimeQuery?.records_since_midnight || 0;

    const avgUptimePct = totalChecks > 0 ? (onlineChecks / totalChecks) * 100 : 0;
    const avgDowntimePct = 100 - avgUptimePct;

    return new Response(JSON.stringify({
      success: true,
      daily_extremes: {
        max_temp: maxTemp !== null ? parseFloat(maxTemp) : null,
        max_temp_station: maxTempStation,
        min_temp: minTemp !== null ? parseFloat(minTemp) : null,
        min_temp_station: minTempStation,
        max_rainfall: parseFloat(maxRainfall),
        max_rainfall_station: maxRainfallStation,
        max_wind_gust: parseFloat(maxWind),
        max_wind_gust_station: maxWindStation,
        since_midnight_pkt: midnightStr,
        source: 'd1_history'
      },
      average_uptime: {
        uptime_pct: parseFloat(avgUptimePct.toFixed(1)),
        downtime_pct: parseFloat(avgDowntimePct.toFixed(1)),
        stations_counted: stationCount
      },
      records_since_midnight: recordCount,
      timestamp: now.toISOString()
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error in dashboard stats:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
// UPTIME TREND CHART - Configurable time range (24h, 7d, 30d, 1y)
// ============================================================
async function handleUptimeTrendChart(env, url, corsHeaders) {
  try {
    // Get time range from query params (default: 7d)
    const range = url.searchParams.get('range') || '7d';

    // Determine SQL time offset and aggregation based on range
    let timeOffset, granularity, groupFormat;
    switch (range) {
      case '24h':
        timeOffset = '-24 hours';
        granularity = 'hourly';
        groupFormat = '%Y-%m-%d %H:00:00';
        break;
      case '7d':
        timeOffset = '-7 days';
        granularity = 'hourly';
        groupFormat = '%Y-%m-%d %H:00:00';
        break;
      case '30d':
        timeOffset = '-30 days';
        granularity = 'daily';
        groupFormat = '%Y-%m-%d';
        break;
      case '1y':
        timeOffset = '-365 days';
        granularity = 'weekly';
        groupFormat = '%Y-%W'; // Year-Week
        break;
      default:
        timeOffset = '-7 days';
        granularity = 'hourly';
        groupFormat = '%Y-%m-%d %H:00:00';
    }

    // Get aggregated uptime for all stations
    const trendQuery = await env.DB.prepare(`
      SELECT 
        strftime('${groupFormat}', timestamp) as period,
        COUNT(*) as total_checks,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks
      FROM status_logs 
      WHERE timestamp >= datetime('now', '${timeOffset}')
      GROUP BY period
      ORDER BY period ASC
    `).all();

    const rows = trendQuery.results || [];
    const trendData = rows.map(row => ({
      period: row.period,
      uptime_pct: row.total_checks > 0 ? parseFloat(((row.online_checks / row.total_checks) * 100).toFixed(1)) : 0,
      total_checks: row.total_checks,
      online_checks: row.online_checks
    }));

    // Calculate overall average uptime for the period
    let totalOnline = 0, totalChecks = 0;
    for (const row of rows) {
      totalOnline += row.online_checks;
      totalChecks += row.total_checks;
    }
    const overallUptime = totalChecks > 0 ? parseFloat(((totalOnline / totalChecks) * 100).toFixed(1)) : 0;

    return new Response(JSON.stringify({
      success: true,
      range: range,
      granularity: granularity,
      trend: trendData,
      overall_uptime: overallUptime,
      overall_downtime: parseFloat((100 - overallUptime).toFixed(1)),
      timestamp: new Date().toISOString()
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Error in uptime trend chart:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
// RAIN GAUGE API INTEGRATION
// ============================================================
// Proxies https://rain-gauge-backend.onrender.com/api which returns:
// { lastUpdated, devices: [{ id, name, status: "Online"|"Offline", "24h", "daily", "7d", "30d", ("1y"?) }] }

const RAIN_GAUGE_API_URL = "https://rain-gauge-backend.onrender.com/api";

async function handleRainGaugesRequest(env, url, corsHeaders) {
  try {
    const upstream = await fetch(RAIN_GAUGE_API_URL, {
      headers: { "Content-Type": "application/json" }
    });

    if (!upstream.ok) {
      throw new Error(`Upstream API returned ${upstream.status}`);
    }

    const data = await upstream.json();
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    const gauges = devices.map(d => ({
      id: d.id,
      name: (d.name || '').trim(),
      status: String(d.status || '').toLowerCase() === 'online' ? 'online' : 'offline',
      rain_24h: numOrNull(d['24h']),
      rain_daily: numOrNull(d.daily),
      rain_7d: numOrNull(d['7d']),
      rain_30d: numOrNull(d['30d']),
      rain_this_year: numOrNull(d['this_year'] ?? d.thisYear ?? d.ytd),
      rain_all_time: numOrNull(d['all_time'] ?? d.allTime ?? d.total)
    }));

    return new Response(JSON.stringify({
      success: true,
      last_updated: data?.lastUpdated || null,
      count: gauges.length,
      gauges
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Error fetching rain gauges:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}