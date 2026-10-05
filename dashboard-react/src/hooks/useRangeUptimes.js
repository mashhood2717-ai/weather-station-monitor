import { useState, useEffect } from 'react';
import axios from 'axios';
import { message } from 'antd';
import { API_BASE } from '../utils/constants';

export const UPTIME_RANGE_LABELS = {
    '24h': '24h',
    daily: 'Today',
    '7d': '7 Days',
    '30d': '30 Days',
    '1y': '1 Year',
    month: 'This Month',
    lastmonth: 'Last Month',
    year: 'This Year',
    lastyear: 'Last Year',
};

// Calendar windows, resolved on the PKT clock (UTC+5) the dashboard reports in.
// The Worker's own presets are all rolling, so these go through range=custom,
// the only form that carries an upper bound.
export function pktCalendarRange(key) {
    // 'month:YYYY-MM' is an explicitly picked calendar month.
    if (typeof key === 'string' && key.startsWith('month:')) {
        const ym = key.slice(6);
        if (!/^\d{4}-\d{2}$/.test(ym)) return null;
        const [y, m] = ym.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return [`${ym}-01`, `${ym}-${String(lastDay).padStart(2, '0')}`];
    }
    const pkt = new Date(Date.now() + 5 * 3600 * 1000);
    const y = pkt.getUTCFullYear(), m = pkt.getUTCMonth(), d = pkt.getUTCDate();
    const iso = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    if (key === 'month') return [iso(y, m, 1), iso(y, m, d)];
    if (key === 'lastmonth') {
        const ly = m === 0 ? y - 1 : y, lm = m === 0 ? 11 : m - 1;
        return [iso(ly, lm, 1), iso(ly, lm, lastDay(ly, lm))];
    }
    if (key === 'year') return [iso(y, 0, 1), iso(y, m, d)];
    if (key === 'lastyear') return [iso(y - 1, 0, 1), iso(y - 1, 11, 31)];
    return null;
}

// 'month:2026-07' reads back as 'July 2026'.
export function rangeLabelFor(range) {
    if (typeof range === 'string' && range.startsWith('month:')) {
        const [y, m] = range.slice(6).split('-').map(Number);
        if (y && m) {
            return new Date(Date.UTC(y, m - 1, 1))
                .toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        }
    }
    return UPTIME_RANGE_LABELS[range] || range;
}

// Per-station uptime for a chosen period, as a { station_id: percent } map.
//
// This lives above the table rather than inside it because the availability
// chart needs the same figures — otherwise the chart silently keeps showing 24h
// while the table shows the period the user picked.
//
// '24h' returns null: useStations() already carries those values on the station
// objects, so there is nothing to override and no request to make.
export function useRangeUptimes(range) {
    const [rangeUptimes, setRangeUptimes] = useState(null);
    const [rangeLoading, setRangeLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (range === '24h') {
            setRangeUptimes(null);
            return undefined;
        }
        setRangeLoading(true);
        const calendar = pktCalendarRange(range);
        const query = calendar
            ? `range=custom&start=${calendar[0]}&end=${calendar[1]}`
            : `range=${range}`;
        axios.get(`${API_BASE}/api/uptime-percentages?${query}`)
            .then(resp => {
                if (cancelled) return;
                // Keep checks alongside the percentage. The Worker reports a
                // station with no history for the window as 100% when it is
                // currently Active, so checks === 0 is the only way to tell
                // "perfect" from "was not installed yet".
                const map = {};
                (resp.data?.uptime_data || []).forEach(u => {
                    map[String(u.station_id)] = { uptime: u.uptime_24h, checks: u.checks_24h || 0 };
                });
                setRangeUptimes(map);
            })
            .catch(() => { if (!cancelled) message.error('Failed to load uptime for ' + (UPTIME_RANGE_LABELS[range] || range)); })
            .finally(() => { if (!cancelled) setRangeLoading(false); });
        return () => { cancelled = true; };
    }, [range]);

    return { rangeUptimes, rangeLoading, rangeLabel: rangeLabelFor(range) };
}
