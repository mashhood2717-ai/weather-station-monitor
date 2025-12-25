# 🚀 Getting Started - 5 Minute Setup

## Before You Start
- ✅ You have your API keys configured in the Worker
- ✅ Worker is syncing station data (every 30 mins)
- ✅ Database has `status_logs` table with readings

## Step 1: Update Worker URL (2 minutes)

Open `dashboard/index.html` in your editor.

Find line ~1480 with:
```javascript
const WORKER_API = 'https://weatherlink-monitor.workers.dev';
```

Replace with your **actual Cloudflare Worker URL**:
```javascript
const WORKER_API = 'https://your-custom-name.workers.dev';
```

Get your URL from Cloudflare Dashboard:
- Go to Workers → Your Project → Copy the URL from top bar

## Step 2: Deploy Worker (1 minute)

```bash
cd d:\weather-monitor
wrangler publish
```

Wait for deployment to complete.

## Step 3: Test the Endpoint (1 minute)

In your browser console, run:
```javascript
fetch('https://your-custom-name.workers.dev/api/uptime-percentages')
  .then(r => r.json())
  .then(d => console.log(d))
```

You should see:
```json
{
  "uptime_data": [
    {"station_id": "123", "station_name": "...", "uptime_percent": 95.5},
    ...
  ]
}
```

## Step 4: Access Dashboard (1 minute)

Open in browser:
```
https://yourdomain.com/dashboard/index.html
```

You should see:
- ✅ Map with station markers (green/red)
- ✅ Statistics cards at top
- ✅ Station list table
- ✅ Uptime % column in table
- ✅ Map popups showing uptime %

## Done! 🎉

Your dashboard is now live with:
- 🗺️ Interactive Leaflet map
- 📊 Uptime/downtime percentages
- 🌡️ Real-time temperature
- 📈 24-hour trend charts
- 📋 Searchable station list

---

## What Each Feature Shows

### Map Markers 🗺️
- **Green dot:** Station is online
- **Red dot:** Station is offline
- Click any marker for popup with:
  - Station name
  - Location
  - Current temperature
  - **24-hour uptime %**
  - Status

### Statistics Cards 📊
- **Online:** How many stations online now
- **Offline:** How many stations offline now
- **Uptime %:** Average uptime percentage
- **Downtime %:** Average downtime percentage

### Station Table 📋
| Column | Shows |
|--------|-------|
| Station | Name of station |
| Location | City/Area |
| Status | Online 🟢 or Offline 🔴 |
| Temp | Latest temperature |
| Uptime | **24-hour uptime %** |
| Last Seen | When last active |

### Uptime Color Coding 🎨
- 🟢 **≥95%** = Green (Excellent)
- 🟡 **80-94%** = Yellow (Good)
- 🔴 **<80%** = Red (Needs attention)

---

## Common Questions

### Q: Why is uptime 0%?
**A:** The system needs at least 24 hours of data. If this is first time running, wait 24+ hours.

### Q: Why isn't the map showing?
**A:** Check that stations have latitude/longitude coordinates. Some may have (0,0).

### Q: Temperature shows N/A?
**A:** That station may not have temperature sensor data available.

### Q: How often does data update?
**A:** Dashboard refreshes every 30 minutes automatically. Worker syncs every 30 minutes.

### Q: Can I change the update frequency?
**A:** Yes! In `dashboard/index.html`, find:
```javascript
setInterval(loadData, 30 * 60 * 1000);
```
Change `30` to desired minutes.

### Q: Can I customize the uptime thresholds?
**A:** Yes! In `updateMapMarkers()`, change:
```javascript
if (uptime >= 95) uptimeClass = 'popup-uptime-good';      // Green threshold
else if (uptime >= 80) uptimeClass = 'popup-uptime-warning'; // Yellow threshold
```

---

## Quick Features Tour

### Search Stations
1. Type in search box at top of table
2. Results filter instantly by name/location

### Filter by Status
1. Click buttons: "All", "Online", "Offline"
2. Table shows only matching stations

### Sort Table
1. Click any column header (Station, Location, Temp, Uptime, etc)
2. Sorted ascending/descending

### Hide WU Stations
1. Check the checkbox next to filters
2. Removes all WU (Weather Underground) stations

### Dark/Light Theme
1. Click moon/sun icon in header
2. Preference saved automatically

### Focus on Map
1. Click any station row in table
2. Map zooms to that station
3. Popup opens automatically

