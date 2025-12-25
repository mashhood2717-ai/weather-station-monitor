// Test fetching data from the 3 stations that show 404 errors

// Safety guard: don't hit WeatherLink when disabled
if (process.env.DISABLE_WEATHERLINK_SCRIPTS === '1') {
  console.log('DISABLED: test scripts disabled via DISABLE_WEATHERLINK_SCRIPTS=1');
  process.exit(0);
}
const crypto = require('crypto');

// Dynamic import for node-fetch (ESM module)
async function fetchData(url) {
  const fetch = (await import('node-fetch')).default;
  return fetch(url);
}

const API_KEY = 'r5uz0hq98idblimlewrtotem9vzj7t1x';
const API_SECRET = 'ks36wqgk3vt9njmuqxbnfikwncgveb7q';

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

async function fetchStationData(stationId, stationName) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    'api-key': API_KEY,
    't': timestamp,
  };

  const signature = generateSignature(API_SECRET, params);
  const url = `https://api.weatherlink.com/v2/current/${stationId}?api-key=${API_KEY}&api-signature=${signature}&t=${timestamp}`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${stationName} (ID: ${stationId})`);
  console.log(`URL: ${url}`);
  console.log(`${'='.repeat(60)}`);

  try {
    const response = await fetchData(url);
    console.log(`Status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error Response: ${errorText}`);
      return null;
    }

    const data = await response.json();
    console.log(`✅ SUCCESS! Data retrieved:`);
    console.log(JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.log(`❌ ERROR: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('Testing the 3 stations that show 404 errors...\n');
  
  // First test a WORKING station to verify signature is correct
  console.log('First, testing a KNOWN WORKING station for comparison...');
  await fetchStationData(221695, 'Kallar Kahar Toll Plaza (WORKING)');
  
  console.log('\n\nNow testing the 3 "problem" stations...\n');
  
  const stations = [
    { id: 130584, name: 'Chakwal City WW' },
    { id: 160726, name: 'Chichawatni' },
    { id: 162130, name: 'Comsats University Vehari' }
  ];

  for (const station of stations) {
    await fetchStationData(station.id, station.name);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('Test complete!');
  console.log(`${'='.repeat(60)}`);
}

main().catch(console.error);