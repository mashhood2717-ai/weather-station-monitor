// Dedicated Cloudflare Worker for rain-gauge uptime tracking.
//
// Responsibilities:
//   1) Proxy GET /api/rain-gauges  — live data from the upstream rain-gauge
//      backend (rain totals + current status). Cached 10 min.
//   2) GET /api/rain-gauges-uptime — uptime_24h and uptime_1h per gauge,
//      computed from the local rain_gauge_logs D1 table. Cached 10 min.
//   3) Cron every 15 min — fetch upstream, INSERT one row per gauge with
//      its current is_online bit. The rain totals are NOT stored; they
//      only flow through the proxy when the dashboard asks for them.

const CACHE_TTL_MS = 600_000; // 10 minutes
const inMemoryCache = new Map(); // route -> { body, contentType, expires }

function corsHeadersFor(request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, init = {}, corsHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function cacheAndReturn(key, ttlMs, makeResponse) {
  const cached = inMemoryCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) {
    return new Response(cached.body, {
      headers: { ...cached.headers, 'X-Cache': 'HIT' },
    });
  }
  const resp = await makeResponse();
  const body = await resp.clone().text();
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });
  inMemoryCache.set(key, { body, headers, expires: now + ttlMs });
  return new Response(body, {
    status: resp.status,
    headers: { ...headers, 'X-Cache': 'MISS' },
  });
}

// ---- Upstream fetch + normalization ----

async function fetchUpstreamGauges(env) {
  const url = env.RAIN_GAUGE_UPSTREAM_URL || 'https://rain-gauge-backend.onrender.com/api';
  const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!resp.ok) {
    throw new Error(`Upstream rain-gauge API returned ${resp.status}`);
  }
  const data = await resp.json();
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  return {
    last_updated: data?.lastUpdated || null,
    gauges: devices.map((d) => ({
      id: d.id,
      name: (d.name || '').trim(),
      status: String(d.status || '').toLowerCase() === 'online' ? 'online' : 'offline',
      rain_24h: numOrNull(d['24h']),
      rain_daily: numOrNull(d.daily),
      rain_7d: numOrNull(d['7d']),
      rain_30d: numOrNull(d['30d']),
      rain_this_year: numOrNull(d['this_year'] ?? d.thisYear ?? d.ytd),
      rain_all_time: numOrNull(d['all_time'] ?? d.allTime ?? d.total),
    })),
  };
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- Sync (called by cron, and exposed as a manual POST endpoint) ----

