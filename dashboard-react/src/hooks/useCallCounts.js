import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_BASE } from '../utils/constants';

// Calls logged per station over the last year, as a { station_id: count } map,
// for the table's Calls column. One request rather than one per station: the
// endpoint returns the whole set with station_id on each row.
export function useCallCounts() {
    const [callCounts, setCallCounts] = useState({});

    useEffect(() => {
        let cancelled = false;
        axios.get(`${API_BASE}/api/calls?range=1y`)
            .then(resp => {
                if (cancelled) return;
                const counts = {};
                (resp.data?.calls || []).forEach(c => {
                    const key = String(c.station_id);
                    counts[key] = (counts[key] || 0) + 1;
                });
                setCallCounts(counts);
            })
            .catch(() => {
                // Column just shows zero; not worth interrupting the dashboard for.
                if (!cancelled) console.warn('Call counts unavailable');
            });
        return () => { cancelled = true; };
    }, []);

    return callCounts;
}
