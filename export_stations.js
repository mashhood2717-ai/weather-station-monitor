const fs = require('fs');

async function exportStations() {
  try {
    const response = await fetch('https://weatherlink-monitor.mashhood2717.workers.dev/api/stations-with-uptime');
    const data = await response.json();
    const stations = data.stations;

    // CSV header
    let csv = 'Station ID,Station POI,Source,Latitude,Longitude,Status\n';

    stations.forEach(s => {
      // Clean up commas to prevent CSV breakage
      const id = `"${(s.station_id || '').toString().replace(/"/g, '""')}"`;
      const poi = `"${(s.location || s.station_name || `Station ${s.station_id}`).replace(/"/g, '""')}"`;
      const source = `"${(s.api_source || 'N/A').replace(/"/g, '""')}"`;
      const lat = s.latitude || 0;
      const lon = s.longitude || 0;
      const status = `"${(s.status || 'N/A').replace(/"/g, '""')}"`;

      csv += `${id},${poi},${source},${lat},${lon},${status}\n`;
    });

    fs.writeFileSync('weather_stations.csv', csv);
    console.log('Successfully exported ' + stations.length + ' stations to weather_stations.csv');
  } catch (error) {
    console.error('Error fetching or saving data:', error);
  }
}

exportStations();
