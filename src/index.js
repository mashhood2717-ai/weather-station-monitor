// weatherlink-monitor/src/index.js
// Cloudflare Worker for Weatherwalay/HubService Station Monitoring

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

// Cache for JWT tokens (in-memory, will refresh on expiry)
const tokenCache = new Map();

// In-memory cache for HubService station data (shared across requests within same isolate)
// This avoids duplicate fetches when multiple endpoints need the same data
let hubStationCache = { data: null, fetchedAt: 0 };
const HUB_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes TTL

// Get JWT token from HubService using Basic auth
async function getHubServiceToken(userCredentials) {
  try {
    // Check if we have a valid cached token
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      console.log('🔑 Using cached JWT token');
      return cached.token;
    }

    // Parse user credentials (format: "phone:password")
    const [loginParam, password] = userCredentials.split(':');

    // Generate dynamic Basic Auth (as per HubService web app pattern)
    const dynamicUsername = `we@therwalay-${Date.now()}`;
    const dynamicPassword = 'we@therwalay_dev#7780';
    const basicAuth = btoa(`${dynamicUsername}:${dynamicPassword}`);

    console.log('🔐 Requesting new JWT token from HubService...');
    const response = await fetch('https://hubservice.weatherwalay.com/ww-Hub/login', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ loginParam, password })
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

    // First, try to use cached token (if not expired)
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      token = cached.token;
      console.log('🔑 Using cached JWT token');
    } else if (env.HUBSERVICE_BASIC_AUTH) {
      // Prefer basic auth - it auto-refreshes tokens
      console.log('🔐 Refreshing JWT token via Basic Auth...');
      token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
    } else if (env.HUBSERVICE_JWT) {
      // Fall back to static JWT token (won't auto-refresh!)
      console.log('⚠️ Using static JWT token (may be expired)');
      useProvidedJWTToken(env.HUBSERVICE_JWT);
      token = env.HUBSERVICE_JWT;
    }

    if (!token) {
      throw new Error('No valid JWT token available');
    }

    const allStations = [];

    // Fetch all pages from your API with only the fields we need (reduces payload ~10x vs fields={})
    const neededFields = JSON.stringify({
      stationID: 1, stationName: 1, poi: 1, lat: 1, long: 1,
      status: 1, apiSource: 1, socketLastUpdate: 1
    });
    for (let page = 1; page <= 6; page++) {
      const response = await fetch(
        `https://hubservice.weatherwalay.com/wms/stations?page=${page}&limit=50&filter={}&search={}&fields=${encodeURIComponent(neededFields)}&globalSearch=`,
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
        // Extract temperature and rainfall from socketLastUpdate
        const processedRecords = data.record.map(station => {
          let temperature = null;
          let rainfall = null;
          let windSpeed = null;

          // Get temp from socketLastUpdate (already in Celsius)
          if (station.socketLastUpdate && station.socketLastUpdate.temp !== undefined && station.socketLastUpdate.temp !== null && station.socketLastUpdate.temp !== 'N/A') {
            temperature = parseFloat(station.socketLastUpdate.temp);
            if (isNaN(temperature)) temperature = null;
          }

          // Try to get rainfall and wind speed from socketLastUpdate.servicesResponses if available
          if (station.socketLastUpdate && station.socketLastUpdate.servicesResponses && Array.isArray(station.socketLastUpdate.servicesResponses) && station.socketLastUpdate.servicesResponses.length > 0) {
            // Check last entry first (most recent data)
            for (let i = station.socketLastUpdate.servicesResponses.length - 1; i >= 0 && (rainfall === null || windSpeed === null); i--) {
              const svcResp = station.socketLastUpdate.servicesResponses[i];

              // Davis format: response is an array with rainfall_daily_mm and wind_speed_hi_last_10_min
              if (svcResp.response && Array.isArray(svcResp.response) && svcResp.response.length > 0) {
                const reading = svcResp.response[0];
                if (rainfall === null && reading.rainfall_daily_mm !== undefined && reading.rainfall_daily_mm !== null) {
                  rainfall = reading.rainfall_daily_mm;
                }
                // Davis wind speed: wind_speed_hi_last_10_min (highest gust in last 10 min, in mph - convert to km/h)
                if (windSpeed === null && reading.wind_speed_hi_last_10_min !== undefined && reading.wind_speed_hi_last_10_min !== null) {
                  windSpeed = parseFloat((reading.wind_speed_hi_last_10_min * 1.60934).toFixed(1)); // mph to km/h
                }
              }

              // WU format: response.observations[0].imperial.precipTotal and windGust
              if ((rainfall === null || windSpeed === null) && svcResp.response && svcResp.response.observations && Array.isArray(svcResp.response.observations) && svcResp.response.observations.length > 0) {
                const obs = svcResp.response.observations[0];
                if (obs.imperial) {
                  // Rainfall: convert inches to mm
                  if (rainfall === null && obs.imperial.precipTotal !== undefined && obs.imperial.precipTotal !== null) {
                    rainfall = parseFloat((obs.imperial.precipTotal * 25.4).toFixed(1));
                  }
                  // Wind gust: convert mph to km/h
                  if (windSpeed === null && obs.imperial.windGust !== undefined && obs.imperial.windGust !== null) {
                    windSpeed = parseFloat((obs.imperial.windGust * 1.60934).toFixed(1));
                  }
                }
              }
            }
          }

          return {
            ...station,
            temperature,
            rainfall,
            windSpeed
          };
        });
        allStations.push(...processedRecords);
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

// Cached wrapper - reuses data within TTL to avoid redundant HubService calls
async function fetchAllStationsFromHubServiceCached(env) {
  const now = Date.now();
  if (hubStationCache.data && (now - hubStationCache.fetchedAt) < HUB_CACHE_TTL_MS) {
    console.log(`📦 Using cached HubService data (age: ${Math.floor((now - hubStationCache.fetchedAt) / 1000)}s, ${hubStationCache.data.length} stations)`);
    return hubStationCache.data;
  }
  const data = await fetchAllStationsFromHubService(env);
  hubStationCache = { data: data, fetchedAt: Date.now() };
  return data;
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
        lng: s.long,
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
      } else if (path === '/api/cleanup') {
        // Manual cleanup - delete logs older than 30 days
        const days = parseInt(url.searchParams.get('days')) || 30;
        const deleted = await cleanupOldLogs(env, days);
        return new Response(JSON.stringify({ success: true, deleted, days_kept: days }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/api/test-hubservice') {
        // Debug endpoint to test HubService API response
        const stationName = url.searchParams.get('name') || 'saad';
        let token = null;
        if (env.HUBSERVICE_BASIC_AUTH) {
          // Prefer basic auth - it auto-refreshes tokens
          token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
        } else if (env.HUBSERVICE_JWT) {
          token = env.HUBSERVICE_JWT;
        }
        if (!token) {
          return new Response(JSON.stringify({ error: 'Failed to get token' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Request all fields including socketData
        const apiUrl = `https://hubservice.weatherwalay.com/wms/stations?page=1&limit=5&filter={}&search={"stationName":"${stationName}"}&fields={}&globalSearch=`;
        const resp = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${token}` } });
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
      } else if (path === '/api/storage-stats') {
        // Get storage statistics
        return await handleStorageStats(env, corsHeaders);
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
        return await handleDashboardStats(env, corsHeaders);
      } else if (path === '/api/uptime-trend-chart') {
        // Get uptime trend chart data with configurable range (24h, 7d, 30d, 1y)
        return await handleUptimeTrendChart(env, url, corsHeaders);
      } else if (path === '/api/send-daily-report') {
        // Manually trigger sending daily email report
        return await handleSendDailyReport(env, corsHeaders);
      } else if (env.ASSETS) {
        // Serve static assets (dashboard SPA)
        return env.ASSETS.fetch(request);
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

  // Cron trigger - runs every 30 minutes (reduced from 15 min to save D1 writes)
  async scheduled(event, env, ctx) {
    const now = new Date();
    console.log('Cron triggered:', now.toISOString());

    // Check if it's time for daily report (8 AM PKT = 3:00 UTC)
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    if (utcHour === 3 && utcMinute < 30) {
      console.log('Sending daily email report...');
      try {
        await sendDailyEmailReport(env);
        console.log('Daily email report sent successfully');
      } catch (e) {
        console.error('Failed to send daily email report:', e.message);
      }
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
        console.log('Cleaning up old logs (keeping 15 months)...');
        await cleanupOldLogs(env, 456);
      } catch (e) {
        console.warn('Cleanup failed:', e.message);
      }
    }
  },
};

// ============================================================
// CLEANUP OLD LOGS - Keep only N days of data
// ============================================================
async function cleanupOldLogs(env, daysToKeep = 30) {
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
    const logsCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM status_logs`).first();
    const samplesCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM station_samples`).first();
    const stationsCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM stations`).first();
    const downtimeCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM downtime_records`).first();

    const dateRange = await env.DB.prepare(`
      SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM status_logs
    `).first();

    // Estimate size (rough: ~150 bytes per log row)
    const estimatedSizeMB = ((logsCount?.count || 0) * 150 + (samplesCount?.count || 0) * 100) / (1024 * 1024);

    return new Response(JSON.stringify({
      success: true,
      counts: {
        status_logs: logsCount?.count || 0,
        station_samples: samplesCount?.count || 0,
        stations: stationsCount?.count || 0,
        downtime_records: downtimeCount?.count || 0
      },
      date_range: {
        oldest: dateRange?.oldest || null,
        newest: dateRange?.newest || null
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
  '169639': 'corporate', 'IKUNRI2': 'wu', '165656': 'corporate', '174221': 'community',
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
  '183871': 'community', '144841': 'community', '131374': 'community', '147435': 'community',
  '131643': 'community', '131893': 'community', '220024': 'corporate', '132393': 'community',
  '132465': 'community', '132463': 'community', '206075': 'community', '133029': 'reference',
  '133035': 'corporate', '133150': 'community', '133253': 'community', '133425': 'community',
  '133509': 'community', '130231': 'community', '134031': 'reference', '134038': 'reference',
  '201736': 'community', '129498': 'corporate', '134268': 'community', '134297': 'community',
  'IKARAC41': 'wu', 'IISLAM21': 'wu', '137535': 'reference', '137991': 'corporate',
  'IISLAM25': 'wu', 'IISLAM26': 'wu', '146260': 'corporate', '147145': 'corporate',
  'C3': 'reference', '147425': 'community', 'C1': 'reference', '150067': 'community',
  '150367': 'reference', '150967': 'corporate', '131812': 'reference', '129090': 'community',
  '129952': 'community', '142628': 'corporate', '139347': 'community', '133500': 'community',
  '217831': 'community',
  // WOW - Toll Plaza Stations
  '216612': 'wow', '221544': 'wow', '221563': 'wow', '221555': 'wow', '221695': 'wow',
  '221726': 'wow', '221703': 'wow', '221746': 'wow', '221873': 'wow', '221910': 'wow',
  '221938': 'wow', '221876': 'wow', '221803': 'wow', '221884': 'wow', '228127': 'wow'
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
      longitude: s.long,
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

async function handleSendDailyReport(env, corsHeaders) {
  try {
    const result = await sendDailyEmailReport(env);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
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
    `).bind(d.stationId, d.displayName, d.stationName, parseFloat(station.lat) || 0, parseFloat(station.long) || 0, d.apiSource);
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

    // Fetch live data from HubService
    try {
      const hubStations = await fetchAllStationsFromHubServiceCached(env);
      stations = hubStations.map(s => ({
        station_id: s.stationID,
        station_name: s.stationName,
        location: s.poi || s.stationName,
        latitude: s.lat,
        longitude: s.long,
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
    const uptimeSQL = `
      SELECT station_id, 
             COUNT(*) as checks_24h, 
             SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as uptime_24h,
             MAX(CASE WHEN is_online = 1 THEN datetime(timestamp, '+5 hours') END) as last_seen
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
          last_seen: r.last_seen
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
        last_seen: up.last_seen || null
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

// Legacy function to sync a single station by ID from HubService API
async function syncSingleStationById(env, stationId) {
  const syncStart = Date.now();

  try {
    let token = null;

    // First, try to use cached token (if not expired)
    const cached = tokenCache.get('hubservice_jwt');
    if (cached && cached.expiresAt > Date.now()) {
      token = cached.token;
    } else if (env.HUBSERVICE_BASIC_AUTH) {
      // Prefer basic auth - it auto-refreshes tokens
      token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
    } else if (env.HUBSERVICE_JWT) {
      // Fall back to static JWT token (won't auto-refresh!)
      useProvidedJWTToken(env.HUBSERVICE_JWT);
      token = env.HUBSERVICE_JWT;
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
        longitude: s.long
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

      // Get uptime data from database for all stations based on time range
      let uptimeSQL = `
        SELECT 
          station_id,
          COUNT(*) as total_checks,
          SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
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
    // default: hourly; days >=7 -> daily, days >=90 -> monthly, days >=1095 -> yearly
    let granularity = 'hour';
    if (days >= 1095) granularity = 'year';
    else if (days >= 90) granularity = 'month';
    else if (days >= 7) granularity = 'day';

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
          longitude: s.long,
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
    const sixHoursBeforeMidnight = new Date(midnightUTC.getTime() - (6 * 60 * 60 * 1000)).toISOString().slice(0, 19).replace('T', ' ');

    // Seasonal temperature validation for Pakistan
    const currentMonth = now.getMonth() + 1;
    const isSummer = currentMonth >= 4 && currentMonth <= 9;
    const MIN_VALID_TEMP = isSummer ? 5 : -15;
    const MAX_VALID_TEMP = isSummer ? 52 : 40;

    // OPTIMIZED: Single query with stale detection + extremes using CTEs
    const extremesQuery = await env.DB.prepare(`
      WITH 
      -- Detect stale/frozen temperature sensors (same value before & after midnight)
      stale_temp_stations AS (
        SELECT station_id
        FROM status_logs
        WHERE timestamp >= ? AND temperature IS NOT NULL AND is_online = 1
        GROUP BY station_id
        HAVING 
          SUM(CASE WHEN timestamp < ? THEN 1 ELSE 0 END) >= 2
          AND SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) >= 2
          AND COUNT(DISTINCT ROUND(temperature, 1)) = 1
          AND COUNT(*) >= 4
      ),
      -- Store midnight timestamp for reuse
      midnight_pkt_utc AS (
        SELECT ? as midnight_time
      ),
      -- Detect stale rainfall: reading at midnight = reading before midnight AND no change after (frozen sensor)
      stale_rain_stations AS (
        SELECT DISTINCT sl1.station_id
        FROM status_logs sl1, midnight_pkt_utc
        WHERE sl1.timestamp >= midnight_pkt_utc.midnight_time 
          AND sl1.timestamp <= datetime(midnight_pkt_utc.midnight_time, '+1 minute')
          AND sl1.rainfall IS NOT NULL
          AND sl1.rainfall > 2
          AND EXISTS (
            -- Same value before midnight
            SELECT 1 FROM status_logs sl2
            WHERE sl2.station_id = sl1.station_id
              AND sl2.timestamp >= datetime(midnight_pkt_utc.midnight_time, '-15 minutes')
              AND sl2.timestamp < midnight_pkt_utc.midnight_time
              AND sl2.rainfall = sl1.rainfall
          )
          AND EXISTS (
            -- All zeros or same value after midnight (no new rainfall)
            SELECT 1 FROM status_logs sl3
            WHERE sl3.station_id = sl1.station_id
              AND sl3.timestamp > datetime(midnight_pkt_utc.midnight_time, '+1 minute')
              AND sl3.timestamp <= datetime(midnight_pkt_utc.midnight_time, '+2 hours')
            GROUP BY sl3.station_id
            HAVING MAX(sl3.rainfall) <= COALESCE(MAX(CASE WHEN sl3.rainfall = 0 THEN 0 ELSE sl1.rainfall END), sl1.rainfall)
          )
      ),
      -- Today's valid data excluding stale sensors
      today_data AS (
        SELECT 
          sl.station_id,
          s.station_name as display_name,
          sl.temperature,
          sl.rainfall,
          sl.wind_speed,
          sl.timestamp
        FROM status_logs sl
        LEFT JOIN stations s ON sl.station_id = s.station_id
        WHERE sl.timestamp >= ?
          AND sl.is_online = 1
      ),
      -- Max temp (excluding stale)
      max_temp_result AS (
        SELECT station_id, display_name, temperature as value, 'max_temp' as metric
        FROM today_data
        WHERE temperature IS NOT NULL 
          AND temperature BETWEEN ${MIN_VALID_TEMP} AND ${MAX_VALID_TEMP}
          AND station_id NOT IN (SELECT station_id FROM stale_temp_stations)
        ORDER BY temperature DESC LIMIT 1
      ),
      -- Min temp (excluding stale)
      min_temp_result AS (
        SELECT station_id, display_name, temperature as value, 'min_temp' as metric
        FROM today_data
        WHERE temperature IS NOT NULL 
          AND temperature BETWEEN ${MIN_VALID_TEMP} AND ${MAX_VALID_TEMP}
          AND station_id NOT IN (SELECT station_id FROM stale_temp_stations)
        ORDER BY temperature ASC LIMIT 1
      ),
      -- Max rain (excluding stale)
      max_rain_result AS (
        SELECT station_id, display_name, rainfall as value, 'max_rain' as metric
        FROM today_data
        WHERE rainfall IS NOT NULL AND rainfall > 0 AND rainfall < 500
          AND station_id NOT IN (SELECT station_id FROM stale_rain_stations)
        ORDER BY rainfall DESC LIMIT 1
      ),
      -- Max wind
      max_wind_result AS (
        SELECT station_id, display_name, wind_speed as value, 'max_wind' as metric
        FROM today_data
        WHERE wind_speed IS NOT NULL AND wind_speed > 0
        ORDER BY wind_speed DESC LIMIT 1
      )
      SELECT * FROM max_temp_result
      UNION ALL SELECT * FROM min_temp_result
      UNION ALL SELECT * FROM max_rain_result
      UNION ALL SELECT * FROM max_wind_result
    `).bind(sixHoursBeforeMidnight, midnightStr, midnightStr, midnightStr, midnightStr).all();

    // Parse results
    let maxTemp = null, maxTempStation = null;
    let minTemp = null, minTempStation = null;
    let maxRainfall = '0.0', maxRainfallStation = 'No rainfall';
    let maxWind = '0.0', maxWindStation = 'No wind data';

    for (const row of (extremesQuery.results || [])) {
      if (row.metric === 'max_temp' && row.value !== null) {
        maxTemp = parseFloat(row.value).toFixed(1);
        maxTempStation = row.display_name;
      } else if (row.metric === 'min_temp' && row.value !== null) {
        minTemp = parseFloat(row.value).toFixed(1);
        minTempStation = row.display_name;
      } else if (row.metric === 'max_rain' && row.value !== null) {
        maxRainfall = parseFloat(row.value).toFixed(1);
        maxRainfallStation = row.display_name || 'Unknown';
      } else if (row.metric === 'max_wind' && row.value !== null) {
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
        (SELECT COUNT(*) FROM status_logs WHERE timestamp >= ?) as records_since_midnight
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