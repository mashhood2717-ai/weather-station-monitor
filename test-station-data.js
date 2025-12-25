const crypto = require('crypto');
const https = require('https');

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

async function main() {
  try {
    // Safety guard: don't hit WeatherLink when disabled
    if (process.env.DISABLE_WEATHERLINK_SCRIPTS === '1') {
      console.log('DISABLED: test scripts disabled via DISABLE_WEATHERLINK_SCRIPTS=1');
      process.exit(0);
    }
    const response = await fetchStations();
    
    // Save full response to file
    require('fs').writeFileSync('stations-full-data.json', JSON.stringify(response, null, 2));
    
    console.log('✅ Saved full station data to stations-full-data.json');
    console.log('\nFirst station preview:');
    console.log(JSON.stringify(response.stations[0], null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();