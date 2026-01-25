// backfill-downtime.js - Populate historical downtime records
// Run with: node backfill-downtime.js

async function backfillDowntime() {
  console.log('Starting historical downtime backfill...');

  try {
    // Get all stations
    const stationsResponse = await fetch('https://weatherlink-monitor.mashhood2717.workers.dev/api/stations');
    const stationsData = await stationsResponse.json();
    const stations = stationsData.stations || [];

    console.log(`Processing ${stations.length} stations...`);

    let totalRecords = 0;

    for (const station of stations.slice(0, 10)) { // Test with first 10 stations
      const stationId = station.station_id;
      console.log(`Processing station: ${stationId}`);

      try {
        // Get station history for last 50 days
        const historyResponse = await fetch(`https://weatherlink-monitor.mashhood2717.workers.dev/api/station-history/${stationId}?days=50`);
        const historyData = await historyResponse.json();

        if (historyData.hourly_data) {
          const data = historyData.hourly_data;
          let currentOfflineStart = null;

          for (let i = 0; i < data.length; i++) {
            const point = data[i];
            const uptime = point.uptime || 0;
            const isOnline = uptime > 0;

            if (!isOnline && currentOfflineStart === null) {
              currentOfflineStart = point.period;
            } else if (isOnline && currentOfflineStart !== null) {
              // Would create downtime record here
              console.log(`  ${stationId}: Offline from ${currentOfflineStart} to ${point.period}`);
              totalRecords++;
              currentOfflineStart = null;
            }
          }
        }
      } catch (e) {
        console.log(`Error processing ${stationId}: ${e.message}`);
      }
    }

    console.log(`Backfill analysis complete. Would create ${totalRecords} historical downtime records.`);

  } catch (error) {
    console.error('Backfill error:', error);
  }
}

backfillDowntime();