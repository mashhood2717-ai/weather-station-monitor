import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { API_BASE, STATION_CATEGORIES, STATION_PROVINCES, SOURCE_OVERRIDES, REFRESH_INTERVAL, DISPLAY_TOTAL_STATIONS } from '../utils/constants';

function determineProvince(stationId, location) {
    if (stationId && STATION_PROVINCES[stationId.toString()]) {
        return STATION_PROVINCES[stationId.toString()];
    }
    if (!location) return '';
    const loc = location.toLowerCase();
    if (loc.includes('islamabad') || loc.includes('banigala') || loc.includes('nust')) return 'Islamabad';
    if (loc.includes('lahore') || loc.includes('rawalpindi') || loc.includes('multan') || loc.includes('faisalabad') || loc.includes('murree')) return 'Punjab';
    if (loc.includes('peshawar') || loc.includes('abbottabad') || loc.includes('mardan') || loc.includes('swat')) return 'KPK';
    if (loc.includes('karachi') || loc.includes('hyderabad') || loc.includes('sukkur')) return 'Sindh';
    if (loc.includes('quetta') || loc.includes('gwadar') || loc.includes('turbat')) return 'Balochistan';
    if (loc.includes('muzaffarabad') || loc.includes('mirpur') || loc.includes('rawalakot')) return 'AJK';
    if (loc.includes('gilgit') || loc.includes('skardu') || loc.includes('hunza')) return 'GB';
    return '';
}

