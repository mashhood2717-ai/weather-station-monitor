// Safety guard: don't hit WeatherLink when disabled
if (process.env.DISABLE_WEATHERLINK_SCRIPTS === '1') {
  console.log('DISABLED: test scripts disabled via DISABLE_WEATHERLINK_SCRIPTS=1');
  process.exit(0);
}

const crypto = require('crypto');
const https = require('https');

const API_KEY = 'r5uz0hq98idblimlewrtotem9vzj7t1x';
const API_SECRET = 'ks36wqgk3vt9njmuqxbnfikwncgveb7q';
const STATION_ID = 127500; // First station

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

async function testEndpoint(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    
    const allParams = {
      'api-key': API_KEY,
      't': timestamp,
      ...params
    };
    
    const signature = generateSignature(API_SECRET, allParams);
    allParams['api-signature'] = signature;
    
    const queryString = new URLSearchParams(allParams).toString();
    const url = `https://api.weatherlink.com/v2/${endpoint}?${queryString}`;
    
    console.log(`\nTesting: ${endpoint}`);
    console.log(`URL: ${url.substring(0, 80)}...`);
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          console.log('Success! Data:', JSON.stringify(json, null, 2).substring(0, 500));
          resolve(json);
        } else {
          console.log('Failed:', data);
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Testing different WeatherLink API endpoints...\n');
  
  // Test 1: Current with station-id
  await testEndpoint('current', { 'station-id': STATION_ID });
  
  // Test 2: Current with station-id-uuid
  await testEndpoint('current', { 'station-id': '307a8ea4-3bef-4864-8ce8-9a3096321986' });
  
  // Test 3: Historic (should work even for shared)
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - 3600; // Last hour
  await testEndpoint('historic', { 
    'station-id': STATION_ID,
    'start-timestamp': startTime,
    'end-timestamp': endTime
  });
}

main();