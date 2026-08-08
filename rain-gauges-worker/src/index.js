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

const UPSTREAM_TYPES = ['rain_gauge', 'weather_station', 'level_sensor', 'unknown'];

function mapUpstreamDevice(d) {
  const name = (d.name || '').trim();
  // Trust the upstream `type` field when it's present — the backend classifies
  // by GarajCloud deviceType, which is authoritative. The name-prefix guess is
  // only a fallback for older upstream builds that didn't send `type`, and note
  // it mislabels anything that isn't RG/WS (level sensors became "rain_gauge").
  const type = UPSTREAM_TYPES.includes(d.type)
    ? d.type
    : /^WS/i.test(name) ? 'weather_station'
    : /^LS/i.test(name) ? 'level_sensor'
    : 'rain_gauge';
  return {
    id: d.id,
    name,
    type,
    status: String(d.status || '').toLowerCase() === 'online' ? 'online' : 'offline',
    // Map coordinates. Note the upstream field is `lng`, not `long` — the
    // stations side of this repo uses `long`, so don't copy that name here.
    // All 148 devices carry valid values today.
    lat: coordOrNull(d.lat, 90),
    lng: coordOrNull(d.lng, 180),
    // Rain-gauge totals (null for WS — upstream omits them)
    rain_24h:       numOrNull(d['24h']),
    rain_daily:     numOrNull(d.daily),
    rain_7d:        numOrNull(d['7d']),
    rain_30d:       numOrNull(d['30d']),
    rain_this_year: numOrNull(d['this_year'] ?? d.thisYear ?? d.ytd),
    rain_all_time:  numOrNull(d['all_time'] ?? d.allTime ?? d.total),
    // Weather-station readings (null for RG — upstream omits them)
    temperature:    numOrNull(d.temperature),
    humidity:       numOrNull(d.humidity),
    wind_direction: numOrNull(d.wind_direction),
    wind_speed:     numOrNull(d.wind_speed),
    pressure:       numOrNull(d.pressure),
    heat_index:     numOrNull(d.heat_index),
    // Level-sensor readings (null for RG/WS — upstream omits them).
    // battery_level matters operationally here: unlike the mains-powered
    // gauges these run on cells, and several are already down in single digits.
    water_level_ft: numOrNull(d.water_level_ft),
    battery_level:  numOrNull(d.battery_level),
    position:       numOrNull(d.position),
    last_seen:      d.last_seen || null,
  };
}

// Render's free tier spins the upstream dyno down after ~15 minutes idle, and a
// cold start wipes its on-disk cache — /api then 503s for ~60-70s while it
// re-syncs from GarajCloud. A single un-retried fetch loses the entire tick,
// which is exactly what silently emptied the uptime log: recorded samples fell
// from 96/day (Jul 29-31) to 1/day (Aug 6) without the cron ever being off.
//
// So on failure, poke the cheap /ping route to start the wake, then keep
// retrying across the cold-start window. Sleeping costs no CPU, and a cron
// invocation has far more wall-clock headroom than one tick needs.
const UPSTREAM_ATTEMPTS = 4;
const UPSTREAM_RETRY_MS = 25000;

async function fetchUpstreamGauges(env) {
  const url = env.RAIN_GAUGE_UPSTREAM_URL || 'https://rain-gauge-backend.onrender.com/api';
  let lastError = null;

  for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
      if (!resp.ok) {
        throw new Error(`Upstream rain-gauge API returned ${resp.status}`);
      }
      const data = await resp.json();
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      // An empty list means the upstream is up but still building its cache.
      // Treat it as retryable rather than recording a tick for zero devices.
      if (!devices.length) {
        throw new Error('Upstream returned 0 devices');
      }
      if (attempt > 1) {
        console.log(`[upstream] recovered on attempt ${attempt}`);
      }
      return {
        last_updated: data?.lastUpdated || null,
        gauges: devices.map(mapUpstreamDevice),
      };
    } catch (e) {
      lastError = e;
      console.warn(`[upstream] attempt ${attempt}/${UPSTREAM_ATTEMPTS} failed: ${e.message}`);
      if (attempt === UPSTREAM_ATTEMPTS) break;
      try {
        await fetch(new URL('/ping', url).toString());
      } catch (_) {
        // Ping is only a nudge — its failure is not interesting on its own.
      }
      await new Promise((r) => setTimeout(r, UPSTREAM_RETRY_MS));
    }
  }

  throw lastError;
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Coordinate passthrough, range-checked. Out-of-range values become null rather
// than being forwarded: a consumer can skip a null, but a bad number silently
// drops a marker in the ocean with nothing to signal it's wrong. `limit` is 90
// for latitude, 180 for longitude.
function coordOrNull(v, limit) {
  const n = numOrNull(v);
  return n === null || Math.abs(n) > limit ? null : n;
}