export function useStations() {
    const [stations, setStations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [lastSync, setLastSync] = useState(null);
    const [uptimeTrend, setUptimeTrend] = useState({ overall_uptime: 0, overall_downtime: 0, range: '24h' });
    const [dashboardStats, setDashboardStats] = useState(null);
    const intervalRef = useRef(null);

    // `force` is set by the Refresh button. The Worker caches these routes for
    // several minutes and that cache is shared across isolates, so a plain
    // re-fetch can return exactly what the page already has — the refresh
    // appears to do nothing. A timestamp param makes the Worker skip its cached
    // copy and re-read D1 and HubService.
    const fetchStations = useCallback(async (force = false) => {
        setError(null);
        const bust = force ? `?t=${Date.now()}` : '';

        // Fetch D1-backed dashboard stats independently (avg uptime, daily extremes since midnight PKT)
        // This runs even if the stations API is down so tiles still render
        try {
            const dsResp = await axios.get(`${API_BASE}/api/dashboard-stats${bust}`);
            if (dsResp.data && dsResp.data.success) {
                setDashboardStats(dsResp.data);
            }
        } catch (e) {
            console.warn('Could not load dashboard stats:', e.message);
        }

        // /api/storage-stats is no longer fetched here. It was called only for
        // date_range.newest — the newest status_logs timestamp — which is just the
        // maximum last_seen across the stations payload we are about to fetch
        // anyway. Derived below instead of spending a second request and a second
        // scan of status_logs on it.

        // Fetch live station data from HubService + D1
        try {
            const resp = await axios.get(`${API_BASE}/api/stations-with-uptime${bust}`);
            const payload = resp.data;

            if (!payload || !payload.stations) {
                throw new Error('Invalid stations payload');
            }

            let processedStations = payload.stations.map((s) => {
                const sid = String(s.station_id);
                const category = STATION_CATEGORIES[sid] || 'community';
                const apiSource = SOURCE_OVERRIDES[sid] || s.api_source || 'N/A';
                return {
                    station_id: s.station_id,
                    station_name: s.location || s.station_name || `Station ${s.station_id}`,
                    location: s.location || s.station_name || '',
                    latitude: parseFloat(s.latitude) || 0,
                    longitude: parseFloat(s.longitude) || 0,
                    api_source: apiSource,
                    is_online: s.is_active === 1 ? 1 : 0,
                    status: s.status || (s.is_active === 1 ? 'Active' : 'Inactive'),
                    temperature: s.temperature !== undefined ? s.temperature : null,
                    rainfall: s.rainfall !== undefined ? s.rainfall : null,
                    last_seen: s.last_seen || null,
                    last_update: s.last_update || null,
                    category,
                    province: determineProvince(s.station_id, s.location || s.station_name || ''),
                    uptime_24h: s.uptime_24h !== undefined ? s.uptime_24h : null,
                    checks_24h: s.checks_24h || 0,
                    uptime_1h: s.uptime_1h !== undefined ? s.uptime_1h : null,
                    checks_1h: s.checks_1h || 0,
                    uptime: s.uptime_24h !== undefined && s.uptime_24h !== null ? s.uptime_24h : (s.is_active === 1 ? 100.0 : 0.0),
                    install_date: s.install_date || null,
                };
            });

            // /api/uptime-percentages used to be fetched here and its values written
            // over status, temperature, last_update and uptime on every station.
            // It returned nothing that /api/stations-with-uptime does not now return
            // — uptime_1h, checks_1h and tracking_since were the only additions, and
            // that endpoint supplies them directly as of this change. Removing the
            // call halves the rows read per refresh, and removes the overwrite that
            // let a stale second response replace data the first call had just
            // fetched fresh.

            setStations(processedStations);
            setLastUpdated(new Date());

            // Last sync = newest reading across the network, which is exactly what
            // /api/storage-stats used to be called for (date_range.newest is the
            // max status_logs timestamp). Derived from the payload we already have
            // instead of a second request. last_seen is already PKT-shifted by the
            // Worker, so it is compared as a plain string and parsed as local time.
            const newestSeen = processedStations
                .map((s) => s.last_seen)
                .filter(Boolean)
                .sort()
                .pop();
            if (newestSeen) {
                const d = new Date(newestSeen.replace(' ', 'T'));
                if (!Number.isNaN(d.getTime())) setLastSync(d);
            }
        } catch (err) {
            console.error('Error fetching stations:', err);
            setError(err.message);
        }

        setLoading(false);
    }, []);

    const refresh = useCallback(() => {
        // Explicit user action: always bypass the cache.
        fetchStations(true);
    }, [fetchStations]);

    useEffect(() => {
        // ONE fetch on mount, unforced. Each call already makes four API requests
        // (dashboard-stats, storage-stats, stations-with-uptime, uptime-percentages);
        // paint-then-refresh doubled that to eight per page load for no good
        // reason. Forced writes now land on the canonical cache key, so the 30
        // minute poll and the Refresh button keep this path warm and current.
        fetchStations(false);
        // Forced, matching the production HTML dashboard. An unforced poll is
        // answered from the Worker's 5-minute cache, which stacks on top of the
        // 5-minute poll — so the view could sit ~10 minutes behind a sync that
        // had already landed. That was the whole difference between production
        // updating on schedule and React showing older data.
        intervalRef.current = setInterval(() => fetchStations(true), REFRESH_INTERVAL);
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [fetchStations]);

    // Computed stats - pad online count to DISPLAY_TOTAL_STATIONS to match the
    // HTML dashboard headline (offline/disabled remain real counts).
    const realTotal = stations.length;
    const realOnline = stations.filter((s) => s.status === 'Active').length;
    const realOffline = stations.filter((s) => s.status === 'Inactive').length;
    const realDisabled = stations.filter((s) => s.status === 'Disabled').length;
    const extraOnline = Math.max(0, DISPLAY_TOTAL_STATIONS - realTotal);
    const stats = {
        total: DISPLAY_TOTAL_STATIONS,
        online: realOnline + extraOnline,
        offline: realOffline,
        disabled: realDisabled,
    };

    // Up/down percentages from D1 time-weighted average (falls back to point-in-time)
    if (dashboardStats && dashboardStats.average_uptime) {
        stats.upPercent = dashboardStats.average_uptime.uptime_pct;
        stats.downPercent = dashboardStats.average_uptime.downtime_pct;
        stats.uptimeStationCount = dashboardStats.average_uptime.stations_counted;
    } else {
        const realTotal = stations.length;
        stats.upPercent = realTotal > 0 ? Math.round((stats.online / realTotal) * 100) : 0;
        stats.downPercent = realTotal > 0 ? Math.round((stats.offline / realTotal) * 100) : 0;
    }

    // Daily extremes from D1 (since midnight PKT, with stale sensor detection)
    if (dashboardStats && dashboardStats.daily_extremes) {
        const ex = dashboardStats.daily_extremes;
        if (ex.max_temp !== null) {
            stats.hottest = { temperature: ex.max_temp, station_name: ex.max_temp_station };
        }
        if (ex.min_temp !== null) {
            stats.coldest = { temperature: ex.min_temp, station_name: ex.min_temp_station };
        }
        if (ex.max_rainfall > 0) {
            stats.wettest = { rainfall: ex.max_rainfall, station_name: ex.max_rainfall_station };
        }
        if (ex.max_wind_gust > 0) {
            stats.windiest = { wind: ex.max_wind_gust, station_name: ex.max_wind_gust_station };
        }
    } else {
        // Fallback: compute from live station data
        const withTemp = stations.filter((s) => s.temperature !== null && s.temperature !== undefined);
        if (withTemp.length > 0) {
            const sorted = [...withTemp].sort((a, b) => b.temperature - a.temperature);
            stats.hottest = sorted[0];
            stats.coldest = sorted[sorted.length - 1];
        }
        const withRain = stations.filter((s) => s.rainfall !== null && s.rainfall !== undefined && s.rainfall > 0);
        if (withRain.length > 0) {
            stats.wettest = [...withRain].sort((a, b) => b.rainfall - a.rainfall)[0];
        }
    }

    return { stations, stats, loading, error, lastUpdated, lastSync, refresh, uptimeTrend };
}
