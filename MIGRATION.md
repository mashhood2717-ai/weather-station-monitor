# Migrating off Cloudflare to a self-hosted server

Written 2026-08-08. Everything here was measured against this repo at commit
`984dffb`, not estimated from general knowledge.

**Verdict: entirely feasible, roughly 1–2 days of careful work.** The code uses
web-standard APIs far more than Cloudflare extensions, so most of it moves
unchanged. The work concentrates in one place: a database adapter.

---

## 1. Why you might actually want to

The strongest argument is not cost or control — it is latency to HubService.

Measured 2026-08-08, the same six station pages:

| Client | Per page |
|---|---|
| A laptop on a normal connection | 65–117 ms |
| The Cloudflare Worker | 6,000–60,000 ms |

HubService throttles Cloudflare's egress IPs. It does not reject with 429 on
those routes — it holds the connection open, which is far worse, because an
untimed fetch waits forever.

A large amount of the current Worker code exists **only** to survive that:

- `AbortSignal.timeout` on every HubService call (`HUB_FETCH_TIMEOUT_MS`)
- `hubPageFetch()` retry-with-jitter on 429
- The light/heavy payload split (`HUB_LIGHT_FIELDS` / `HUB_RAINWIND_FIELDS`)
- `hubStationLastGood` stale-serving with a 15-minute cap
- `seedRainWindFromD1()` fallback
- The nowcast circuit breaker and budget

**Before committing to a migration, run the latency probe in §8.** If your
company server sees laptop-like numbers, this whole category of complexity
becomes optional, and that is a bigger win than anything else here.

---

## 2. What ports with no changes

More than you would expect, because the code sticks to web standards:

| Thing | Why it just works |
|---|---|
| `crypto.subtle` (RSA-OAEP + AES-GCM) | WebCrypto is global in Node 18+. The whole HubService auth envelope is unchanged. |
| `fetch`, `Request`, `Response`, `Headers` | Global in Node 18+ |
| `AbortSignal.timeout()` | Node 17.3+ |
| `headers.getSetCookie()` | Node 20+ (undici). Used to read `hub_access_token`. |
| All 106 SQL statements | D1 **is** SQLite. On SQLite they run untouched. |
| All business logic | HubService parsing, Misol nowcast, rain/wind tiers, uptime maths, report generation |

**Use Node 20 LTS or newer.** Node 18 works except `getSetCookie()`, which the
login path depends on.

---

## 3. What is Cloudflare-specific

Complete inventory, with call counts:

| API | `src/index.js` | `rain-gauges-worker/` | Replacement |
|---|---|---|---|
| `env.DB.prepare()` | 78 | 13 | Adapter (§4) |
| `env.DB.batch()` | 4 | 2 | Transaction |
| `caches.default` | 3 | 0 | `Map` or Redis |
| `ctx.waitUntil()` | 1 | 0 | Don't `await` the promise |
| `export default { fetch }` | 1 | 1 | Express router |
| `async scheduled()` | 1 | 1 | `node-cron` |

That is the entire list. Nine distinct things, and 91 of the 97 call sites go
through one interface.

---

## 4. The D1 adapter — the only real work

Every one of the 91 database calls uses the same four-method chain:

```js
env.DB.prepare(sql).bind(...args).all()    // 39 uses -> { results: [...] }
env.DB.prepare(sql).bind(...args).first()  // 18 uses -> row object or null
env.DB.prepare(sql).bind(...args).run()    // 25 uses -> { meta: { changes } }
env.DB.batch([stmt, stmt, ...])            //  6 uses -> array of results
```

So a shim exposing exactly that surface lets **all 91 call sites stay as they
are**. Do not rewrite them individually.

### SQLite version (recommended — zero SQL changes)

```js
// db.js
import Database from 'better-sqlite3';
const db = new Database(process.env.DB_PATH || './weather.db');
db.pragma('journal_mode = WAL');

class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all()   { return { results: db.prepare(this.sql).all(...this.args) }; }
  async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
  async run()   {
    const r = db.prepare(this.sql).run(...this.args);
    return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
  }
}

export const DB = {
  prepare: (sql) => new Stmt(sql),
  // D1 batches run atomically; a transaction matches that semantics.
  batch: async (stmts) => db.transaction(() => stmts.map((s) => {
    const p = db.prepare(s.sql);
    return /^\s*select/i.test(s.sql)
      ? { results: p.all(...s.args) }
      : { meta: { changes: p.run(...s.args).changes } };
  }))(),
};
```

Keep `better-sqlite3` synchronous — it is faster than async drivers for this
workload and the adapter's `async` wrappers preserve the existing `await`s.

### If you must use Postgres

The adapter shape is the same, but **the SQL needs edits**. Occurrence counts
in this repo:

| SQLite | Count | Postgres |
|---|---|---|
| `datetime('now')` | 13 | `now()` |
| `datetime('now','-24 hours')` | 22 | `now() - interval '24 hours'` |
| `datetime('now','-30 days')` | 21 | `now() - interval '30 days'` |
| `datetime('now','-7 days')` | 17 | `now() - interval '7 days'` |
| `datetime('now','-1 year')` | 16 | `now() - interval '1 year'` |
| `datetime('now','-1 hour')` | 11 | `now() - interval '1 hour'` |
| `datetime('now','start of day','-5 hours')` | 7 | `date_trunc('day', now() - interval '5 hours')` |
| `strftime('%Y-%m-%d %H:00:00', ts)` | 4 | `date_trunc('hour', ts)` |
| `strftime('%Y-%m', ts)` | 4 | `to_char(ts, 'YYYY-MM')` |
| `INSERT OR IGNORE` | several | `INSERT ... ON CONFLICT DO NOTHING` |
| `datetime(ts, '+5 hours')` | several | `ts + interval '5 hours'` |

