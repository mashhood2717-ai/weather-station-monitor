// weatherlink-monitor/src/index.js
// Cloudflare Worker for Weatherwalay/HubService Station Monitoring

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

// Cache for JWT tokens (in-memory, will refresh on expiry)
const tokenCache = new Map();

// Get JWT token from HubService using Basic auth
async function getHubServiceToken(basicAuthCredentials) {
  try {
    // Check if we have a valid cached token
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      console.log('🔑 Using cached JWT token');
      return cached.token;
    }

    console.log('🔐 Requesting new JWT token from HubService...');
    const response = await fetch('https://hubservice.weatherwalay.com/ww-Hub/login', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuthCredentials}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      console.error(`Login failed: ${response.status}`);
      const text = await response.text();
      console.error(`Response: ${text}`);
      return null;
    }

    const data = await response.json();
    const token = data.token;
    
    if (!token) {
      console.error('No token in response');
      return null;
    }

    // Try to decode token to get expiry time (JWT format: header.payload.signature)
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        // Decode payload
        const payload = JSON.parse(
          decodeURIComponent(
            atob(parts[1])
              .split('')
              .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join('')
          )
        );
        
        // Store token with expiry (subtract 5 minutes as buffer)
        const expiresAt = (payload.exp * 1000) - (5 * 60 * 1000);
        tokenCache.set('hubservice_jwt', { token, expiresAt });
        
        console.log(`✅ Got new JWT token, expires in ${Math.floor((expiresAt - Date.now()) / 1000)}s`);
        return token;
      }
    } catch (e) {
      console.warn('Could not parse JWT expiry:', e);
      // Store without expiry knowledge - will try again next time
      tokenCache.set('hubservice_jwt', { 
        token, 
        expiresAt: Date.now() + (24 * 60 * 60 * 1000) // Assume 24 hours
      });
      return token;
    }

    return token;
  } catch (error) {
    console.error('Error getting HubService token:', error);
    return null;
  }
}

// Use a pre-provided JWT token directly (if available)
function useProvidedJWTToken(jwtToken) {
  try {
    // Decode token to get expiry time
    const parts = jwtToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(
        decodeURIComponent(
          atob(parts[1])
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        )
      );
      
      // Store token with expiry (subtract 5 minutes as buffer)
      const expiresAt = (payload.exp * 1000) - (5 * 60 * 1000);
      tokenCache.set('hubservice_jwt', { token: jwtToken, expiresAt });
      
      console.log(`✅ Cached provided JWT token, expires in ${Math.floor((expiresAt - Date.now()) / 1000)}s`);
      return true;
    }
  } catch (e) {
    console.warn('Could not parse provided JWT token:', e);
  }
  return false;
}

// Helper function to convert Fahrenheit to Celsius
function fahrenheitToCelsius(fahrenheit) {
  if (fahrenheit === null || fahrenheit === undefined) return null;
  return Math.round((fahrenheit - 32) * 5 / 9 * 10) / 10; // Round to 1 decimal
}