// MSLP (Mean Sea Level Pressure) offset per WS device, in hPa. GarajCloud
// reports absolute (station-level) pressure; weather services usually quote
// MSLP, so we add an offset based on elevation. All 3 current WS sit in
// Lahore (~210 m elevation) → +28 hPa. New stations added later will get
// 0 here by default until the user provides the correct factor (see the
// "future stations" note in the README/changelog).
const WS_PRESSURE_MSLP_OFFSET = {
  '69ce3e190d2c18ad513b7bc8': 28, // WS - Head Office WASA Lhr
  '69cf9c07e70efc69444abd48': 28, // WS - New Head Office WASA Lhr
  '69f9957a25977997e892cff7': 28, // WS - Farrukhabad Lhr
};

// 16-point compass conversion. GarajCloud reports wind direction in degrees;
// most operators read cardinal labels faster, so we surface both.
const CARDINAL_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function degreesToCardinal(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return '';
  const idx = Math.round(((n % 360 + 360) % 360) / 22.5) % 16;
  return CARDINAL_16[idx];
}

// D1 caps `env.DB.batch()` at 100 statements per call. Chunk transparently so
// we don't silently drop writes once we cross 100 devices. Empty input → no-op.
async function batchInChunks(env, stmts, chunkSize = 100) {
  const out = [];
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const slice = stmts.slice(i, i + chunkSize);
    const r = await env.DB.batch(slice);
    out.push(...r);
  }
  return out;
}

// ---- Sync (called by cron, and exposed as a manual POST endpoint) ----

