const data = {
  'hourly_data': [
    {'period': '2026-01-22T05:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T06:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T07:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T08:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T09:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T10:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T11:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T12:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T13:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T14:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T15:00:00', 'avg_temperature': null},
    {'period': '2026-01-22T16:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T17:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T18:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T19:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T20:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T21:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T22:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-22T23:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-23T00:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-23T01:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-23T02:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-23T03:00:00', 'avg_temperature': 18.6},
    {'period': '2026-01-23T04:00:00', 'avg_temperature': 18.6}
  ]
};

console.log('Last 10 hourly temperature readings for Kot Agha Jajjah (Station ID: 133500):');
console.log('============================================================');
data.hourly_data.slice(-10).forEach((row, index) => {
    const timestamp = new Date(row.period + 'Z').toLocaleString('en-US', {
        timeZone: 'Asia/Karachi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
    console.log(`${index + 1}. ${timestamp} - ${row.avg_temperature !== null ? row.avg_temperature + '°C' : 'N/A'}`);
});