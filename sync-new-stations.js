// sync-new-stations.js
// Fetches stations from WeatherLink and adds only NEW ones to database

const crypto = require('crypto');
const https = require('https');

const API_KEY = 'r5uz0hq98idblimlewrtotem9vzj7t1x';
const API_SECRET = 'ks36wqgk3vt9njmuqxbnfikwncgveb7q';
const WORKER_URL = 'https://weatherlink-monitor.mashhood2717.workers.dev';

function generateSignature(apiSecret, params) {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}${params[key]}`)
    .join('');
  
  return crypto
    .createHmac('sha256', apiSecret)
    .update(sortedParams)
    .digest('hex');
}

function fetchStations() {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    
    const params = {
      'api-key': API_KEY,
      't': timestamp
    };
    
    const signature = generateSignature(API_SECRET, params);
    params['api-signature'] = signature;
    
    const queryString = new URLSearchParams(params).toString();
    const url = `https://api.weatherlink.com/v2/stations?${queryString}`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API Error: ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

function getCurrentStations() {
  return new Promise((resolve, reject) => {
    https.get(`${WORKER_URL}/api/stations`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.stations || []);
        } else {
          reject(new Error(`Worker Error: ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    console.log('🔍 Checking for new stations...\n');
    
    // Fetch from WeatherLink
    const weatherlinkData = await fetchStations();
    const weatherlinkStations = weatherlinkData.stations || [];
    console.log(`Found ${weatherlinkStations.length} stations in WeatherLink API`);
    
    // Fetch from database
    const dbStations = await getCurrentStations();
    console.log(`Found ${dbStations.length} stations in database\n`);
    
    // Find NEW stations (in WeatherLink but not in DB)
    const dbStationIds = new Set(dbStations.map(s => s.station_id.toString()));
    const newStations = weatherlinkStations.filter(s => 
      !dbStationIds.has(s.station_id.toString())
    );
    
    if (newStations.length === 0) {
      console.log('✅ No new stations to add. Database is up to date!');
      return;
    }
    
    console.log(`🆕 Found ${newStations.length} NEW station(s):\n`);
    
    newStations.forEach((station, index) => {
      console.log(`${index + 1}. Station ID: ${station.station_id}`);
      console.log(`   Name: ${station.station_name}`);
      console.log(`   Location: ${station.city || 'N/A'}, ${station.country || ''}`);
      console.log('');
    });
    
    // Generate SQL for new stations only
    let sql = 'INSERT INTO stations (station_id, station_name, location, latitude, longitude, install_date) VALUES\n';
    
    const values = newStations.map((station) => {
      const stationId = station.station_id || '';
      const stationName = (station.station_name || 'Unknown Station').replace(/'/g, "''");
      const city = station.city || '';
      const state = station.state || '';
      const country = station.country || '';
      const location = `${city}, ${state} ${country}`.trim().replace(/'/g, "''");
      const latitude = station.latitude || 0;
      const longitude = station.longitude || 0;
      const installDate = station.recording_start || '2024-01-01';
      
      return `('${stationId}', '${stationName}', '${location}', ${latitude}, ${longitude}, '${installDate}')`;
    });
    
    sql += values.join(',\n');
    sql += ';';
    
    // Save to file
    require('fs').writeFileSync('add-new-stations.sql', sql);
    
    console.log('✅ Created add-new-stations.sql file!\n');
    console.log('📋 Next step: Run this command to add new stations:');
    console.log('wrangler d1 execute weatherlink-monitor --remote --file=add-new-stations.sql\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();