async function syncGaugesToD1(env) {
  const start = Date.now();
  const { gauges } = await fetchUpstreamGauges(env);
  if (!gauges.length) {
    return { inserted: 0, skipped: 0, error: 'upstream returned 0 gauges' };
  }

  const nowSql = "datetime('now')";

  // 1) Online/offline log for rain gauges + weather stations only.
  //    UNIQUE(gauge_id, timestamp) makes a double-fire idempotent.
  //
  //    Level sensors are deliberately excluded: their uptime is not surfaced
  //    anywhere in the dashboards, so logging them would spend ~1,056 rows/day
  //    (11 devices x 96 cron fires) on data nothing reads. This filter is the
  //    only thing keeping them out — every other part of the sync is
  //    type-agnostic, so dropping it silently resumes the writes.
  const onlineStmts = gauges
    .filter((g) => g.type !== 'level_sensor')
    .map((g) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO rain_gauge_logs (gauge_id, timestamp, is_online) VALUES (?, ${nowSql}, ?)`
      ).bind(g.id, g.status === 'online' ? 1 : 0)
    );

  // 2) Sensor readings for weather stations only. One row per WS per poll
  //    with temp/humidity/wind/pressure/heat-index.
  const wsStmts = gauges
    .filter((g) => g.type === 'weather_station')
    .map((g) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO weather_station_readings
           (device_id, timestamp, temperature, humidity, wind_direction, wind_speed, pressure, heat_index)
         VALUES (?, ${nowSql}, ?, ?, ?, ?, ?, ?)`
      ).bind(
        g.id,
        g.temperature,
        g.humidity,
        g.wind_direction,
        g.wind_speed,
        g.pressure,
        g.heat_index,
      )
    );

  const onlineResults = await batchInChunks(env, onlineStmts);
  const wsResults = await batchInChunks(env, wsStmts);

  // 3) Rolling 15-month window — evict WS readings older than the retention
  //    policy. This was 1 year, which is SHORTER than the 15-month policy and
  //    would have silently dropped three months of readings the moment the
  //    table got old enough to have any. Cheap while the table is young.
  //
  //    RETENTION IS 15 MONTHS. Do not shorten this without asking.
  try {
    await env.DB.prepare(
      `DELETE FROM weather_station_readings WHERE timestamp < datetime('now', '-15 months')`
    ).run();
  } catch (e) {
    console.warn('[sync] WS rolling-cleanup failed (non-fatal):', e.message);
  }

  const insertedOnline = onlineResults.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  const insertedWS = wsResults.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return {
    inserted: insertedOnline,
    skipped: gauges.length - insertedOnline,
    total: gauges.length,
    ws_readings_inserted: insertedWS,
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
      // --- Live proxy: rain gauges only (87) ---
      // Weather stations are excluded here — they live at /api/weather-stations
      // and use a separate frontend view because their columns are different
      // (sensor readings, not rainfall windows).
      if (path === '/api/rain-gauges' && request.method === 'GET') {
        return await cacheAndReturn(`upstream-rg:${path}`, CACHE_TTL_MS, async () => {
          const { last_updated, gauges } = await fetchUpstreamGauges(env);
          const rg = gauges.filter(g => g.type === 'rain_gauge');
          return jsonResponse(
            { success: true, last_updated, count: rg.length, gauges: rg },
            {},
            corsHeaders
          );
        });
      }

      // --- Live proxy: weather stations only (3) ---
      // Returns the same upstream device list filtered to weather stations,
      // with their sensor fields (temperature/humidity/wind_*/pressure/heat_index).
      // The 6 rain-window fields will be null on these rows.
      if (path === '/api/weather-stations' && request.method === 'GET') {
        return await cacheAndReturn(`upstream-ws:${path}`, CACHE_TTL_MS, async () => {
          const { last_updated, gauges } = await fetchUpstreamGauges(env);
          const ws = gauges.filter(g => g.type === 'weather_station');
          return jsonResponse(
            { success: true, last_updated, count: ws.length, stations: ws },
            {},
            corsHeaders
          );
        });
      }

      // --- Live proxy: level sensors only (11) ---
      // Water-level sensors in Lahore drains/channels. They were invisible until
      // now: the old build misclassified them as rain gauges (no `LS` branch in
      // the name-prefix guess), so they showed up in the RG list with null rain.
      // Uptime comes from the same rain_gauge_logs table — the online/offline
      // sync is device-type agnostic, so their history was being recorded all along.
      if (path === '/api/level-sensors' && request.method === 'GET') {
        return await cacheAndReturn(`upstream-ls:${path}`, CACHE_TTL_MS, async () => {
          const { last_updated, gauges } = await fetchUpstreamGauges(env);
          const ls = gauges.filter(g => g.type === 'level_sensor');
          return jsonResponse(
            { success: true, last_updated, count: ls.length, sensors: ls },
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

      // --- Storm Watch: rapid pressure-drop alert ---
      // For each WS, compares the most recent pressure reading to the reading
      // closest to 1 hour ago. Any drop steeper than the threshold (default
      // 1.5 hPa/hour) is returned. Frontend polls this on load + refresh and
      // pops up a warning modal if anything's flagged.
      //
      // Tunables via query params:
      //   ?threshold=1.5   (hPa drop required to flag; default 1.5)
      //   ?window=60       (window in minutes; default 60)
      if (path === '/api/storm-watch' && request.method === 'GET') {
        const threshold = Math.max(0.1, Number(url.searchParams.get('threshold')) || 1.5);
        const windowMin = Math.max(15, Math.min(180, Number(url.searchParams.get('window')) || 60));
        // Fetch all WS pressure readings in the last (window + 30 min) window
        // so we always have a row close to "windowMin ago" even if a cron tick
        // is offset by a few minutes.
        const lookbackMin = windowMin + 30;
        // Cache for 2 minutes — short, since this is meant to be near-real-time.
        return await cacheAndReturn(`storm-watch:${threshold}:${windowMin}`, 120_000, async () => {
          const result = await env.DB.prepare(`
            SELECT device_id, timestamp, pressure
            FROM weather_station_readings
            WHERE timestamp >= datetime('now', '-${lookbackMin} minutes')
              AND pressure IS NOT NULL
            ORDER BY device_id ASC, timestamp ASC
          `).all();

          // Group by device_id
          const byDevice = new Map();
          for (const r of (result.results || [])) {
            if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, []);
            byDevice.get(r.device_id).push(r);
          }

          // Fetch upstream device list to attach names to each alert.
          let nameMap = {};
          try {
            const { gauges } = await fetchUpstreamGauges(env);
            for (const g of gauges) nameMap[g.id] = g.name || '';
          } catch (e) {
            // Non-fatal — alert just won't have a friendly name
            console.warn('[storm-watch] upstream name fetch failed:', e.message);
          }

          // Compute pressure delta for each device. "1 hour ago" is the reading
          // whose timestamp is closest to (now - windowMin).
          const targetMs = Date.now() - windowMin * 60_000;
          const alerts = [];
          for (const [deviceId, rows] of byDevice) {
            if (rows.length < 2) continue;
            const latest = rows[rows.length - 1];

            let bestRow = null;
            let bestDiff = Infinity;
            for (const r of rows) {
              if (r === latest) continue;
              const t = new Date(r.timestamp.replace(' ', 'T') + 'Z').getTime();
              const diff = Math.abs(t - targetMs);
              if (diff < bestDiff) { bestDiff = diff; bestRow = r; }
            }
            if (!bestRow) continue;
            // Skip if the "1h ago" candidate is too far off (>20 min slop) —
            // we shouldn't flag based on a 30-min-old reading.
            if (bestDiff > 20 * 60_000) continue;

            const delta = Number(latest.pressure) - Number(bestRow.pressure);
            if (delta < -threshold) {
              alerts.push({
                device_id: deviceId,
                name: nameMap[deviceId] || '',
                current_pressure_hpa: Number(Number(latest.pressure).toFixed(1)),
                previous_pressure_hpa: Number(Number(bestRow.pressure).toFixed(1)),
                delta_hpa: Number(delta.toFixed(2)),
                current_timestamp: latest.timestamp,
                previous_timestamp: bestRow.timestamp,
                threshold_hpa: threshold,
                window_minutes: windowMin,
              });
            }
          }

          return jsonResponse(
            { success: true, threshold_hpa: threshold, window_minutes: windowMin, count: alerts.length, alerts },
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
        // Bucket sizes per range (matches the stations chart):
        //   24h    → 1-hour   (24 buckets, 4 polls each)
        //   daily  → 1-hour   (today since PKT midnight, up to 24 buckets)
        //   7d     → 6-hour   (28 buckets, 24 polls each)
        //   30d    → daily    (30 buckets, 96 polls each)
        //   1y     → monthly  (12 buckets)
        //   all    → monthly  (open-ended, however many months we've collected)
        const bucket1hour = `strftime('%Y-%m-%d %H:00:00', timestamp)`;
        const bucket6hour = `strftime('%Y-%m-%d %H:00:00', datetime(strftime('%s', timestamp) / 21600 * 21600, 'unixepoch'))`;
        let groupExpr, whereTime, granularity;
        switch (range) {
          case 'daily':
            // Today only, since PKT midnight (= UTC midnight - 5 hours)
            groupExpr   = bucket1hour;
            whereTime   = "timestamp >= datetime('now', 'start of day', '-5 hours')";
            granularity = 'hourly';
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
            groupExpr   = bucket1hour;
            whereTime   = "timestamp >= datetime('now', '-24 hours')";
            granularity = 'hourly';
            break;
        }

        // Cache key bumped to v2 so 15-min-bucketed responses cached under
        // the old key don't keep getting served after this deploy.
        return await cacheAndReturn(`history:v2:${gaugeId}:${range}`, CACHE_TTL_MS, async () => {
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

      // --- Per-station historical sensor readings (powers the WS chart modal) ---
      // 24h and Daily return RAW 15-min rows (every poll = a dot on the chart);
      // longer ranges aggregate so the chart stays readable. Cache key includes
      // the range so swaps don't collide.
      if (path.startsWith('/api/weather-station-history/') && request.method === 'GET') {
        const stationId = decodeURIComponent(path.split('/').pop());
        if (!stationId) return jsonResponse({ error: 'missing station id' }, { status: 400 }, corsHeaders);

        const range = url.searchParams.get('range') || '24h';
        // For 24h and Daily we want EVERY 15-min reading as its own chart
        // point (matching the storage cadence). For 7d/30d/1y we aggregate
        // to keep the chart readable.
        const isRaw = range === '24h' || range === 'daily';
        let whereTime, sql, granularity;
        switch (range) {
          case 'daily':
            whereTime   = "timestamp >= datetime('now', 'start of day', '-5 hours')";
            granularity = '15min';
            break;
          case '7d':
            whereTime   = "timestamp >= datetime('now', '-7 days')";
            granularity = '6hour';
            break;
          case '30d':
            whereTime   = "timestamp >= datetime('now', '-30 days')";
            granularity = 'daily';
            break;
          case '1y':
            whereTime   = "timestamp >= datetime('now', '-1 year')";
            granularity = 'monthly';
            break;
          case '24h':
          default:
            whereTime   = "timestamp >= datetime('now', '-24 hours')";
            granularity = '15min';
            break;
        }

        if (isRaw) {
          sql = `
            SELECT timestamp AS period, 1 AS samples,
                   temperature, humidity, wind_speed, wind_direction, pressure, heat_index
            FROM weather_station_readings
            WHERE device_id = ? AND ${whereTime}
            ORDER BY timestamp ASC
          `;
        } else {
          const groupExpr =
            granularity === '6hour'  ? "strftime('%Y-%m-%d %H:00:00', datetime(strftime('%s', timestamp) / 21600 * 21600, 'unixepoch'))"
          : granularity === 'daily'  ? "strftime('%Y-%m-%d', timestamp)"
          : /* monthly */              "strftime('%Y-%m', timestamp)";
          sql = `
            SELECT ${groupExpr} AS period,
                   COUNT(*) AS samples,
                   AVG(temperature)    AS temperature,
                   AVG(humidity)       AS humidity,
                   AVG(wind_speed)     AS wind_speed,
                   AVG(wind_direction) AS wind_direction,
                   AVG(pressure)       AS pressure,
                   AVG(heat_index)     AS heat_index
            FROM weather_station_readings
            WHERE device_id = ? AND ${whereTime}
            GROUP BY period
            ORDER BY period ASC
          `;
        }

        // Cache key bumped to v2 since the shape (raw vs bucketed) changed.
        return await cacheAndReturn(`ws-history:v2:${stationId}:${range}`, CACHE_TTL_MS, async () => {
          const result = await env.DB.prepare(sql).bind(stationId).all();

          const rows = (result.results || []).map(r => ({
            period: r.period,
            samples: r.samples || 0,
            temperature:    r.temperature    != null ? Number(Number(r.temperature).toFixed(1))    : null,
            humidity:       r.humidity       != null ? Number(Number(r.humidity).toFixed(1))       : null,
            wind_speed:     r.wind_speed     != null ? Number(Number(r.wind_speed).toFixed(2))     : null,
            wind_direction: r.wind_direction != null ? Number(Number(r.wind_direction).toFixed(0)) : null,
            pressure:       r.pressure       != null ? Number(Number(r.pressure).toFixed(1))       : null,
            heat_index:     r.heat_index     != null ? Number(Number(r.heat_index).toFixed(1))     : null,
          }));

          return jsonResponse({
            success: true,
            station_id: stationId,
            range,
            granularity,
            trend: rows,
          }, {}, corsHeaders);
        });
      }

      // --- Daily / range extremes across all weather stations ---
      // Returns network-wide min/max for the 6 surfaced metrics (temp,
      // humidity, wind_speed, wind_direction, pressure, heat_index) along
      // with which station and which timestamp produced the extreme.
      // Powers the "Today's Max / Min" tiles on the WS main view + the
      // per-station-modal "range extremes" panel.
      //
      // ?range= the usual presets (24h, daily, 7d, 30d, 1y) — default daily
      // ?device_id= optional, restrict to one station
      if (path === '/api/weather-stations-extremes' && request.method === 'GET') {
        const range = url.searchParams.get('range') || 'daily';
        const deviceId = url.searchParams.get('device_id') || null;
        let whereTime;
        switch (range) {
          case '24h':  whereTime = "timestamp >= datetime('now', '-24 hours')"; break;
          case '7d':   whereTime = "timestamp >= datetime('now', '-7 days')";   break;
          case '30d':  whereTime = "timestamp >= datetime('now', '-30 days')";  break;
          case '1y':   whereTime = "timestamp >= datetime('now', '-1 year')";   break;
          case 'all':  whereTime = "1=1";                                        break;
          case 'daily':
          default:     whereTime = "timestamp >= datetime('now', 'start of day', '-5 hours')"; break;
        }
        const cacheKey = `ws-extremes:${range}:${deviceId || ''}`;
        return await cacheAndReturn(cacheKey, CACHE_TTL_MS, async () => {
          const deviceFilter = deviceId ? `AND device_id = '${String(deviceId).replace(/'/g, '')}'` : '';
          const result = await env.DB.prepare(`
            SELECT device_id, timestamp, temperature, humidity, wind_speed, wind_direction, pressure, heat_index
            FROM weather_station_readings
            WHERE ${whereTime} ${deviceFilter}
          `).all();
          const rows = result.results || [];

          // Upstream names — best-effort.
          let nameMap = {};
          try {
            const { gauges } = await fetchUpstreamGauges(env);
            for (const g of gauges) nameMap[g.id] = g.name || '';
          } catch (e) { /* non-fatal */ }

          // Walk once, track min/max per metric. Each entry holds the value,
          // the station that produced it, and when. `pressure_mslp` applies
          // the per-station offset so the returned value is MSLP not absolute.
          const metrics = ['temperature', 'humidity', 'wind_speed', 'wind_direction', 'pressure', 'heat_index'];
          const min = {}, max = {};
          for (const r of rows) {
            for (const k of metrics) {
              const raw = r[k];
              if (raw === null || raw === undefined) continue;
              const v = Number(raw);
              if (!Number.isFinite(v)) continue;
              const entry = {
                value: v,
                device_id: r.device_id,
                station_name: nameMap[r.device_id] || '',
                timestamp: r.timestamp,
              };
              if (k === 'pressure') entry.value_mslp = v + (WS_PRESSURE_MSLP_OFFSET[r.device_id] || 0);
              if (!min[k] || v < min[k].value) min[k] = entry;
              if (!max[k] || v > max[k].value) max[k] = entry;
            }
          }

          return jsonResponse({
            success: true,
            range,
            samples: rows.length,
            min,
            max,
          }, {}, corsHeaders);
        });
      }

      // --- Per-gauge CSV export ---
      // Always at native 15-min poll granularity (one CSV row per poll), no
      // bucketing — gives users the raw timeline of online/offline state for
      // their own analysis. range= filters which rows are included. The gauge
      // name comes from the upstream API (we only store IDs in D1) so we do
      // one upstream fetch per request to join names in.
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

        // Fetch rows + the upstream name map in parallel. If upstream is down,
        // we still export the CSV but with blank names rather than failing.
        const [result, upstream] = await Promise.allSettled([
          env.DB.prepare(`
            SELECT timestamp, is_online
            FROM rain_gauge_logs
            WHERE gauge_id = ? AND ${whereTime}
            ORDER BY timestamp ASC
          `).bind(gaugeId).all(),
          fetchUpstreamGauges(env),
        ]);
        const rows = (result.status === 'fulfilled' ? result.value.results : []) || [];
        const upstreamGauges = upstream.status === 'fulfilled' ? upstream.value.gauges : [];
        const gauge = upstreamGauges.find(g => g.id === gaugeId);
        const gaugeName = gauge?.name || '';

        // Build CSV with both UTC and PKT timestamps for analyst convenience
        const headers = ['timestamp_utc', 'timestamp_pkt', 'gauge_id', 'gauge_name', 'is_online', 'status'];
        const lines = [headers.join(',')];
        // CSV-escape names (commas, quotes inside names break the row otherwise)
        const csvEscape = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
        for (const r of rows) {
          // r.timestamp is "YYYY-MM-DD HH:MM:SS" UTC. PKT = +5h.
          const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
          const pktMs = utcDate.getTime() + 5 * 60 * 60 * 1000;
          const pkt = new Date(pktMs).toISOString().replace('T', ' ').substring(0, 19);
          lines.push([
            r.timestamp,
            pkt,
            gaugeId,
            csvEscape(gaugeName),
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

        // Rows from D1 (grouped by gauge so each gauge's history is contiguous)
        // + name map from upstream, in parallel.
        const [result, upstream] = await Promise.allSettled([
          env.DB.prepare(`
            SELECT timestamp, gauge_id, is_online
            FROM rain_gauge_logs
            WHERE ${whereTime}
            ORDER BY gauge_id ASC, timestamp ASC
          `).all(),
          fetchUpstreamGauges(env),
        ]);
        const rows = (result.status === 'fulfilled' ? result.value.results : []) || [];
        const nameMap = {};
        if (upstream.status === 'fulfilled') {
          for (const g of upstream.value.gauges) nameMap[g.id] = g.name || '';
        }

        // Re-order so the output is sorted by GAUGE NAME (analyst-friendly).
        // The SQL gives us rows already grouped by gauge_id and ordered within
        // each group by timestamp; here we just rearrange the groups by name.
        // Group by gauge_id, then sort the groups by name.
        const groupsById = new Map();
        for (const r of rows) {
          if (!groupsById.has(r.gauge_id)) groupsById.set(r.gauge_id, []);
          groupsById.get(r.gauge_id).push(r);
        }
        const sortedGroups = [...groupsById.entries()].sort((a, b) => {
          const na = (nameMap[a[0]] || '').toLowerCase();
          const nb = (nameMap[b[0]] || '').toLowerCase();
          return na.localeCompare(nb);
        });

        const headers = ['timestamp_utc', 'timestamp_pkt', 'gauge_id', 'gauge_name', 'is_online', 'status'];
        const lines = [headers.join(',')];
        const csvEscape = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
        for (const [gaugeId, gaugeRows] of sortedGroups) {
          const name = nameMap[gaugeId] || '';
          for (const r of gaugeRows) {
            const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
            const pktMs = utcDate.getTime() + 5 * 60 * 60 * 1000;
            const pkt = new Date(pktMs).toISOString().replace('T', ' ').substring(0, 19);
            lines.push([
              r.timestamp,
              pkt,
              gaugeId,
              csvEscape(name),
              r.is_online,
              r.is_online === 1 ? 'online' : 'offline',
            ].join(','));
          }
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

      // --- Per-station WS readings CSV export ---
      // Pulls historical temp/humidity/wind/pressure/heat_index from
      // weather_station_readings. Returns both raw and display-converted
      // values (m/s → km/h, deg → cardinal, absolute → MSLP) so analysts
      // have both.
      if (path.startsWith('/api/weather-station-export/') && request.method === 'GET') {
        const stationId = decodeURIComponent(path.split('/').pop());
        if (!stationId) return jsonResponse({ error: 'missing station id' }, { status: 400 }, corsHeaders);
        const range = url.searchParams.get('range') || '24h';
        const startParam = url.searchParams.get('start');
        const endParam   = url.searchParams.get('end');
        let whereTime;
        // Custom range overrides the preset range. Accepts ISO-ish date or
        // datetime strings; we just trust SQLite's permissive parsing.
        if (startParam || endParam) {
          const sanitize = (s) => String(s || '').replace(/[';]/g, '');
          const conds = [];
          if (startParam) conds.push(`timestamp >= '${sanitize(startParam)}'`);
          if (endParam)   conds.push(`timestamp <= '${sanitize(endParam)}'`);
          whereTime = conds.join(' AND ');
        } else switch (range) {
          case 'daily': whereTime = "timestamp >= datetime('now', 'start of day', '-5 hours')"; break;
          case '7d':    whereTime = "timestamp >= datetime('now', '-7 days')";  break;
          case '30d':   whereTime = "timestamp >= datetime('now', '-30 days')"; break;
          case '1y':    whereTime = "timestamp >= datetime('now', '-1 year')";  break;
          case 'all':   whereTime = "1=1";                                       break;
          case '24h':
          default:      whereTime = "timestamp >= datetime('now', '-24 hours')"; break;
        }

        const [result, upstream] = await Promise.allSettled([
          env.DB.prepare(`
            SELECT timestamp, temperature, humidity, wind_speed, wind_direction, pressure, heat_index
            FROM weather_station_readings
            WHERE device_id = ? AND ${whereTime}
            ORDER BY timestamp ASC
          `).bind(stationId).all(),
          fetchUpstreamGauges(env),
        ]);
        const rows = (result.status === 'fulfilled' ? result.value.results : []) || [];
        const upstreamGauges = upstream.status === 'fulfilled' ? upstream.value.gauges : [];
        const station = upstreamGauges.find(g => g.id === stationId);
        const stationName = station?.name || '';
        const mslpOffset = WS_PRESSURE_MSLP_OFFSET[stationId] || 0;

        const headers = [
            'timestamp_utc', 'timestamp_pkt', 'station_id', 'station_name',
            'temperature_c', 'humidity_pct',
            'wind_speed_kmh', 'wind_speed_ms', 'wind_direction_cardinal', 'wind_direction_deg',
            'pressure_mslp_hpa', 'pressure_absolute_hpa', 'heat_index_c',
        ];
        const lines = [headers.join(',')];
        const csvEscape = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
        for (const r of rows) {
          const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
          const pkt = new Date(utcDate.getTime() + 5 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
          const wsKmh = r.wind_speed != null ? (Number(r.wind_speed) * 3.6).toFixed(2) : '';
          const wsMs  = r.wind_speed != null ? Number(r.wind_speed).toFixed(2) : '';
          const wdDeg = r.wind_direction != null ? Number(r.wind_direction).toFixed(0) : '';
          const wdCar = r.wind_direction != null ? degreesToCardinal(r.wind_direction) : '';
          const pAbs  = r.pressure != null ? Number(r.pressure).toFixed(1) : '';
          const pMSLP = r.pressure != null ? (Number(r.pressure) + mslpOffset).toFixed(1) : '';
          lines.push([
            r.timestamp, pkt, stationId, csvEscape(stationName),
            r.temperature ?? '', r.humidity ?? '',
            wsKmh, wsMs, wdCar, wdDeg,
            pMSLP, pAbs, r.heat_index ?? '',
          ].join(','));
        }

        const csv = lines.join('\r\n');
        const filename = `weather-station-${stationId}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
        return new Response(csv, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // --- All-stations WS readings CSV export ---
      if (path === '/api/weather-stations-export' && request.method === 'GET') {
        const range = url.searchParams.get('range') || '24h';
        const startParam = url.searchParams.get('start');
        const endParam   = url.searchParams.get('end');
        let whereTime;
        if (startParam || endParam) {
          const sanitize = (s) => String(s || '').replace(/[';]/g, '');
          const conds = [];
          if (startParam) conds.push(`timestamp >= '${sanitize(startParam)}'`);
          if (endParam)   conds.push(`timestamp <= '${sanitize(endParam)}'`);
          whereTime = conds.join(' AND ');
        } else switch (range) {
          case 'daily': whereTime = "timestamp >= datetime('now', 'start of day', '-5 hours')"; break;
          case '7d':    whereTime = "timestamp >= datetime('now', '-7 days')";  break;
          case '30d':   whereTime = "timestamp >= datetime('now', '-30 days')"; break;
          case '1y':    whereTime = "timestamp >= datetime('now', '-1 year')";  break;
          case 'all':   whereTime = "1=1";                                       break;
          case '24h':
          default:      whereTime = "timestamp >= datetime('now', '-24 hours')"; break;
        }

        const [result, upstream] = await Promise.allSettled([
          env.DB.prepare(`
            SELECT timestamp, device_id, temperature, humidity, wind_speed, wind_direction, pressure, heat_index
            FROM weather_station_readings
            WHERE ${whereTime}
            ORDER BY device_id ASC, timestamp ASC
          `).all(),
          fetchUpstreamGauges(env),
        ]);
        const rows = (result.status === 'fulfilled' ? result.value.results : []) || [];
        const nameMap = {};
        if (upstream.status === 'fulfilled') {
          for (const g of upstream.value.gauges) nameMap[g.id] = g.name || '';
        }

        // Group rows by device_id, then sort groups alphabetically by name so
        // each station's history is contiguous in the CSV.
        const groupsById = new Map();
        for (const r of rows) {
          if (!groupsById.has(r.device_id)) groupsById.set(r.device_id, []);
          groupsById.get(r.device_id).push(r);
        }
        const sortedGroups = [...groupsById.entries()].sort((a, b) => {
          return (nameMap[a[0]] || '').toLowerCase().localeCompare((nameMap[b[0]] || '').toLowerCase());
        });

        const headers = [
            'timestamp_utc', 'timestamp_pkt', 'station_id', 'station_name',
            'temperature_c', 'humidity_pct',
            'wind_speed_kmh', 'wind_speed_ms', 'wind_direction_cardinal', 'wind_direction_deg',
            'pressure_mslp_hpa', 'pressure_absolute_hpa', 'heat_index_c',
        ];
        const lines = [headers.join(',')];
        const csvEscape = (v) => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
        for (const [devId, devRows] of sortedGroups) {
          const name = nameMap[devId] || '';
          const mslpOffset = WS_PRESSURE_MSLP_OFFSET[devId] || 0;
          for (const r of devRows) {
            const utcDate = new Date(r.timestamp.replace(' ', 'T') + 'Z');
            const pkt = new Date(utcDate.getTime() + 5 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
            const wsKmh = r.wind_speed != null ? (Number(r.wind_speed) * 3.6).toFixed(2) : '';
            const wsMs  = r.wind_speed != null ? Number(r.wind_speed).toFixed(2) : '';
            const wdDeg = r.wind_direction != null ? Number(r.wind_direction).toFixed(0) : '';
            const wdCar = r.wind_direction != null ? degreesToCardinal(r.wind_direction) : '';
            const pAbs  = r.pressure != null ? Number(r.pressure).toFixed(1) : '';
            const pMSLP = r.pressure != null ? (Number(r.pressure) + mslpOffset).toFixed(1) : '';
            lines.push([
              r.timestamp, pkt, devId, csvEscape(name),
              r.temperature ?? '', r.humidity ?? '',
              wsKmh, wsMs, wdCar, wdDeg,
              pMSLP, pAbs, r.heat_index ?? '',
            ].join(','));
          }
        }

        const csv = lines.join('\r\n');
        const filename = `weather-stations-all-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
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
              'GET  /api/weather-stations    — live proxy of WS sensor readings',
              'GET  /api/level-sensors       — live proxy of water level + battery',
              'GET  /api/rain-gauges-uptime  — uptime_24h + uptime_1h per device from D1',
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
