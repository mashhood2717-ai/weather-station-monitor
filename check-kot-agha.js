const https = require('https');

// First check if station 133500 exists in our database
const stationsUrl = 'https://weatherlink-monitor.mashhood2717.workers.dev/api/stations-with-uptime';

https.get(stationsUrl, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.success && json.stations) {
                const station = json.stations.find(s => s.station_id === '133500');
                if (station) {
                    console.log('Station found in database:');
                    console.log('ID:', station.station_id);
                    console.log('Name:', station.station_name);
                    console.log('Location:', station.location);
                    console.log('Temperature:', station.temperature);
                    console.log('Status:', station.status);
                    console.log('Last seen:', station.last_seen);
                    console.log('---');

                    // Now get the last 10 readings from status_logs
                    const historyUrl = 'https://weatherlink-monitor.mashhood2717.workers.dev/api/station-history/133500?limit=10';
                    console.log('Fetching history from:', historyUrl);

                    https.get(historyUrl, (res2) => {
                        let data2 = '';
                        res2.on('data', chunk => data2 += chunk);
                        res2.on('end', () => {
                            try {
                                const json2 = JSON.parse(data2);
                                if (json2.success && json2.history) {
                                    console.log('\nLast 10 temperature readings for Kot Agha Jajjah:');
                                    console.log('============================================================');
                                    json2.history.forEach((row, index) => {
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
                                    console.log('No history data found');
                                    console.log('Response:', JSON.stringify(json2, null, 2));
                                }
                            } catch (e) {
                                console.error('Error parsing history response:', e);
                                console.log('Raw response:', data2);
                            }
                        });
                    }).on('error', (err) => console.error('History request error:', err));
                } else {
                    console.log('Station 133500 not found in database');
                    console.log('Available stations with "Kot Agha" in name:');
                    json.stations.filter(s =>
                        s.station_name?.toLowerCase().includes('kot agha') ||
                        s.location?.toLowerCase().includes('kot agha')
                    ).forEach(s => {
                        console.log(`  ${s.station_id}: ${s.station_name || s.location}`);
                    });
                }
            } else {
                console.log('Failed to fetch stations');
            }
        } catch (e) {
            console.error('Error parsing stations response:', e);
            console.log('Raw response:', data);
        }
    });
}).on('error', (err) => console.error('Stations request error:', err));