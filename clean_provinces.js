const fs = require('fs');
const content = fs.readFileSync('d:\\weather-monitor\\src\\index.js', 'utf8');
const lines = content.split('\n');
let inProvinceMapping = false;
const uniqueStations = new Map();

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.includes('// Province mapping based on station locations')) {
    inProvinceMapping = true;
    continue;
  }
  if (inProvinceMapping && line.includes('};')) {
    break;
  }
  if (inProvinceMapping && line.includes(':')) {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const stations = parts[0].replace(/'/g, '').split(',');
      const province = parts[1].replace(/'/g, '').replace(',', '').trim();
      stations.forEach(station => {
        const cleanStation = station.trim().replace(/'/g, '');
        if (cleanStation && !uniqueStations.has(cleanStation)) {
          uniqueStations.set(cleanStation, province);
        }
      });
    }
  }
}

console.log('const PROVINCE_MAPPING = {');
// Group by province
const provinces = {};
for (const [station, province] of uniqueStations) {
  if (!provinces[province]) provinces[province] = [];
  provinces[province].push(station);
}

for (const province of ['punjab', 'sindh', 'kpk', 'balochistan', 'islamabad', 'ajk', 'gb']) {
  if (provinces[province]) {
    console.log('  // ' + province.charAt(0).toUpperCase() + province.slice(1) + ' stations');
    const stations = provinces[province];
    for (let i = 0; i < stations.length; i += 10) {
      const chunk = stations.slice(i, i + 10);
      const line = '  ' + chunk.map(s => "'" + s + "'").join(', ') + ',';
      console.log(line);
    }
    console.log('');
  }
}
console.log('};');