async function syncGaugesToD1(env) {
  const start = Date.now();
  const { gauges } = await fetchUpstreamGauges(env);
  if (!gauges.length) {
    return { inserted: 0, skipped: 0, error: 'upstream returned 0 gauges' };
  }

  // D1 batch INSERT — one prepared statement per gauge. The UNIQUE(gauge_id,
  // timestamp) constraint makes accidental double-sync idempotent.
  const nowSql = "datetime('now')";
  const stmts = gauges.map((g) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO rain_gauge_logs (gauge_id, timestamp, is_online) VALUES (?, ${nowSql}, ?)`
    ).bind(g.id, g.status === 'online' ? 1 : 0)
  );
  const results = await env.DB.batch(stmts);
  const inserted = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return {
    inserted,
    skipped: gauges.length - inserted,
    total: gauges.length,
    duration_ms: Date.now() - start,
  };
}

// ---- Uptime aggregation from D1 ----
//
// Range selectable: 24h (default) / daily / 7d / 30d / 1y / custom (start+end).
// Mirrors the stations Worker so dashboards can use identical UI patterns.
// The 1h numbers are always computed alongside as a second window (same row
// scan, no extra reads) so the dashboard can show a snappy current-state hint.

function rangeToTimeFilter(range, startDate, endDate) {
  if (range === 'custom' && startDate && endDate) {
    return { timeFilter: `'${startDate.replace(/'/g, '')}'`, endFilter: `'${endDate.replace(/'/g, '')}'` };
  }
  switch (range) {
    case 'daily': return { timeFilter: "date('now', 'start of day')", endFilter: null };
    case '7d':   return { timeFilter: "datetime('now', '-7 days')",   endFilter: null };
    case '30d':  return { timeFilter: "datetime('now', '-30 days')",  endFilter: null };
    case '1y':   return { timeFilter: "datetime('now', '-1 year')",   endFilter: null };
    case '24h':
    default:     return { timeFilter: "datetime('now', '-24 hours')", endFilter: null };
  }
}

async function uptimeForAllGauges(env, range = '24h', startDate = null, endDate = null) {
  const { timeFilter, endFilter } = rangeToTimeFilter(range, startDate, endDate);
  const upperBound = endFilter ? ` AND timestamp <= ${endFilter}` : '';
  // Field is still called uptime_24h/checks_24h in the response for compatibility
  // with the stations API shape — it actually represents the selected range.
  const sql = `
    SELECT
      gauge_id,
      COUNT(*) AS checks_range,
      SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS online_range,
      SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS checks_1h,
      SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') AND is_online = 1 THEN 1 ELSE 0 END) AS online_1h,
      MAX(CASE WHEN is_online = 1 THEN timestamp END) AS last_online,
      MIN(timestamp) AS tracking_since
    FROM rain_gauge_logs
    WHERE timestamp >= ${timeFilter}${upperBound}
    GROUP BY gauge_id
  `;
  const result = await env.DB.prepare(sql).all();
  return (result.results || []).map((r) => ({
    gauge_id: r.gauge_id,
    checks_24h: r.checks_range || 0,
    uptime_24h: r.checks_range > 0
      ? parseFloat(((r.online_range / r.checks_range) * 100).toFixed(1))
      : null,
    checks_1h: r.checks_1h || 0,
    uptime_1h: r.checks_1h > 0
      ? parseFloat(((r.online_1h / r.checks_1h) * 100).toFixed(1))
      : null,
    last_online: r.last_online,
    tracking_since: r.tracking_since,
  }));
}

// ---- HTTP handler ----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = corsHeadersFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // --- Live proxy: rain totals + current status from upstream ---
      if (path === '/api/rain-gauges' && request.method === 'GET') {
        return await cacheAndReturn(`upstream:${path}`, CACHE_TTL_MS, async () => {
          const { last_updated, gauges } = await fetchUpstreamGauges(env);
          return jsonResponse(
            { success: true, last_updated, count: gauges.length, gauges },
            {},
            corsHeaders
          );
        });
      }

      // --- Uptime stats from D1 ---
      // Accepts ?range=24h|daily|7d|30d|1y|custom (with &start=...&end=...).
      // Default is 24h. Cache key includes the range so different selections
      // don't clobber each other in the 10-min Worker cache.
      if (path === '/api/rain-gauges-uptime' && request.method === 'GET') {
        const range = url.searchParams.get('range') || '24h';
        const startDate = url.searchParams.get('start') || null;
        const endDate = url.searchParams.get('end') || null;
        const cacheKey = `uptime:${range}:${startDate || ''}:${endDate || ''}`;
        return await cacheAndReturn(cacheKey, CACHE_TTL_MS, async () => {
          const gauges = await uptimeForAllGauges(env, range, startDate, endDate);
          return jsonResponse(
            { success: true, range, count: gauges.length, gauges },
            {},
            corsHeaders
          );
        });
      }

      // --- Per-gauge time-bucketed history (powers the in-modal chart) ---
      // Returns uptime % per bucket over the selected range. Bucket size adapts
      // to range so each chart has a sensible number of points (24-50ish).
      if (path.startsWith('/api/rain-gauge-history/') && request.method === 'GET') {
        const gaugeId = decodeURIComponent(path.split('/').pop());
        if (!gaugeId) return jsonResponse({ error: 'missing gauge id' }, { status: 400 }, corsHeaders);

        const range = url.searchParams.get('range') || '24h';
        // Bucket sizes per range:
        //   24h    → 15-min   (96 buckets, one per poll)
        //   daily  → 15-min   (today since PKT midnight, up to 96 buckets)
        //   7d     → 6-hour   (28 buckets)
        //   30d    → daily    (30 buckets)
        //   1y     → monthly  (12 buckets)
        //   all    → monthly  (open-ended, however many months we've collected)
        const bucket15min = `strftime('%Y-%m-%d %H:%M:00', datetime(strftime('%s', timestamp) / 900   * 900,   'unixepoch'))`;
        const bucket6hour = `strftime('%Y-%m-%d %H:00:00', datetime(strftime('%s', timestamp) / 21600 * 21600, 'unixepoch'))`;
        let groupExpr, whereTime, granularity;
        switch (range) {
          case 'daily':
            // Today only, since PKT midnight (= UTC midnight - 5 hours)
            groupExpr   = bucket15min;
            whereTime   = "timestamp >= datetime('now', 'start of day', '-5 hours')";
            granularity = '15min';
            break;
          case '7d':
            groupExpr   = bucket6hour;
            whereTime   = "timestamp >= datetime('now', '-7 days')";
            granularity = '6hour';
            break;
          case '30d':
            groupExpr   = "strftime('%Y-%m-%d', timestamp)";
            whereTime   = "timestamp >= datetime('now', '-30 days')";
            granularity = 'daily';
            break;
          case '1y':
            groupExpr   = "strftime('%Y-%m', timestamp)";
            whereTime   = "timestamp >= datetime('now', '-1 year')";
            granularity = 'monthly';
            break;
          case 'all':
            groupExpr   = "strftime('%Y-%m', timestamp)";
            whereTime   = "1=1"; // no time bound
            granularity = 'monthly';
            break;
          case '24h':
          default:
            groupExpr   = bucket15min;
            whereTime   = "timestamp >= datetime('now', '-24 hours')";
            granularity = '15min';
            break;
        }

        return await cacheAndReturn(`history:${gaugeId}:${range}`, CACHE_TTL_MS, async () => {
          const result = await env.DB.prepare(`
            SELECT
              ${groupExpr} AS period,
              COUNT(*) AS total_checks,
              SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS online_checks
            FROM rain_gauge_logs
            WHERE gauge_id = ? AND ${whereTime}
            GROUP BY period
            ORDER BY period ASC
          `).bind(gaugeId).all();

          const rows = result.results || [];
          const trend = rows.map(r => ({
            period: r.period,
            total_checks: r.total_checks || 0,
            online_checks: r.online_checks || 0,
            uptime_pct: r.total_checks > 0
              ? parseFloat(((r.online_checks / r.total_checks) * 100).toFixed(1))
              : 0,
          }));

          // Overall average for the badge in the chart header
          let totalOnline = 0, totalChecks = 0;
          for (const r of rows) { totalOnline += r.online_checks || 0; totalChecks += r.total_checks || 0; }
          const overall = totalChecks > 0 ? parseFloat(((totalOnline / totalChecks) * 100).toFixed(1)) : 0;

          return jsonResponse({
            success: true,
            gauge_id: gaugeId,
            range,
            granularity,
            trend,
            overall_uptime: overall,
          }, {}, corsHeaders);
        });
      }

      // --- Per-gauge CSV export ---
      // Always at native 15-min poll granularity (one CSV row per poll), no
      // bucketing — gives users the raw timeline of online/offline state for
      // their own analysis. range= filters which rows are included.
      if (path.startsWith('/api/rain-gauge-export/') && request.method === 'GET') {
        const gaugeId = decodeURIComponent(path.split('/').pop());
        if (!gaugeId) return jsonResponse({ error: 'missing gauge id' }, { status: 400 }, corsHeaders);

        const range = url.searchParams.get('range') || '24h';
        let whereTime;
        switch (range) {
          case 'daily': whereTime = "timestamp >= datetime('now', 'start of day', '-5 hours')"; break;
          case '7d':    whereTime = "timestamp >= datetime('now', '-7 days')";  break;
          case '30d':   whereTime = "timestamp >= datetime('now', '-30 days')"; break;
          case '1y':    whereTime = "timestamp >= datetime('now', '-1 year')";  break;
          case 'all':   whereTime = "1=1";                                       break;
          case '24h':
          default:      whereTime = "timestamp >= datetime('now', '-24 hours')"; break;
        }

        const result = await env.DB.prepare(`
          SELECT timestamp, is_online
          FROM rain_gauge_logs
          WHERE gauge_id = ? AND ${whereTime}
          ORDER BY timestamp ASC
        `).bind(gaugeId).all();
        const rows = result.results || [];

        // Build CSV with both UTC and PKT timestamps for analyst convenience
        const headers = ['timestamp_utc', 'timestamp_pkt', 'gauge_id', 'is_online', 'status'];
        const lines = [headers.join(',')];
        for (const r of rows) {
          // r.timestamp is "YYYY-MM-DD HH:MM:SS" UTC. PKT = +5h.
          const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
          const pktMs = utcDate.getTime() + 5 * 60 * 60 * 1000;
          const pkt = new Date(pktMs).toISOString().replace('T', ' ').substring(0, 19);
          lines.push([
            r.timestamp,
            pkt,
            gaugeId,
            r.is_online,
            r.is_online === 1 ? 'online' : 'offline',
          ].join(','));
        }

        const csv = lines.join('\r\n');
        const filename = `rain-gauge-${gaugeId}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
        return new Response(csv, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // --- All-gauges CSV export (every gauge, native 15-min rows) ---
      if (path === '/api/rain-gauges-export' && request.method === 'GET') {
        const range = url.searchParams.get('range') || '24h';
        let whereTime;
        switch (range) {
          case 'daily': whereTime = "timestamp >= datetime('now', 'start of day', '-5 hours')"; break;
          case '7d':    whereTime = "timestamp >= datetime('now', '-7 days')";  break;
          case '30d':   whereTime = "timestamp >= datetime('now', '-30 days')"; break;
          case '1y':    whereTime = "timestamp >= datetime('now', '-1 year')";  break;
          case 'all':   whereTime = "1=1";                                       break;
          case '24h':
          default:      whereTime = "timestamp >= datetime('now', '-24 hours')"; break;
        }

        const result = await env.DB.prepare(`
          SELECT timestamp, gauge_id, is_online
          FROM rain_gauge_logs
          WHERE ${whereTime}
          ORDER BY timestamp ASC, gauge_id ASC
        `).all();
        const rows = result.results || [];

        const headers = ['timestamp_utc', 'timestamp_pkt', 'gauge_id', 'is_online', 'status'];
        const lines = [headers.join(',')];
        for (const r of rows) {
          const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
          const pktMs = utcDate.getTime() + 5 * 60 * 60 * 1000;
          const pkt = new Date(pktMs).toISOString().replace('T', ' ').substring(0, 19);
          lines.push([
            r.timestamp,
            pkt,
            r.gauge_id,
            r.is_online,
            r.is_online === 1 ? 'online' : 'offline',
          ].join(','));
        }

        const csv = lines.join('\r\n');
        const filename = `rain-gauges-all-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
        return new Response(csv, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // --- Per-gauge detail (powers the dashboard's gauge-click modal) ---
      // Returns all uptime windows (1h, 24h, 7d, 30d, 1y) for one gauge in a
      // single query. Scans only that gauge's last-year rows, so the SQL is
      // cheap even though it computes 5 windows.
      if (path.startsWith('/api/rain-gauge-detail/') && request.method === 'GET') {
        const gaugeId = decodeURIComponent(path.split('/').pop());
        if (!gaugeId) return jsonResponse({ error: 'missing gauge id' }, { status: 400 }, corsHeaders);
        return await cacheAndReturn(`detail:${gaugeId}`, CACHE_TTL_MS, async () => {
          const row = await env.DB.prepare(`
            SELECT
              SUM(CASE WHEN timestamp >= datetime('now', '-1 hour')   THEN 1 ELSE 0 END) AS c_1h,
              SUM(CASE WHEN timestamp >= datetime('now', '-1 hour')   AND is_online = 1 THEN 1 ELSE 0 END) AS o_1h,
              SUM(CASE WHEN timestamp >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS c_24h,
              SUM(CASE WHEN timestamp >= datetime('now', '-24 hours') AND is_online = 1 THEN 1 ELSE 0 END) AS o_24h,
              SUM(CASE WHEN timestamp >= datetime('now', '-7 days')   THEN 1 ELSE 0 END) AS c_7d,
              SUM(CASE WHEN timestamp >= datetime('now', '-7 days')   AND is_online = 1 THEN 1 ELSE 0 END) AS o_7d,
              SUM(CASE WHEN timestamp >= datetime('now', '-30 days')  THEN 1 ELSE 0 END) AS c_30d,
              SUM(CASE WHEN timestamp >= datetime('now', '-30 days')  AND is_online = 1 THEN 1 ELSE 0 END) AS o_30d,
              SUM(CASE WHEN timestamp >= datetime('now', '-1 year')   THEN 1 ELSE 0 END) AS c_1y,
              SUM(CASE WHEN timestamp >= datetime('now', '-1 year')   AND is_online = 1 THEN 1 ELSE 0 END) AS o_1y,
              MAX(CASE WHEN is_online = 1 THEN timestamp END) AS last_online,
              MIN(timestamp) AS tracking_since,
              COUNT(*) AS total_rows
            FROM rain_gauge_logs
            WHERE gauge_id = ? AND timestamp >= datetime('now', '-1 year')
          `).bind(gaugeId).first();

          const pct = (online, checks) =>
            checks > 0 ? parseFloat(((online / checks) * 100).toFixed(1)) : null;

          return jsonResponse({
            success: true,
            gauge_id: gaugeId,
            windows: {
              '1h':  { checks: row?.c_1h  || 0, uptime: pct(row?.o_1h,  row?.c_1h)  },
              '24h': { checks: row?.c_24h || 0, uptime: pct(row?.o_24h, row?.c_24h) },
              '7d':  { checks: row?.c_7d  || 0, uptime: pct(row?.o_7d,  row?.c_7d)  },
              '30d': { checks: row?.c_30d || 0, uptime: pct(row?.o_30d, row?.c_30d) },
              '1y':  { checks: row?.c_1y  || 0, uptime: pct(row?.o_1y,  row?.c_1y)  },
            },
            last_online: row?.last_online || null,
            tracking_since: row?.tracking_since || null,
            total_rows: row?.total_rows || 0,
          }, {}, corsHeaders);
        });
      }

      // --- Manual sync trigger (external schedulers / one-off backfill) ---
      if (path === '/api/sync-rain-gauges' && request.method === 'POST') {
        const summary = await syncGaugesToD1(env);
        return jsonResponse({ success: true, ...summary }, {}, corsHeaders);
      }

      // --- Health check ---
      if (path === '/' || path === '/health') {
        return jsonResponse(
          {
            service: 'weatherwalay-rain-gauges',
            environment: env.ENVIRONMENT,
            endpoints: [
              'GET  /api/rain-gauges         — live proxy of upstream rain totals',
              'GET  /api/rain-gauges-uptime  — uptime_24h + uptime_1h per gauge from D1',
              'POST /api/sync-rain-gauges    — manual sync trigger (cron does this every 15 min in prod)',
            ],
          },
          {},
          corsHeaders
        );
      }

      return jsonResponse({ error: 'Not found', path }, { status: 404 }, corsHeaders);
    } catch (e) {
      console.error('Rain gauges Worker error:', e);
      return jsonResponse(
        { success: false, error: e.message || String(e) },
        { status: 500 },
        corsHeaders
      );
    }
  },

  async scheduled(controller, env, ctx) {
    // Cron fires every 15 min in production. Sync upstream → D1.
    try {
      const summary = await syncGaugesToD1(env);
      console.log(`Cron sync: inserted=${summary.inserted} skipped=${summary.skipped} total=${summary.total} (${summary.duration_ms}ms)`);
    } catch (e) {
      console.error('Cron sync failed:', e);
    }
  },
};
