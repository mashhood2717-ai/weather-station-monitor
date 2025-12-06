// fetch-stations.js
// This script fetches your stations from WeatherLink API

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// Your API credentials
const API_KEY = 'r5uz0hq98idblimlewrtotem9vzj7t1x';
const API_SECRET = 'ks36wqgk3vt9njmuqxbnfikwncgveb7q';

// Generate HMAC signature for WeatherLink API
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

// Fetch stations from WeatherLink
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
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API Error: ${res.statusCode} - ${data}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Main function
async function main() {
  try {
    console.log('Fetching stations from WeatherLink API...\n');
    
    const response = await fetchStations();
    const stations = response.stations || [];
    
    console.log(`Found ${stations.length} stations:\n`);
    
    if (stations.length === 0) {
      console.log('No stations found!');
      return;
    }
    
    // Display stations
    stations.forEach((station, index) => {
      console.log(`${index + 1}. Station ID: ${station.station_id}`);
      console.log(`   Name: ${station.station_name}`);
      console.log(`   Location: ${station.city || 'N/A'}, ${station.state || ''} ${station.country || ''}`);
      console.log('');
    });
    
    // Generate SQL import file
    let sql = 'INSERT INTO stations (station_id, station_name, location, latitude, longitude, install_date) VALUES\n';
    
    const values = stations.map((station) => {
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
    fs.writeFileSync('import-stations.sql', sql);
    
    console.log('\n✅ Created import-stations.sql file!');
    console.log('\nNext step: Run this command to import stations:');
    console.log('wrangler d1 execute weatherlink-monitor --remote --file=import-stations.sql');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();
