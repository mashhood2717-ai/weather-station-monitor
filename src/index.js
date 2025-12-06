// weatherlink-monitor/src/index.js
// Cloudflare Worker for Davis WeatherLink Station Monitoring

import crypto from 'node:crypto';

// Helper function to convert Fahrenheit to Celsius
function fahrenheitToCelsius(fahrenheit) {
  if (fahrenheit === null || fahrenheit === undefined) return null;
  return Math.round((fahrenheit - 32) * 5 / 9 * 10) / 10; // Round to 1 decimal
}

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

  // Cron trigger - runs every 30 minutes
  async scheduled(event, env, ctx) {
    console.log('Cron triggered:', new Date().toISOString());
    await syncAllStations(env);
  },
};

// ============================================================
// DAVIS WEATHERLINK API AUTHENTICATION
// ============================================================

function generateWeatherLinkSignature(apiSecret, params) {
  // Sort parameters (api-secret already removed)
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}${params[key]}`)
    .join('');
  
  return crypto
    .createHmac('sha256', apiSecret)
    .update(sortedParams)
    .digest('hex');
}

async function fetchWeatherLinkData(env, stationId) {
  const apiKey = env.WEATHERLINK_API_KEY;
  const apiSecret = env.WEATHERLINK_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);

  // Build parameters (WITHOUT api-secret for signature)
  const params = {
    'api-key': apiKey,
    'station-id': stationId.toString(),
    't': timestamp,
  };

  // Generate signature (api-secret NOT included in params)
  const signature = generateWeatherLinkSignature(apiSecret, params);

  // Build URL with station-id in PATH
  const url = `https://api.weatherlink.com/v2/current/${stationId}?api-key=${apiKey}&api-signature=${signature}&t=${timestamp}`;

  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`WeatherLink API error: ${response.status}`);
  }

  return await response.json();
}

// ============================================================
// SYNC ALL STATIONS
// ============================================================