// Fetch all stations from HubService API (your main API)
async function fetchAllStationsFromHubService(env) {
  try {
    let token = null;
    
    // First, try to use cached token
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      token = cached.token;
      console.log('🔑 Using cached JWT token');
    } else if (env.HUBSERVICE_JWT) {
      // Try to use provided JWT token
      console.log('Using provided JWT token');
      useProvidedJWTToken(env.HUBSERVICE_JWT);
      token = env.HUBSERVICE_JWT;
    } else if (env.HUBSERVICE_BASIC_AUTH) {
      // Fall back to login with basic auth
      token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
    }
    
    if (!token) {
      throw new Error('No valid JWT token available');
    }

    const allStations = [];
    
    // Fetch all pages from your API
    for (let page = 1; page <= 6; page++) {
      const response = await fetch(
        `https://hubservice.weatherwalay.com/wms/stations?page=${page}&limit=50&filter={}&search={}&fields={"stationName":1,"stationID":1,"poi":1,"socketLastUpdate":1,"status":1,"latitude":1,"longitude":1}&globalSearch=`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      if (!response.ok) {
        console.warn(`HubService API page ${page} error: ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.record && Array.isArray(data.record)) {
        allStations.push(...data.record);
      }
    }

    if (allStations.length === 0) {
      throw new Error('No stations retrieved from HubService API');
    }

    console.log(`✅ Fetched ${allStations.length} stations from HubService`);
    return allStations;
  } catch (error) {
    console.error('Error fetching from HubService:', error);
    throw error;
  }
}



// Sync stations from HubService API
async function syncNewStations(env) {
  try {
    // Get all stations from HubService API (no token required)
    const apiStations = await fetchAllStationsFromHubService(env);
    
    if (apiStations.length === 0) {
      console.log('No stations found from HubService API');
      return { added: 0, stations: [] };
    }
    
    // Get existing stations from database
    const existingStations = await env.DB.prepare(`
      SELECT station_id FROM stations
    `).all();
    
    const existingIds = new Set(existingStations.results.map(s => s.station_id.toString()));
    
    // Transform HubService stations to our format
    const newStations = apiStations
      .filter(s => !existingIds.has(s.stationID.toString()))
      .map(s => ({
        stationID: s.stationID,
        stationName: s.stationName,
        poi: s.poi,
        status: s.status,
        latitude: s.latitude,
        longitude: s.longitude
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
          station.poi || station.stationName,
          station.poi || station.stationName,
          parseFloat(station.latitude) || 0,
          parseFloat(station.longitude) || 0,
          new Date().toISOString().split('T')[0]
        ).run();
        
        addedStations.push({ id: station.stationID, name: station.poi || station.stationName });
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API Routes
      if (path === '/api/stations-with-uptime') {
        return await handleStationsWithUptimeRequest(env, corsHeaders);
      }
      if (path === '/api/stations') {
        return await handleStationsRequest(env, corsHeaders);
      } else if (path === '/api/stats') {
        return await handleStatsRequest(env, corsHeaders);
      } else if (path === '/api/alerts') {
        return await handleAlertsRequest(env, corsHeaders);
      } else if (path === '/api/station') {
        const stationId = url.searchParams.get('id');
        return await handleStationDetailRequest(env, stationId, corsHeaders);
      } else if (path === '/api/sync') {
        // Manual trigger for testing
        return await syncAllStations(env, corsHeaders);
      } else if (path === '/api/uptime-trend') {
        // Get 24-hour uptime trend for all stations
        return await handleUptimeTrendRequest(env, corsHeaders);
      } else if (path === '/api/uptime-percentages') {
        // Get uptime percentages for all stations or specific ones
        return await handleUptimePercentagesRequest(env, request, corsHeaders);
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
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  // Cron trigger - runs every 1 hour
  async scheduled(event, env, ctx) {
    const now = new Date();
    console.log('Cron triggered:', now.toISOString());
    
    // Sync stations
    await syncAllStations(env);
    
    // Ingest samples (runs every hour)
    try {
      console.log('Ingesting samples...');
      await handleIngestStationSamples(env, {});
    } catch (e) {
      console.warn('Scheduled ingest failed:', e.message);
    }
  },
};

// ============================================================
// WEATHERWALAY/HUBSERVICE API ONLY
// ============================================================

// ============================================================
// SYNC ALL STATIONS
// ============================================================

async function syncAllStations(env, corsHeaders = {}) {
  console.log('Starting station sync...');
  const startTime = Date.now();

  try {
    // Fetch ALL stations from HubService API in one go
    const apiStations = await fetchAllStationsFromHubService(env);
    
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

    console.log(`Fetched ${apiStations.length} stations from HubService for sync`);

    let successCount = 0;
    let failCount = 0;

    // Process stations sequentially to avoid DB conflicts
    for (const station of apiStations) {
      try {
        const stationId = String(station.stationID);
        const isOnline = station.status === 'Active' ? 1 : 0;
        const stationName = station.poi || station.stationName || 'Unknown';
        
        // Ensure station exists in stations table (upsert)
        await env.DB.prepare(`
          INSERT INTO stations (station_id, station_name, location, latitude, longitude, install_date)
          VALUES (?, ?, ?, ?, ?, date('now'))
          ON CONFLICT(station_id) DO UPDATE SET
            station_name = excluded.station_name,
            latitude = excluded.latitude,
            longitude = excluded.longitude
        `).bind(
          stationId,
          stationName,
          stationName,
          parseFloat(station.latitude) || 0,
          parseFloat(station.longitude) || 0
        ).run();
        
        // Extract temperature
        let temperature = null;
        if (station.socketLastUpdate && station.socketLastUpdate.temp && station.socketLastUpdate.temp !== 'N/A') {
          temperature = parseFloat(station.socketLastUpdate.temp);
        }

        // Insert status log
        await env.DB.prepare(`
          INSERT INTO status_logs 
          (station_id, timestamp, is_online, temperature, response_time_ms)
          VALUES (?, datetime('now'), ?, ?, ?)
        `).bind(
          stationId,
          isOnline,
          temperature,
          0
        ).run();

        successCount++;
      } catch (error) {
        // Log the first few errors for debugging
        if (failCount < 3) {
          console.error(`Failed to sync ${station.stationID}: ${error.message}`);
        }
        failCount++;
      }
    }

    console.log(`Sync result: ${successCount} success, ${failCount} failed`);

    const duration = Date.now() - startTime;
    const result = {
      success: true,
      synced: successCount,
      failed: failCount,
      total: apiStations.length,
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    };

    console.log('Sync completed:', result);

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
    // Check how many stations we have in our local `stations` table.
    const cntRes = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM stations`).first();
    const cnt = (cntRes && cntRes.cnt) ? parseInt(cntRes.cnt) : 0;

    // If the local table is small (e.g. < 100), fall back to HubService to fetch the full list
    let stationMeta = [];
    if (cnt < 100) {
      try {
        const hubStations = await fetchAllStationsFromHubService(env);
        stationMeta = hubStations.map(s => ({
          station_id: s.stationID,
          station_name: s.poi || s.stationName,
          location: s.poi || s.stationName,
          latitude: s.latitude,
          longitude: s.longitude
        }));
      } catch (e) {
        console.warn('Failed to fetch HubService stations fallback:', e.message);
      }
    }

    // If fallback didn't run or failed, read from local `stations` table
    if (stationMeta.length === 0) {
      const res = await env.DB.prepare(`SELECT station_id, station_name, location, latitude, longitude FROM stations ORDER BY station_name COLLATE NOCASE ASC`).all();
      stationMeta = (res.results || []).map(r => ({
        station_id: r.station_id,
        station_name: r.station_name,
        location: r.location,
        latitude: r.latitude,
        longitude: r.longitude
      }));
    }

    // Aggregate checks for the set of station IDs (24h)
    const ids = stationMeta.map(s => s.station_id).filter(Boolean);
    let aggMap = {};
    let latestMap = {};

    if (ids.length > 0) {
      // Process IDs in batches to avoid SQLite variable limit
      const batchSize = 80;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');

        // Aggregated uptime in last 24h for this batch
        const aggSQL = `
          SELECT station_id, COUNT(*) as total_checks, SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks
          FROM status_logs
          WHERE timestamp >= datetime('now', '-24 hours') AND station_id IN (${placeholders})
          GROUP BY station_id
        `;
        try {
          const aggRes = await env.DB.prepare(aggSQL).bind(...batch).all();
          (aggRes.results || []).forEach(r => {
            aggMap[String(r.station_id)] = { total_checks: r.total_checks || 0, online_checks: r.online_checks || 0 };
          });
        } catch (e) {
          console.warn('Batch agg query failed:', e.message);
        }

        // Latest status per station for this batch
        const latestSQL = `
          SELECT t1.station_id, t1.is_online, t1.temperature, t1.timestamp
          FROM status_logs t1
          WHERE t1.station_id IN (${placeholders})
          AND t1.timestamp = (
            SELECT MAX(t2.timestamp) FROM status_logs t2 WHERE t2.station_id = t1.station_id
          )
        `;
        try {
          const latestRes = await env.DB.prepare(latestSQL).bind(...batch).all();
          (latestRes.results || []).forEach(r => {
            latestMap[String(r.station_id)] = { is_online: r.is_online, temperature: r.temperature, last_update: r.timestamp };
          });
        } catch (e) {
          console.warn('Batch latest query failed:', e.message);
        }
      }
    }

    const stations = stationMeta.map(s => {
      const id = String(s.station_id);
      const agg = aggMap[id] || { total_checks: 0, online_checks: 0 };
      const latest = latestMap[id] || {};
      const uptime = agg.total_checks > 0 ? (agg.online_checks * 100.0 / agg.total_checks) : null;
      return {
        station_id: s.station_id,
        station_name: s.station_name,
        location: s.location,
        latitude: s.latitude,
        longitude: s.longitude,
        status: latest.is_online === 1 ? 'Active' : (latest.is_online === 0 ? 'Inactive' : 'Unknown'),
        is_active: latest.is_online === 1 ? 1 : 0,
        temperature: latest.temperature !== undefined ? latest.temperature : null,
        last_update: latest.last_update || null,
        checks_24h: agg.total_checks || 0,
        uptime_24h: uptime !== null ? Number(parseFloat(uptime).toFixed(2)) : null
      };
    });

    return new Response(JSON.stringify({ success: true, total: stations.length, stations }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Error in stations-with-uptime:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function syncSingleStation(env, stationId) {
  const syncStart = Date.now();

  try {
    let token = null;
    
    // First, try to use cached token
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      token = cached.token;
    } else if (env.HUBSERVICE_JWT) {
      // Try to use provided JWT token
      useProvidedJWTToken(env.HUBSERVICE_JWT);
      token = env.HUBSERVICE_JWT;
    } else if (env.HUBSERVICE_BASIC_AUTH) {
      // Fall back to login with basic auth
      token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
    }
    
    if (!token) {
      console.warn(`Cannot sync station ${stationId}: No valid JWT token`);
      return { success: false, error: 'No JWT token available' };
    }

    // Get current station data from HubService
    const response = await fetch(
      `https://hubservice.weatherwalay.com/wms/stations?filter={"stationID":"${stationId}"}&fields={"stationID":1,"stationName":1,"status":1,"socketLastUpdate":1}&limit=1`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
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
  const online = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM (
      SELECT station_id, is_online,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
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
              WHERE station_id = s.station_id AND is_online = 1),
             '2000-01-01'
           )
          ), '+5 hours'
        )
      ) as went_offline_at
    FROM stations s
    JOIN (
      SELECT station_id, is_online, timestamp,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
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
              WHERE station_id = s.station_id AND is_online = 1),
             '2000-01-01'
           )
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
              WHERE station_id = s.station_id AND is_online = 1),
             '2000-01-01'
           )
          ), '+5 hours'
        ))) * 24 * 60
      ) as minutes
    FROM stations s
    JOIN (
      SELECT station_id, is_online, timestamp,
             ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY timestamp DESC) as rn
      FROM status_logs
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
    
    // Check if this is a POST request with station IDs
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        stationIds = body.station_ids || []; // Array of station IDs from dashboard
      } catch (e) {
        console.warn('Could not parse POST body');
      }
    }
    
    // Fetch from HubService to get all stations with their status
    try {
      let token = null;
      
      // First, try to use cached token
      const cached = tokenCache.get('hubservice_jwt');
      if (cached && cached.expiresAt > Date.now()) {
        token = cached.token;
        console.log('🔑 Using cached JWT token');
      } else if (env.HUBSERVICE_JWT) {
        // Try to use provided JWT token
        console.log('Using provided JWT token');
        useProvidedJWTToken(env.HUBSERVICE_JWT);
        token = env.HUBSERVICE_JWT;
      } else if (env.HUBSERVICE_BASIC_AUTH) {
        // Fall back to login with basic auth
        token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
      }
      
      if (!token) {
        throw new Error('No valid JWT token available');
      }

      // Fetch all pages from HubService
      const allStations = [];
      for (let page = 1; page <= 6; page++) {
        const response = await fetch(
          `https://hubservice.weatherwalay.com/wms/stations?page=${page}&limit=50&filter={}&search={}&fields={"stationID":1,"poi":1,"stationName":1,"status":1,"socketLastUpdate":1,"latitude":1,"longitude":1}&globalSearch=`,
          {
            headers: { 'Authorization': `Bearer ${token}` }
          }
        );

        if (response.ok) {
          const data = await response.json();
          if (data.record && Array.isArray(data.record)) {
            allStations.push(...data.record);
          }
        }
      }

      console.log(`✅ Fetched ${allStations.length} total stations from HubService`);

      // If station IDs provided, filter; otherwise return all
      let result = [];
      
      if (stationIds.length > 0) {
        const stationIdSet = new Set(stationIds.map(id => String(id)));
        result = allStations.filter(s => stationIdSet.has(String(s.stationID)));
      } else {
        result = allStations;
      }

      // Get uptime data from database for all stations (last 24 hours)
      const uptimeQuery = await env.DB.prepare(`
        SELECT 
          station_id,
          COUNT(*) as total_checks,
          SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
          MIN(timestamp) as first_check
        FROM status_logs 
        WHERE timestamp >= datetime('now', '-24 hours')
        GROUP BY station_id
      `).all();
      
      const uptimeMap = {};
      for (const row of (uptimeQuery.results || [])) {
        uptimeMap[String(row.station_id)] = {
          total: row.total_checks,
          online: row.online_checks,
          percentage: row.total_checks > 0 ? ((row.online_checks / row.total_checks) * 100).toFixed(1) : 0,
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
    // default: hourly; days >=7 -> daily, days >=30 -> monthly, days >=365 -> yearly
    let granularity = 'hour';
    if (days >= 365) granularity = 'year';
    else if (days >= 30) granularity = 'month';
    else if (days >= 7) granularity = 'day';

    // Get station info from HubService (best-effort)
    let stationInfo = null;
    try {
      let token = null;
      const cached = tokenCache.get('hubservice_jwt');
      if (cached && cached.expiresAt > Date.now()) {
        token = cached.token;
      } else if (env.HUBSERVICE_JWT) {
        useProvidedJWTToken(env.HUBSERVICE_JWT);
        token = env.HUBSERVICE_JWT;
      } else if (env.HUBSERVICE_BASIC_AUTH) {
        token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
      }

      if (token) {
        const response = await fetch(
          `https://hubservice.weatherwalay.com/wms/stations?filter={"stationID":"${stationId}"}&fields={"stationID":1,"poi":1,"stationName":1,"status":1,"socketLastUpdate":1,"latitude":1,"longitude":1,"ownedBy":1}&limit=1`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );

        if (response.ok) {
          const data = await response.json();
          if (data.record && data.record[0]) {
            const s = data.record[0];
            stationInfo = {
              station_id: s.stationID,
              station_name: s.poi || s.stationName,
              status: s.status,
              is_active: s.status === 'Active' ? 1 : 0,
              temperature: s.socketLastUpdate?.temp || null,
              humidity: s.socketLastUpdate?.hum || null,
              wind_speed: s.socketLastUpdate?.ws || null,
              pressure: s.socketLastUpdate?.bp || null,
              latitude: s.latitude,
              longitude: s.longitude,
              owned_by: s.ownedBy
            };
          }
        }
      }
    } catch (e) {
      console.warn('Could not fetch station info from HubService:', e.message);
    }

    // Choose SQL grouping expression and time filter
    let timeFilter = `timestamp >= datetime('now', '-${hoursToFetch} hours')`;
    let groupExpr = "strftime('%Y-%m-%d %H:00:00', timestamp)";
    let labelFormatter = (v) => new Date(v + 'Z').toISOString();

    if (granularity === 'day') {
      timeFilter = `timestamp >= datetime('now', '-${days} days')`;
      groupExpr = "strftime('%Y-%m-%d', timestamp)";
      labelFormatter = (v) => v; // YYYY-MM-DD
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
        period = now.toISOString().slice(0,10);
        period_label = period;
      } else if (granularity === 'month') {
        period = now.toISOString().slice(0,7);
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
          const match = aggRows.find(r => r.bucket.replace(' ', 'T') === bucket.replace('Z', '')) || aggRows.find(r => r.bucket === bucket.replace('T',' '));
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
          const bucket = dt.toISOString().slice(0,10); // YYYY-MM-DD
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
          const bucket = dt.toISOString().slice(0,7); // YYYY-MM
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

    // Get downtime records in the range
    const downtimeResult = await env.DB.prepare(`
      SELECT start_time, end_time, duration_minutes, status, reason
      FROM downtime_records
      WHERE station_id = ? AND start_time >= datetime('now', '-${hoursToFetch} hours')
      ORDER BY start_time DESC
    `).bind(stationId).all();
    const downtimes = downtimeResult.results || [];

    const totalDowntimeMinutes = downtimes.reduce((acc, d) => acc + (d.duration_minutes || 0), 0);

    // Overall uptime based on aggregated checks if available
    const overallTotal = aggRows.reduce((a,b) => a + (b.total_checks||0), 0);
    const overallOnline = aggRows.reduce((a,b) => a + (b.online_checks||0), 0);
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
        incidents: downtimes.length,
        records: downtimes
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
      const endNextStr = endNext.toISOString().slice(0,19).replace('T',' ');
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