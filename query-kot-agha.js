const https = require('https');

// Direct query to get last 10 temperature readings from status_logs
const query = 'SELECT timestamp, temperature, is_online FROM status_logs WHERE station_id = "133500" ORDER BY timestamp DESC LIMIT 10';
const encodedQuery = encodeURIComponent(query);
const url = 'https://weatherlink-monitor.mashhood2717.workers.dev/api/query?sql=' + encodedQuery;

console.log('Query URL:', url);
https.get(url, (res) => {
    console.log('Response status:', res.statusCode);
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('Query success:', json.success);
            if (json.success && json.results) {
                console.log('Results count:', json.results.length);
                json.results.forEach((row, index) => {
                    const timestamp = new Date(row.timestamp + 'Z').toLocaleString('en-US', {
                        timeZone: 'Asia/Karachi',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    console.log(`${index + 1}. ${timestamp} - ${row.temperature}°C (Online: ${row.is_online})`);
                });
            } else {
                console.log('No results');
            }
        } catch (e) {
            console.error('Parse error:', e.message);
            console.log('Raw data:', data.substring(0, 200));
        }
    });
}).on('error', (err) => console.error('Request error:', err));