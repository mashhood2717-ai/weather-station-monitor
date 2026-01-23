const fs = require('fs');

// Read the CSV file
const csv = fs.readFileSync('weather_stations_provinces (1).csv', 'utf-8');
const lines = csv.trim().split('\n').slice(1);

// Parse CSV - handle quoted values
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let char of line) {
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

const csvStations = lines.map(line => {
    const parts = parseCSVLine(line);
    return {
        station_id: parts[0],
        location: parts[1],
        province: parts[2]
    };
});

const wuStations = csvStations.filter(s => s.station_id.startsWith('I'));
const numericStations = csvStations.filter(s => /^\d+$/.test(s.station_id));
const cStations = csvStations.filter(s => s.station_id.startsWith('C'));

console.log('=== CSV File Summary ===');
console.log('Total stations:', csvStations.length);
console.log('WU stations (I prefix):', wuStations.length);
console.log('Numeric stations:', numericStations.length);
console.log('C stations:', cStations.length);

console.log('\n=== WU Stations in CSV ===');
wuStations.forEach(s => console.log(`  ${s.station_id}: ${s.location} -> ${s.province}`));

// Now fetch from API and compare
async function compareWithAPI() {
    try {
        const response = await fetch('https://weatherlink-monitor.mashhood2717.workers.dev/api/stations');
        const apiStations = await response.json();
        
        console.log('\n=== API Stations Summary ===');
        console.log('Total API stations:', apiStations.length);
        
        const apiWU = apiStations.filter(s => s.station_id && s.station_id.toString().startsWith('I'));
        console.log('WU stations in API:', apiWU.length);
        
        // Find WU stations in API but not in CSV
        const csvIds = new Set(csvStations.map(s => s.station_id));
        const apiIds = new Set(apiStations.map(s => s.station_id.toString()));
        
        const missingInCSV = apiStations.filter(s => !csvIds.has(s.station_id.toString()));
        const missingWU = missingInCSV.filter(s => s.station_id.toString().startsWith('I'));
        
        console.log('\n=== Stations in API but NOT in CSV ===');
        console.log('Total missing:', missingInCSV.length);
        console.log('Missing WU stations:', missingWU.length);
        
        if (missingWU.length > 0) {
            console.log('\nMissing WU Stations:');
            missingWU.forEach(s => console.log(`  ${s.station_id}: ${s.station_name || 'N/A'}`));
        }
        
        // Extra in CSV but not in API
        const extraInCSV = csvStations.filter(s => !apiIds.has(s.station_id));
        if (extraInCSV.length > 0) {
            console.log('\n=== Stations in CSV but NOT in API ===');
            extraInCSV.forEach(s => console.log(`  ${s.station_id}: ${s.location}`));
        }
        
    } catch (err) {
        console.error('Error fetching API:', err.message);
    }
}

compareWithAPI();
