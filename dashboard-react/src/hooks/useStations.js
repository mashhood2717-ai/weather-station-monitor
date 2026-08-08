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

        // Fetch last API sync time from storage stats
        try {
            const syncResp = await axios.get(`${API_BASE}/api/storage-stats${bust}`);
            if (syncResp.data && syncResp.data.success && syncResp.data.date_range && syncResp.data.date_range.newest) {
                const syncDate = new Date(`${syncResp.data.date_range.newest}Z`);
                if (!Number.isNaN(syncDate.getTime())) {
                    setLastSync(syncDate);
                }
            }
        } catch (e) {
            console.warn('Could not load storage stats:', e.message);
        }

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

            // Load real-time uptime percentages
            try {
                // MUST carry the same cache-buster. This response overwrites status,
                // temperature, last_update and uptime on every station, so a cached
                // copy here silently replaces the fresh values fetched above — the
                // page then shows OLDER data after a refresh, not newer.
                const uptimeResp = await axios.post(`${API_BASE}/api/uptime-percentages${bust}`, {});
                if (uptimeResp.data && uptimeResp.data.uptime_data) {
                    const uptimeMap = {};
                    uptimeResp.data.uptime_data.forEach((item) => {
                        uptimeMap[String(item.station_id)] = item;
                    });
                    processedStations = processedStations.map((station) => {
                        const apiData = uptimeMap[String(station.station_id)];
                        if (apiData) {
                            // Mirror dashboard/index.html line 5340-5350: unconditionally accept
                            // /api/uptime-percentages values. Using `||` for checks_24h treats 0
                            // as falsy and keeps stale non-zero counts, which then sneaks stations
                            // back into chart averages they should be excluded from.
                            return {
                                ...station,
                                status: apiData.status,
                                is_online: apiData.is_active,
                                temperature: apiData.temperature,
                                last_update: apiData.last_update,
                                uptime_24h: apiData.uptime_24h,
                                checks_24h: apiData.checks_24h,
                                uptime_1h: apiData.uptime_1h,
                                checks_1h: apiData.checks_1h,
                                tracking_since: apiData.tracking_since,
                                uptime: apiData.uptime_24h !== undefined ? apiData.uptime_24h : (apiData.is_active === 1 ? 100.0 : 0.0),
                            };
                        }
                        return station;
                    });
                }
            } catch (e) {
                console.warn('Could not load uptime percentages:', e.message);
            }

            setStations(processedStations);
            const lastSync = payload.stations && payload.stations.length > 0
                ? new Date(payload.stations[0].last_update || new Date())
                : new Date();
            setLastUpdated(lastSync);
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
        fetchStations();
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
