// sync-new-stations.js
// Fetches stations from WeatherLink and adds only NEW ones to database

// Safety guard: set DISABLE_WEATHERLINK_SCRIPTS=1 to prevent this script
// from making any external WeatherLink API requests.
if (process.env.DISABLE_WEATHERLINK_SCRIPTS === '1') {
  console.log('DISABLED: WeatherLink scripts are disabled via DISABLE_WEATHERLINK_SCRIPTS=1');
  process.exit(0);
}

const https = require('https');

const WORKER_URL = 'https://weatherlink-monitor.mashhood2717.workers.dev';

function fetchStationsFromWorker() {
  return new Promise((resolve, reject) => {
    https.get(`${WORKER_URL}/api/stations`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.stations || []);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Worker Error: ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    console.log('🔍 Fetching stations from Worker...\n');
    
    const stations = await fetchStationsFromWorker();
    console.log(`✅ Found ${stations.length} stations in database\n`);
    
    // List first 10 stations as a preview
    const preview = stations.slice(0, 10);
    preview.forEach((station, index) => {
      const status = station.status || 'unknown';
      console.log(`${index + 1}. [${status.toUpperCase()}] ${station.name || station.station_name} (ID: ${station.station_id})`);
    });
    
    if (stations.length > 10) {
      console.log(`   ... and ${stations.length - 10} more stations`);
    }
    
    console.log('\n✅ All stations are managed via the Worker. No direct WeatherLink API calls.');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();