### View Station Details
1. Click a map marker
2. Popup shows all info including uptime %

---

## Keyboard Shortcuts

```
F12              Open Developer Console
Ctrl/Cmd + F     Search in page
Escape           Close popups
```

---

## Performance Tips

### For Many Stations (300+)
- Map clusters automatically
- Zoom out to see clusters
- Click cluster to expand
- Search to narrow down

### Reduce Load
- Clear browser cache if slow
- Close other tabs
- Disable browser extensions
- Use modern browser (Chrome/Firefox/Safari)

### Mobile View
- Pinch to zoom map
- Tap to close popups
- Rotate device for full view

---

## Troubleshooting Guide

### Dashboard Loads but Shows No Data
```javascript
// Check in console:
// 1. Is token valid?
localStorage.getItem('ww_token')

// 2. Are API calls working?
// Check Network tab (F12 → Network)
// Look for requests to your APIs
```

### Map Shows but No Markers
```javascript
// Check stations have coordinates:
// In console:
fetch('https://your-api.workers.dev/api/stations')
  .then(r => r.json())
  .then(d => console.log(d.stations.filter(s => s.lat && s.lng)))
```

### Uptime Percentages Not Showing
```javascript
// Test endpoint directly:
fetch('https://your-worker.workers.dev/api/uptime-percentages')
  .then(r => r.json())
  .then(d => console.log(d.uptime_data))

// Should return array with uptime_percent values
```

### Search Not Working
1. Check search box value: it should filter in real-time
2. Try searching for station ID number instead of name
3. Refresh page (Ctrl/Cmd + R)

### Maps Not Zooming Correctly
1. Use scroll wheel to zoom
2. Double-click marker to zoom to it
3. Use +/- buttons in map corner
4. Click on map then use arrow keys

---

## Browser Compatibility

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | Latest | ✅ Perfect |
| Firefox | Latest | ✅ Perfect |
| Safari | Latest | ✅ Perfect |
| Edge | Latest | ✅ Perfect |
| IE 11 | Any | ❌ Not supported |

---

## What's Next?

### Optional Enhancements
1. **Email Alerts** - Get notified when stations go offline
2. **Daily Reports** - Automated uptime summary emails
3. **Mobile App** - Convert to PWA (Progressive Web App)
4. **API Integration** - Connect to external monitoring systems
5. **Data Export** - Download as CSV/PDF reports

### Advanced Configuration
1. **Custom Map Tiles** - Use different map provider
2. **Advanced Analytics** - Add trend detection algorithms
3. **Webhooks** - Send alerts to Slack/Discord
4. **Custom Branding** - Add your logo and colors
5. **Multi-user Access** - Add role-based permissions

---

## Support Resources

📚 **Documentation**
- [DASHBOARD_SETUP.md](DASHBOARD_SETUP.md) - Complete guide
- [CODE_CHANGES.md](CODE_CHANGES.md) - What was changed
- [QUICK_START.md](QUICK_START.md) - Reference
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) - Full details

🔍 **Debugging**
1. Open Browser DevTools (F12)
2. Go to Console tab
3. Look for red errors
4. Check Network tab for failed API calls

📧 **Need Help?**
- Check console for error messages
- Verify Worker URL is correct
- Confirm database has data
- Check Cloudflare Worker logs

---

## Checklist Before Going Live

- [ ] Updated Worker URL in dashboard
- [ ] Deployed Worker with `wrangler publish`
- [ ] Tested `/api/uptime-percentages` endpoint
- [ ] Dashboard loads without errors
- [ ] Map shows stations
- [ ] Temperature displays
- [ ] Uptime percentages show
- [ ] Search/filter works
- [ ] Table is sortable
- [ ] Works on mobile
- [ ] Dark/light theme works
- [ ] Auto-refresh happening every 30 mins

---

## Summary

You now have a professional weather station monitoring dashboard with:

✅ Real-time station status on interactive map
✅ 24-hour uptime/downtime percentages
✅ Current temperature for each station
✅ Color-coded status (green/yellow/red)
✅ Searchable, sortable station list
✅ Historical trend charts
✅ Responsive design (desktop/tablet/mobile)
✅ Dark/light theme toggle
✅ Auto-updating every 30 minutes

**Your dashboard is production-ready!** 🎉

Just ensure:
1. ✅ Worker URL updated
2. ✅ Worker deployed
3. ✅ Database has status_logs data

Then access your dashboard and start monitoring! 📊