Also: `?` placeholders become `$1, $2, …`, and D1 returns `meta.changes` where
`pg` returns `rowCount`.

**Recommendation: stay on SQLite.** The database is 588 MB with 5.5M rows and a
single writer (the cron). Postgres buys you nothing here and costs a day of SQL
edits plus a new class of bugs.

---

## 5. The other five replacements

```js
// caches.default  (3 uses in src/index.js: getEdgeCached / putEdgeCached)
// Single server = no colo-sharing problem, so a plain Map is enough.
const edge = new Map();  // key -> { body, headers, expires }

// ctx.waitUntil(promise)  (1 use, in cacheAndReturn)
promise.catch((e) => console.warn('background task failed:', e));  // just don't await

// export default { fetch }
app.all('/api/*', async (req, res) => {
  const r = await handleRequest(toWebRequest(req), process.env, { waitUntil: (p) => p });
  res.status(r.status);
  r.headers.forEach((v, k) => res.set(k, v));
  res.send(await r.text());
});

// async scheduled()
import cron from 'node-cron';
cron.schedule('*/15 * * * *', () => syncGaugesToD1(env));   // rain-gauges worker
// stations worker: crons = [] — driven externally by cron-job.org, see §7
```

---

## 6. Configuration

Ten environment variables, currently Cloudflare secrets and vars. They become a
`.env` file — the code reads them off `env`, so pass `process.env` in:

```
HUBSERVICE_BASIC_AUTH        # "loginParam:password"
HUBSERVICE_PUBLIC_KEY        # RSA SPKI PEM, \n escapes accepted
HUBSERVICE_BASIC_PASSWORD    # optional, defaults to HUB_APP_BASIC_PASSWORD in code
HUBSERVICE_JWT               # optional legacy fallback
ADMIN_TOKEN                  # gates the destructive routes — SET THIS
RESEND_API_KEY
REPORT_EMAILS
REPORT_FROM_EMAIL
RAIN_GAUGE_UPSTREAM_URL      # rain-gauges worker
ENVIRONMENT
```

Note `HUBSERVICE_BASIC_PASSWORD` contains a `#`. Dotenv parsers truncate at `#`
unless the value is quoted — this has already caused a silent 401 once.

---

## 7. Data and dashboards

**Database export:**

```bash
wrangler d1 export weatherlink-monitor --env production --remote --output backup.sql
sqlite3 weather.db < backup.sql
```

588 MB, 5.5M rows as of writing. Verify with row counts per table before cutover.
Note retention has never run — 688k rows are older than the 180-day policy
(`cleanupOldLogs`, default 180 days), so consider pruning before export.

**Dashboards** are the easy part — no Cloudflare dependency at all:

| Folder | Change needed |
|---|---|
| `dashboard/` | `WORKER_API` constant → your server URL |
| `dashboard-staging/` | same |
| `dashboard-viewer/` | `RAIN_GAUGES_WORKER` constant |
| `dashboard-react/` | `API_BASE` and `RAIN_GAUGES_API_BASE` in `src/utils/constants.js`, then `npm run build`, serve `dist/` |

Serve all four as static files from nginx. Keep `Cache-Control: no-store` on the
API responses — the dashboards depend on it (see the caching notes in
`src/index.js`).

**External cron** (cron-job.org) currently calls `/api/sync` only. Repoint it at
the new host. If you gate `/api/sync` behind `ADMIN_TOKEN`, append
`?admin_token=…` to the cron URL — the guard accepts it as a query param
precisely so schedulers without custom-header support can authenticate.

---

## 8. Do this first: the latency probe

Before any migration work, answer the one question that determines how much of
the existing complexity you still need. Run **on the target server**:

```bash
# Uses this repo's auth envelope; needs HUBSERVICE_* env vars set.
node -e "
const t0=Date.now();
fetch('https://hubservice.weatherwalay.com/api-docs')
  .then(r => console.log('reachable, status', r.status, Date.now()-t0, 'ms'))
  .catch(e => console.log('FAILED', e.message));
"
```

Then time six authenticated station pages (see `fetchStationPages` in
`src/index.js` for the exact URL shape).

- **Under ~200 ms/page** → HubService is not throttling you. You can drop the
  retry logic, widen the timeouts, and possibly collapse the light/heavy split
  back into one fetch. Significant simplification.
- **Seconds per page** → the throttling follows the account, not the network.
  Keep every workaround in §1 and migrate for other reasons only.

---

## 9. Suggested order

1. Latency probe (§8) — decides the shape of everything else
2. D1 adapter + point the existing code at it, run against a **copy** of the data
3. Express/cron wrapper, all `/api/*` routes responding
4. Diff old vs new: `/api/stations-with-uptime` should return 294 stations with
   matching `uptime_24h`, `uptime_1h`, `tracking_since`, temperature and rainfall
5. Dashboards repointed, served from nginx
6. Run both stacks in parallel for a week against the same cron
7. Cut DNS over; keep the Worker deployed as a fallback for a month

---

## 10. What you give up

- **Global edge.** Irrelevant if your users are all in Pakistan.
- **Free DDoS protection and TLS.** You will need Cloudflare in front (proxy
  mode still works with an origin server) or your own certs.
- **Zero-ops scaling.** One server is a single point of failure; the Worker was not.
- **The $5/month plan** is replaced by server cost plus your time. Current usage
  sits at ~17% of the included D1 read allowance, so Cloudflare is not the
  expensive option today.

The honest summary: migrate for the HubService latency, not for cost. Verify
that premise with §8 before spending the two days.
