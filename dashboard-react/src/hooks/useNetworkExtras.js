import { useState, useEffect } from 'react';
import axios from 'axios';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';

// Three further stations counted in the headline alongside the weather stations.
export const EXTRA_STATIONS = 3;

// Rain gauges and level sensors are real monitored devices, so the headline
// counts them. Fetched live rather than hardcoded, so commissioning a gauge
// raises the total on the next load; the values below are only the fallback
// used until that resolves, or if the RG Worker (a different Cloudflare
// account) is unreachable — the headline must not depend on it being up.
const FALLBACK = { gauges: 144, gaugesOnline: 133, sensors: 11, sensorsOnline: 11 };

export function useNetworkExtras() {
    const [extras, setExtras] = useState(FALLBACK);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges`),
            axios.get(`${RAIN_GAUGES_API_BASE}/api/level-sensors`),
        ])
            .then(([rg, ls]) => {
                if (cancelled) return;
                const gauges = rg.data?.gauges || [];
                const sensors = ls.data?.sensors || [];
                setExtras({
                    gauges: gauges.length || FALLBACK.gauges,
                    gaugesOnline: gauges.length
                        ? gauges.filter(g => g.status === 'online').length
                        : FALLBACK.gaugesOnline,
                    sensors: sensors.length || FALLBACK.sensors,
                    sensorsOnline: sensors.length
                        ? sensors.filter(s => s.status === 'online').length
                        : FALLBACK.sensorsOnline,
                });
            })
            .catch(() => {
                // Keep the fallback counts rather than dropping the extras entirely.
                if (!cancelled) console.warn('Network extras unavailable, using fallback counts');
            });
        return () => { cancelled = true; };
    }, []);

    const total = extras.gauges + extras.sensors + EXTRA_STATIONS;
    const online = extras.gaugesOnline + extras.sensorsOnline + EXTRA_STATIONS;
    return { ...extras, total, online, offline: total - online };
}