async function syncAllStations(env, corsHeaders = {}) {
  console.log('Starting station sync...');
  const startTime = Date.now();

  try {
    // Get all stations from database
    const stationsResult = await env.DB.prepare(
      'SELECT station_id, station_name FROM stations'
    ).all();

    const stations = stationsResult.results;
    console.log(`Found ${stations.length} stations to sync`);

    let successCount = 0;
    let failCount = 0;

    // Process stations in batches to avoid timeouts
    const batchSize = 10;
    for (let i = 0; i < stations.length; i += batchSize) {
      const batch = stations.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (station) => {
          try {
            await syncSingleStation(env, station.station_id);
            successCount++;
          } catch (error) {
            console.error(`Failed to sync ${station.station_name}:`, error);
            failCount++;
          }
        })
      );

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const duration = Date.now() - startTime;
    const result = {
      success: true,
      synced: successCount,
      failed: failCount,
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

async function syncSingleStation(env, stationId) {
  const syncStart = Date.now();

  try {
    // Fetch current conditions from WeatherLink
    const data = await fetchWeatherLinkData(env, stationId);
    
    // Extract sensor data
    const sensors = data.sensors || [];
    
    let temperature = null;
    let humidity = null;
    let pressure = null;
    let windSpeed = null;
    let hasOutdoorData = false;

    // Parse sensor data - focus on OUTDOOR sensors
    sensors.forEach(sensor => {
      if (sensor.data && sensor.data.length > 0) {
        const sensorData = sensor.data[0];
        
        // Check if this is outdoor sensor
        const isOutdoor = sensorData.temp !== undefined || 
                         sensorData.wind_speed_last !== undefined;
        
        if (isOutdoor) {
          hasOutdoorData = true;
          if (sensorData.temp !== undefined) temperature = sensorData.temp;
          if (sensorData.hum !== undefined) humidity = sensorData.hum;
          if (sensorData.bar !== undefined) pressure = sensorData.bar;
          if (sensorData.wind_speed_last !== undefined) windSpeed = sensorData.wind_speed_last;
        }
      }
    });

    // Get last 2 recorded values to check if ALL readings are stuck
    const recentLogs = await env.DB.prepare(`
      SELECT temperature, humidity, wind_speed, pressure, timestamp
      FROM status_logs
      WHERE station_id = ?
      ORDER BY timestamp DESC
      LIMIT 2
    `).bind(stationId).all();

    let isOnline = false;

    if (!hasOutdoorData) {
      // No outdoor sensor data at all
      isOnline = false;
    } else if (!recentLogs.results || recentLogs.results.length === 0) {
      // First time seeing this station with data
      isOnline = true;
    } else if (recentLogs.results.length < 2) {
      // Only 1 reading - assume online for now
      isOnline = true;
    } else {
      // Compare current values with last 2 readings
      // If ALL values are identical = station is offline (stuck readings)
      const allIdentical = recentLogs.results.every(log => 
        log.temperature === temperature &&
        log.humidity === humidity &&
        log.wind_speed === windSpeed &&
        log.pressure === pressure
      );
      
      if (allIdentical) {
        // ALL values (temp, humidity, wind, pressure) are identical for 2+ consecutive checks
        // This means 60+ minutes of stuck data (checks are 30 min apart)
        isOnline = false;
      } else {
        // At least one value changed - station is online
        isOnline = true;
      }
    }

    const responseTime = Date.now() - syncStart;

    // Insert status log
    await env.DB.prepare(`
      INSERT INTO status_logs 
      (station_id, timestamp, is_online, temperature, humidity, pressure, wind_speed, response_time_ms)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)
    `).bind(
      stationId,
      isOnline ? 1 : 0,
      temperature,
      humidity,
      pressure,
      windSpeed,
      responseTime
    ).run();

    // Check for downtime events
    if (!isOnline) {
      await handleStationOffline(env, stationId);
    } else {
      await handleStationOnline(env, stationId);
    }

    return { success: true, station_id: stationId };
  } catch (error) {
    // Log as offline with error
    await env.DB.prepare(`
      INSERT INTO status_logs 
      (station_id, timestamp, is_online, error_message, response_time_ms)
      VALUES (?, datetime('now'), 0, ?, ?)
    `).bind(stationId, error.message, Date.now() - syncStart).run();

    await handleStationOffline(env, stationId);
    throw error;
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
  // Recent offline (last went offline)
  const recent = await env.DB.prepare(`
    SELECT 
      s.station_name as name,
      s.location,
      CASE 
        WHEN (julianday('now') - julianday(d.start_time)) * 24 * 60 < 60 
        THEN ROUND((julianday('now') - julianday(d.start_time)) * 24 * 60) || 'min'
        ELSE ROUND((julianday('now') - julianday(d.start_time)) * 24) || 'h ' || 
             ROUND(((julianday('now') - julianday(d.start_time)) * 24 * 60) % 60) || 'min'
      END as downtime
    FROM downtime_records d
    JOIN stations s ON d.station_id = s.station_id
    WHERE d.status = 'active'
    ORDER BY d.start_time DESC
    LIMIT 10
  `).all();

  // Longest downtime (currently offline)
  const longest = await env.DB.prepare(`
    SELECT 
      s.station_name as name,
      s.location,
      CASE 
        WHEN (julianday('now') - julianday(d.start_time)) * 24 * 60 < 60 
        THEN ROUND((julianday('now') - julianday(d.start_time)) * 24 * 60) || 'min'
        ELSE ROUND((julianday('now') - julianday(d.start_time)) * 24) || 'h ' || 
             ROUND(((julianday('now') - julianday(d.start_time)) * 24 * 60) % 60) || 'min'
      END as downtime,
      (julianday('now') - julianday(d.start_time)) * 24 * 60 as minutes
    FROM downtime_records d
    JOIN stations s ON d.station_id = s.station_id
    WHERE d.status = 'active'
    ORDER BY minutes DESC
    LIMIT 10
  `).all();

  return {
    recent: recent.results,
    longest: longest.results,
  };
}