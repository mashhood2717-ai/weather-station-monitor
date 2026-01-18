// weatherlink-monitor/src/index.js
// Cloudflare Worker for Weatherwalay/HubService Station Monitoring

// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

// Cache for JWT tokens (in-memory, will refresh on expiry)
const tokenCache = new Map();

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
    
    // Fetch all pages from your API with all required fields including temp for live readings
    for (let page = 1; page <= 6; page++) {
      const response = await fetch(
        `https://hubservice.weatherwalay.com/wms/stations?page=${page}&limit=50&filter={}&search={}&fields={}&globalSearch=`,
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
          const stations = await fetchAllStationsFromHubService(env);
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
      } else if (path === '/api/dashboard-stats') {
        // Get avg uptime/downtime and daily extremes (since midnight PKT)
        return await handleDashboardStats(env, corsHeaders);
      } else if (path === '/api/uptime-trend-chart') {
        // Get uptime trend chart data with configurable range (24h, 7d, 30d, 1y)
        return await handleUptimeTrendChart(env, url, corsHeaders);
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

  // Cron trigger - runs every 15 minutes + daily report at 8 AM PKT
  async scheduled(event, env, ctx) {
    const now = new Date();
    console.log('Cron triggered:', now.toISOString());
    
    // Check if it's time for daily report (8 AM PKT = 3:00 UTC)
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    if (utcHour === 3 && utcMinute < 15) {
      console.log('Sending daily email report...');
      try {
        await sendDailyEmailReport(env);
        console.log('Daily email report sent successfully');
      } catch (e) {
        console.error('Failed to send daily email report:', e.message);
      }
    }
    
    // Sync stations
    await syncAllStations(env);
    
    // Ingest samples (runs every hour)
    try {
      console.log('Ingesting samples...');
      await handleIngestStationSamples(env, {});
    } catch (e) {
      console.warn('Scheduled ingest failed:', e.message);
    }
    
    // Keep 15 months of data (456 days) - cleanup runs with each cron
    try {
      console.log('Cleaning up old logs (keeping 15 months)...');
      await cleanupOldLogs(env, 456);
    } catch (e) {
      console.warn('Cleanup failed:', e.message);
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
  'KCAISLA5': 'corporate', 'IPNIAR1': 'corporate', 'I40aboroad': 'corporate',
  'KMISOL72': 'corporate', 'KWWISLA2': 'owner', 'KLHRPAK12': 'owner',
  'KPMD1': 'reference', 'KPMD2': 'reference', 'KPMD4': 'reference'
  // Add more mappings as needed
};

async function generateDailyReportData(env) {
  // Fetch all stations with current status
  const hubStations = await fetchAllStationsFromHubService(env);
  
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
  const categories = ['corporate', 'community', 'reference', 'owner', 'wu'];
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
  
  // Find MAX temperature with station name
  const stationsWithTemp = stations
    .filter(s => s.status === 'Active' && s.temperature !== null)
    .map(s => ({ name: s.station_name, temp: parseFloat(s.temperature) }))
    .filter(s => !isNaN(s.temp));
  
  let maxTemp = null;
  let maxTempStation = null;
  if (stationsWithTemp.length > 0) {
    const maxTempObj = stationsWithTemp.reduce((max, s) => s.temp > max.temp ? s : max, stationsWithTemp[0]);
    maxTemp = maxTempObj.temp.toFixed(1);
    maxTempStation = maxTempObj.name;
  }
  
  // Find MAX rainfall with station name
  const stationsWithRain = stations
    .filter(s => s.rainfall !== null)
    .map(s => ({ name: s.station_name, rain: parseFloat(s.rainfall) }))
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
      station_name: s.station_name,
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
    
    // Generate CSV content (Excel compatible)
    const headers = ['Station ID', 'Station Name', 'Source', 'Status', 'Category', 'Temperature (°C)', 'Rainfall (mm)', 'Uptime 24h (%)', 'Last Seen'];
    
    const rows = report.all_stations.map(s => [
      s.station_id,
      `"${(s.station_name || '').replace(/"/g, '""')}"`,
      s.api_source,
      s.status,
      s.category,
      s.temperature !== null ? s.temperature : '',
      s.rainfall !== null ? s.rainfall : '',
      s.uptime_24h,
      s.last_seen || ''
    ]);
    
    // Add summary section at top
    const summary = [
      ['WEATHER STATION DAILY REPORT'],
      [`Generated: ${report.report_date}`],
      [''],
      ['SUMMARY'],
      [`Total Stations: ${report.summary.total_stations}`],
      [`Online: ${report.summary.online}`],
      [`Offline: ${report.summary.offline}`],
      [`Uptime: ${report.summary.uptime_percentage}%`],
      [`Max Temperature: ${report.summary.max_temperature || 'N/A'}°C at ${report.summary.max_temp_station || 'N/A'}`],
      [`Max Rainfall: ${report.summary.max_rainfall} mm at ${report.summary.max_rainfall_station}`],
      [''],
      ['CATEGORY BREAKDOWN'],
      ['Category', 'Online', 'Offline', 'Total', 'Uptime %'],
      ...Object.entries(report.category_breakdown).map(([cat, stats]) => 
        [cat.charAt(0).toUpperCase() + cat.slice(1), stats.online, stats.offline, stats.total, stats.uptime_pct + '%']
      ),
      [''],
      ['SOURCE BREAKDOWN'],
      ['Source', 'Online', 'Offline', 'Total', 'Uptime %'],
      ...Object.entries(report.source_breakdown).map(([src, stats]) => 
        [src, stats.online, stats.offline, stats.total, stats.uptime_pct + '%']
      ),
      [''],
      ['STATION DETAILS'],
      headers,
      ...rows
    ];
    
    const csvContent = summary.map(row => row.join(',')).join('\n');
    
    const now = new Date();
    const filename = `weather_report_${now.toISOString().split('T')[0]}.csv`;
    
    return new Response(csvContent, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
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
  <style>
    body { font-family: Arial, sans-serif; color: #1e293b; max-width: 700px; margin: 0 auto; }
    h1 { color: #0284c7; border-bottom: 2px solid #0284c7; padding-bottom: 10px; }
    .summary { display: flex; gap: 15px; margin: 20px 0; flex-wrap: wrap; }
    .stat-box { background: #f1f5f9; padding: 15px 20px; border-radius: 8px; text-align: center; min-width: 120px; }
    .stat-box h3 { margin: 0; color: #64748b; font-size: 12px; text-transform: uppercase; }
    .stat-box .value { font-size: 28px; font-weight: bold; margin: 8px 0 0; }
    .online { color: #10b981; }
    .offline { color: #ef4444; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    tr:nth-child(even) { background: #f8fafc; }
    .footer { margin-top: 30px; color: #64748b; font-size: 12px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; }
    .alert { background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 15px; margin: 15px 0; }
    .alert h3 { color: #ef4444; margin: 0 0 10px; }
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
        // Prefer poi (user-friendly name) over stationName (technical name)
        const displayName = station.poi || station.stationName || 'Unknown';
        const stationName = station.stationName || 'Unknown';
        const apiSource = station.apiSource || null;
        
        // Ensure station exists in stations table (upsert) - use poi as station_name for display
        await env.DB.prepare(`
          INSERT INTO stations (station_id, station_name, location, latitude, longitude, api_source, install_date)
          VALUES (?, ?, ?, ?, ?, ?, date('now'))
          ON CONFLICT(station_id) DO UPDATE SET
            station_name = excluded.station_name,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            api_source = excluded.api_source
        `).bind(
          stationId,
          displayName,
          stationName,
          parseFloat(station.lat) || 0,
          parseFloat(station.long) || 0,
          apiSource
        ).run();
        
        // Use temperature directly from API
        let temperature = null;
        if (station.temperature !== undefined && station.temperature !== null && station.temperature !== 'N/A') {
          temperature = parseFloat(station.temperature);
        }
        
        // Get rainfall if available
        let rainfall = station.rainfall !== undefined && station.rainfall !== null ? parseFloat(station.rainfall) : null;
        
        // Get wind speed if available
        let windSpeed = station.windSpeed !== undefined && station.windSpeed !== null ? parseFloat(station.windSpeed) : null;

        // Insert status log with all sensor data
        await env.DB.prepare(`
          INSERT INTO status_logs 
          (station_id, timestamp, is_online, temperature, rainfall, wind_speed, response_time_ms)
          VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
        `).bind(
          stationId,
          isOnline,
          temperature,
          rainfall,
          windSpeed,
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
    let hubDataMap = {}; // Store HubService data by station_id for live readings
    
    // Always try to fetch from HubService to get live temperature/rainfall
    try {
      const hubStations = await fetchAllStationsFromHubService(env);
      hubStations.forEach(s => {
        hubDataMap[s.stationID] = {
          temperature: s.temperature,
          rainfall: s.rainfall,
          status: s.status
        };
      });
      
      if (cnt < 100) {
        stationMeta = hubStations.map(s => ({
          station_id: s.stationID,
          station_name: s.stationName,
          location: s.stationName,
          latitude: s.lat,
          longitude: s.long,
          temperature: s.temperature,
          rainfall: s.rainfall,
          api_source: s.apiSource,
          status: s.status
        }));
      }
    } catch (e) {
      console.warn('Failed to fetch HubService stations:', e.message);
    }

    // If fallback didn't run or failed, read from local `stations` table
    if (stationMeta.length === 0) {
      const res = await env.DB.prepare(`SELECT station_id, station_name, location, latitude, longitude, api_source FROM stations ORDER BY station_name COLLATE NOCASE ASC`).all();
      stationMeta = (res.results || []).map(r => {
        const hubData = hubDataMap[r.station_id] || {};
        return {
          station_id: r.station_id,
          station_name: r.station_name,
          location: r.location,
          latitude: r.latitude,
          longitude: r.longitude,
          api_source: r.api_source || null,
          temperature: hubData.temperature !== undefined ? hubData.temperature : null,
          rainfall: hubData.rainfall !== undefined ? hubData.rainfall : null,
          status: hubData.status || null
        };
      });
    }

    // Aggregate checks for the set of station IDs (24h)
    const ids = stationMeta.map(s => s.station_id).filter(Boolean);
    let aggMap = {};
    let latestMap = {};
    let lastSeenOnlineMap = {};

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

        // Last time each station was seen ONLINE (is_online = 1)
        const lastSeenSQL = `
          SELECT station_id, MAX(datetime(timestamp, '+5 hours')) as last_seen_online
          FROM status_logs
          WHERE station_id IN (${placeholders}) AND is_online = 1
          GROUP BY station_id
        `;
        try {
          const lastSeenRes = await env.DB.prepare(lastSeenSQL).bind(...batch).all();
          (lastSeenRes.results || []).forEach(r => {
            lastSeenOnlineMap[String(r.station_id)] = r.last_seen_online;
          });
        } catch (e) {
          console.warn('Batch last_seen query failed:', e.message);
        }
      }
    }

    const stations = stationMeta.map(s => {
      const id = String(s.station_id);
      const agg = aggMap[id] || { total_checks: 0, online_checks: 0 };
      const latest = latestMap[id] || {};
      const uptime = agg.total_checks > 0 ? (agg.online_checks * 100.0 / agg.total_checks) : null;
      // Use status from HubService if available, otherwise from latest log
      const statusFromMeta = s.status;
      const statusFromLog = latest.is_online === 1 ? 'Active' : (latest.is_online === 0 ? 'Inactive' : null);
      // Last seen online - when station was last active
      const lastSeenOnline = lastSeenOnlineMap[id] || null;
      return {
        station_id: s.station_id,
        station_name: s.station_name,
        location: s.location,
        latitude: s.latitude,
        longitude: s.longitude,
        api_source: s.api_source || null,
        status: statusFromMeta || statusFromLog || 'Unknown',
        is_active: (statusFromMeta === 'Active' || latest.is_online === 1) ? 1 : 0,
        temperature: latest.temperature !== undefined ? latest.temperature : (s.temperature || null),
        rainfall: s.rainfall || null,
        last_update: latest.last_update || null,
        last_seen: lastSeenOnline,
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
      } else if (env.HUBSERVICE_BASIC_AUTH) {
        // Prefer basic auth - it auto-refreshes tokens
        token = await getHubServiceToken(env.HUBSERVICE_BASIC_AUTH);
      } else if (env.HUBSERVICE_JWT) {
        // Fall back to static JWT token (won't auto-refresh!)
        useProvidedJWTToken(env.HUBSERVICE_JWT);
        token = env.HUBSERVICE_JWT;
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

    // Get downtime records - last 30 days or last 10 records (whichever is more useful)
    const downtimeResult = await env.DB.prepare(`
      SELECT start_time, end_time, duration_minutes, status, reason
      FROM downtime_records
      WHERE station_id = ? AND start_time >= datetime('now', '-30 days')
      ORDER BY start_time DESC
      LIMIT 10
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

// ============================================================
// DASHBOARD STATS - Avg uptime/downtime, daily extremes (since midnight PKT)
// ============================================================
async function handleDashboardStats(env, corsHeaders) {
  try {
    // Get midnight PKT (UTC+5) in UTC format
    const now = new Date();
    const pktNow = new Date(now.getTime() + (5 * 60 * 60 * 1000)); // PKT is UTC+5
    const midnightPKT = new Date(pktNow);
    midnightPKT.setUTCHours(0, 0, 0, 0);
    const midnightUTC = new Date(midnightPKT.getTime() - (5 * 60 * 60 * 1000)); // Convert back to UTC
    const midnightStr = midnightUTC.toISOString().slice(0, 19).replace('T', ' ');
    
    // Get daily extremes since midnight PKT from status_logs - ONLY from online stations
    // station_name now stores poi (user-friendly name), location stores technical stationName
    const dailyExtremesQuery = await env.DB.prepare(`
      SELECT 
        sl.station_id,
        COALESCE(s.station_name, s.location, sl.station_id) as display_name,
        sl.temperature,
        sl.rainfall,
        sl.wind_speed,
        sl.timestamp
      FROM status_logs sl
      LEFT JOIN stations s ON sl.station_id = s.station_id
      WHERE sl.timestamp >= ?
        AND sl.is_online = 1
        AND sl.temperature IS NOT NULL
    `).bind(midnightStr).all();
    
    const rows = dailyExtremesQuery.results || [];
    
    // Find max and min temperature, max rainfall, max wind with station names
    let maxTemp = null, maxTempStation = null;
    let minTemp = null, minTempStation = null;
    let maxRainfall = 0, maxRainfallStation = 'No rainfall';
    let maxWind = 0, maxWindStation = 'No wind data';
    
    for (const row of rows) {
      const temp = parseFloat(row.temperature);
      const rain = parseFloat(row.rainfall) || 0;
      const wind = parseFloat(row.wind_speed) || 0;
      
      if (!isNaN(temp)) {
        if (maxTemp === null || temp > maxTemp) {
          maxTemp = temp;
          maxTempStation = row.display_name || row.station_id;
        }
        if (minTemp === null || temp < minTemp) {
          minTemp = temp;
          minTempStation = row.display_name || row.station_id;
        }
      }
      
      if (rain > maxRainfall) {
        maxRainfall = rain;
        maxRainfallStation = row.display_name || row.station_id;
      }
      
      if (wind > maxWind) {
        maxWind = wind;
        maxWindStation = row.display_name || row.station_id;
      }
    }
    
    // Get average uptime percentage across all stations (last 24 hours)
    const avgUptimeQuery = await env.DB.prepare(`
      SELECT 
        station_id,
        COUNT(*) as total_checks,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks
      FROM status_logs 
      WHERE timestamp >= datetime('now', '-24 hours')
      GROUP BY station_id
    `).all();
    
    const uptimeResults = avgUptimeQuery.results || [];
    let totalUptime = 0;
    let stationCount = 0;
    
    for (const row of uptimeResults) {
      if (row.total_checks > 0) {
        const uptime = (row.online_checks / row.total_checks) * 100;
        totalUptime += uptime;
        stationCount++;
      }
    }
    
    const avgUptimePct = stationCount > 0 ? (totalUptime / stationCount) : 0;
    const avgDowntimePct = 100 - avgUptimePct;
    
    return new Response(JSON.stringify({
      success: true,
      daily_extremes: {
        max_temp: maxTemp !== null ? parseFloat(maxTemp.toFixed(1)) : null,
        max_temp_station: maxTempStation,
        min_temp: minTemp !== null ? parseFloat(minTemp.toFixed(1)) : null,
        min_temp_station: minTempStation,
        max_rainfall: parseFloat(maxRainfall.toFixed(1)),
        max_rainfall_station: maxRainfallStation,
        max_wind_gust: parseFloat(maxWind.toFixed(1)),
        max_wind_gust_station: maxWindStation,
        since_midnight_pkt: midnightStr
      },
      average_uptime: {
        uptime_pct: parseFloat(avgUptimePct.toFixed(1)),
        downtime_pct: parseFloat(avgDowntimePct.toFixed(1)),
        stations_counted: stationCount
      },
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