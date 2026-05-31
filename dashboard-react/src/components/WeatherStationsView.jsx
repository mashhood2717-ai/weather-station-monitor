import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import {
    Card, Table, Tag, Space, Spin, Statistic, Row, Col, Modal, Radio, Typography, Button, message,
} from 'antd';
import { ReloadOutlined, DownloadOutlined } from '@ant-design/icons';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';

const { Text } = Typography;

// ─── Unit conversions & display helpers ──────────────────────────────────────

// Wind speed: GarajCloud reports m/s. We display km/h (multiply by 3.6).
function msToKmh(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
    return Number(v) * 3.6;
}

// Wind direction: convert degrees → 16-point compass cardinal (N, NNE, NE, ...).
const CARDINAL_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function degToCardinal(deg) {
    if (deg === null || deg === undefined || !Number.isFinite(Number(deg))) return '—';
    const n = Number(deg);
    const idx = Math.round(((n % 360 + 360) % 360) / 22.5) % 16;
    return CARDINAL_16[idx];
}

// MSLP offset per station (in hPa). GarajCloud reports absolute pressure; we
// add an elevation-based offset to convert to Mean Sea Level Pressure. All
// three current WS are in Lahore (~210 m) → +28 hPa. Future stations default
// to 0 until the user provides the right factor.
const WS_PRESSURE_MSLP_OFFSET = {
    '69ce3e190d2c18ad513b7bc8': 28, // WS - Head Office WASA Lhr
    '69cf9c07e70efc69444abd48': 28, // WS - New Head Office WASA Lhr
    '69f9957a25977997e892cff7': 28, // WS - Farrukhabad Lhr
};
function toMSLP(stationId, pressure) {
    if (pressure === null || pressure === undefined || !Number.isFinite(Number(pressure))) return null;
    return Number(pressure) + (WS_PRESSURE_MSLP_OFFSET[stationId] || 0);
}

function statusTag(status) {
    return status === 'online'
        ? <Tag color="green" style={{ fontWeight: 600 }}>ONLINE</Tag>
        : <Tag color="red" style={{ fontWeight: 600 }}>OFFLINE</Tag>;
}

function uptimeCell(value, checks) {
    if (value === null || value === undefined || !checks) {
        return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
    }
    const v = Number(value);
    const color = v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
    return <Text style={{ color, fontWeight: 600, fontSize: 13 }}>{v.toFixed(1)}%</Text>;
}

function num(v, digits = 1, suffix = '') {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return <Text type="secondary">—</Text>;
    return <span>{Number(v).toFixed(digits)}{suffix}</span>;
}

function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const m = Math.floor(ms / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

// Bucket-period → human chart label, matching the rain-gauge chart logic.
function formatBucketLabel(period, granularity) {
    if (granularity === '15min') {
        // Raw 15-min reading. Period is "YYYY-MM-DD HH:MM:SS" UTC; convert
        // to PKT (+5h) and show HH:MM.
        const m = period.match(/(\d{2}):(\d{2})/);
        if (!m) return period;
        const utcHour = parseInt(m[1], 10);
        const min = m[2];
        const pktHour = (utcHour + 5) % 24;
        return `${String(pktHour).padStart(2, '0')}:${min}`;
    }
    if (granularity === 'hourly') {
        const m = period.match(/(\d{2}):00/);
        if (!m) return period;
        const pktHour = (parseInt(m[1], 10) + 5) % 24;
        return `${String(pktHour).padStart(2, '0')}:00`;
    }
    if (granularity === '6hour') {
        const parts = period.split(' ');
        if (parts.length < 2) return period;
        const dateStr = parts[0];
        const m = parts[1].match(/(\d{2}):/);
        const pktHour = m ? (parseInt(m[1], 10) + 5) % 24 : 0;
        const d = new Date(dateStr + 'T00:00:00');
        return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${String(pktHour).padStart(2, '0')}:00`;
    }
    if (granularity === 'daily') {
        const d = new Date(period + 'T00:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    if (granularity === 'monthly') {
        const [Y, M] = period.split('-');
        if (!Y || !M) return period;
        const d = new Date(parseInt(Y, 10), parseInt(M, 10) - 1, 1);
        return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }
    return period;
}

// ─── MiniChart: line OR bar, hover tooltips, dot per data point ─────────────
function MiniChart({ trend, granularity, valueOf, label, unit, color, chartType, isDark, yIsPercent = false }) {
    const canvasRef = useRef(null);
    const dataPointsRef = useRef([]); // [{ x, y, label, value }] populated during draw
    const [tooltip, setTooltip] = useState(null); // { x, y, label, value } or null

    useEffect(() => {
        if (!canvasRef.current || !trend) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const W = rect.width;
        const H = 160;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.scale(dpr, dpr);

        const pad = { top: 14, right: 12, bottom: 26, left: 46 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        const allValues = trend.map(valueOf);
        const real = allValues.filter(v => Number.isFinite(v));
        if (!real.length) {
            dataPointsRef.current = [];
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.textAlign = 'center';
            ctx.font = '12px Inter';
            ctx.fillText(`No ${label.toLowerCase()} data yet`, W / 2, H / 2);
            return;
        }

        let yMin, yMax;
        if (yIsPercent) {
            yMin = 0; yMax = 100;
        } else {
            const minV = Math.min(...real);
            const maxV = Math.max(...real);
            const pad10 = Math.max((maxV - minV) * 0.12, 1);
            yMin = minV - pad10; yMax = maxV + pad10;
        }
        const yOf = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
        const xOf = (i) => pad.left + (i / Math.max(1, allValues.length - 1)) * plotW;

        ctx.clearRect(0, 0, W, H);

        // Grid + Y labels
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
            const y = pad.top + (plotH / 3) * i;
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            const val = yMax - ((yMax - yMin) / 3) * i;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Inter';
            ctx.textAlign = 'right';
            ctx.fillText(val.toFixed(yIsPercent ? 0 : 1) + (unit ? unit : ''), pad.left - 5, y + 3);
        }

        // X labels (sparse — at most ~7 across the width)
        const xLabels = trend.map(t => formatBucketLabel(t.period, granularity));
        const labelStep = Math.max(1, Math.floor(allValues.length / 7));
        ctx.textAlign = 'center';
        for (let i = 0; i < xLabels.length; i += labelStep) {
            const x = xOf(i);
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Inter';
            ctx.fillText(xLabels[i], x, H - pad.bottom + 14);
        }

        // Record positions for every real data point so hover can find them.
        const points = [];
        allValues.forEach((v, i) => {
            if (!Number.isFinite(v)) return;
            points.push({ x: xOf(i), y: yOf(v), label: xLabels[i], value: v });
        });
        dataPointsRef.current = points;

        if (chartType === 'bar') {
            const slot = plotW / allValues.length;
            const barW = Math.max(2, Math.min(28, slot * 0.7));
            for (let i = 0; i < allValues.length; i++) {
                const v = allValues[i];
                if (!Number.isFinite(v)) continue;
                const cx = pad.left + slot * i + slot / 2;
                const x = cx - barW / 2;
                const y = yOf(v);
                const baseY = yIsPercent ? yOf(0) : pad.top + plotH;
                const barH = baseY - y;
                ctx.fillStyle = color;
                const r = Math.min(4, barW / 2);
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.lineTo(x + barW - r, y);
                ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
                ctx.lineTo(x + barW, y + barH);
                ctx.lineTo(x, y + barH);
                ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y);
                ctx.closePath();
                ctx.fill();
            }
            return;
        }

        // ── Line mode ──
        // Gradient fill under the line
        const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
        gradient.addColorStop(0, color + '55');
        gradient.addColorStop(1, color + '08');
        ctx.beginPath();
        let firstX = null;
        allValues.forEach((v, i) => {
            if (!Number.isFinite(v)) return;
            const x = xOf(i); const y = yOf(v);
            if (firstX === null) { firstX = x; ctx.moveTo(x, y); }
            else ctx.lineTo(x, y);
        });
        if (firstX !== null) {
            ctx.lineTo(xOf(allValues.length - 1), H - pad.bottom);
            ctx.lineTo(firstX, H - pad.bottom);
            ctx.closePath();
            ctx.fillStyle = gradient;
            ctx.fill();
        }

        // Line stroke
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        let moved = false;
        allValues.forEach((v, i) => {
            if (!Number.isFinite(v)) { moved = false; return; }
            const x = xOf(i); const y = yOf(v);
            if (!moved) { ctx.moveTo(x, y); moved = true; } else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Dot at EVERY real reading. With 96 points the dots get small but
        // remain visible; if there are very many points (>100), thin them
        // out to every other so the line doesn't disappear under the dots.
        const dotStep = allValues.length > 100 ? Math.ceil(allValues.length / 100) : 1;
        allValues.forEach((v, i) => {
            if (!Number.isFinite(v)) return;
            if (i % dotStep !== 0 && i !== allValues.length - 1) return;
            ctx.beginPath();
            ctx.arc(xOf(i), yOf(v), 2.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = isDark ? '#1e293b' : '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        });
    }, [trend, granularity, valueOf, label, unit, color, chartType, isDark, yIsPercent]);

    // Find the nearest data point to the cursor and show a tooltip.
    function handleMouseMove(e) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const points = dataPointsRef.current;
        if (!points.length) return;
        let best = null;
        let bestDx = Infinity;
        for (const p of points) {
            const dx = Math.abs(mx - p.x);
            if (dx < bestDx) { bestDx = dx; best = p; }
        }
        const slot = rect.width / Math.max(1, points.length);
        if (best && bestDx < Math.max(slot, 16) && my >= 0 && my <= rect.height) {
            setTooltip({ x: best.x, y: best.y, label: best.label, value: best.value });
        } else {
            setTooltip(null);
        }
    }

    const tooltipValueText = tooltip
        ? `${Number(tooltip.value).toFixed(yIsPercent ? 1 : 1)}${unit || ''}`
        : '';

    return (
        <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#cbd5e1' : '#334155', marginBottom: 4 }}>
                {label}
            </div>
            <div style={{ width: '100%', position: 'relative' }}>
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: 160, display: 'block' }}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setTooltip(null)}
                />
                {tooltip && (
                    <div style={{
                        position: 'absolute',
                        left: tooltip.x,
                        top: tooltip.y - 10,
                        transform: 'translate(-50%, -100%)',
                        background: isDark ? '#0f172a' : '#1e293b',
                        color: '#fff',
                        padding: '6px 10px',
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: 1.3,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        border: isDark ? '1px solid #334155' : '1px solid rgba(255,255,255,0.1)',
                    }}>
                        <div style={{ opacity: 0.85 }}>{tooltip.label}</div>
                        <div style={{ fontWeight: 700, fontSize: 13, marginTop: 2 }}>
                            {tooltipValueText}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function WeatherStationsView({ isDark }) {
    const [stations, setStations] = useState([]);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [loading, setLoading] = useState(false);

    const [selected, setSelected] = useState(null);
    const [chartRange, setChartRange] = useState('24h');
    const [chartType, setChartType] = useState('line'); // 'line' | 'bar'
    const [history, setHistory] = useState(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [uptimeHistory, setUptimeHistory] = useState(null);
    const [uptimeHistoryLoading, setUptimeHistoryLoading] = useState(false);

    const subColor = isDark ? '#94a3b8' : '#64748b';

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [stationsResp, uptimeResp] = await Promise.allSettled([
                axios.get(`${RAIN_GAUGES_API_BASE}/api/weather-stations`),
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges-uptime?range=24h`),
            ]);
            if (stationsResp.status !== 'fulfilled' || !stationsResp.value.data?.success) {
                throw new Error('failed to load weather stations');
            }
            const live = stationsResp.value.data.stations || [];
            const uptimeMap = {};
            if (uptimeResp.status === 'fulfilled' && uptimeResp.value.data?.success) {
                (uptimeResp.value.data.gauges || []).forEach(u => { uptimeMap[u.gauge_id] = u; });
            }
            setStations(live.map(s => ({
                ...s,
                uptime_24h: uptimeMap[s.id]?.uptime_24h ?? null,
                checks_24h: uptimeMap[s.id]?.checks_24h ?? 0,
                last_online: uptimeMap[s.id]?.last_online ?? null,
            })));
            setLastUpdated(stationsResp.value.data.last_updated || null);
        } catch (e) {
            console.error('Weather stations fetch error:', e);
            message.error(`Failed to load weather stations: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    // History fetches (readings + uptime) — re-fired when the range changes.
    useEffect(() => {
        if (!selected) return;
        let cancelled = false;
        setHistoryLoading(true);
        setUptimeHistoryLoading(true);
        Promise.allSettled([
            axios.get(`${RAIN_GAUGES_API_BASE}/api/weather-station-history/${encodeURIComponent(selected.id)}?range=${chartRange}`),
            axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauge-history/${encodeURIComponent(selected.id)}?range=${chartRange}`),
        ]).then(([readingsR, uptimeR]) => {
            if (cancelled) return;
            if (readingsR.status === 'fulfilled' && readingsR.value.data?.success) setHistory(readingsR.value.data);
            if (uptimeR.status === 'fulfilled' && uptimeR.value.data?.success) setUptimeHistory(uptimeR.value.data);
        }).finally(() => {
            if (cancelled) return;
            setHistoryLoading(false);
            setUptimeHistoryLoading(false);
        });
        return () => { cancelled = true; };
    }, [selected, chartRange]);

    const aggregate = useMemo(() => {
        const total = stations.length;
        const online = stations.filter(s => s.status === 'online').length;
        const withUptime = stations.filter(s => s.checks_24h > 0 && s.uptime_24h != null);
        const avgUptime = withUptime.length
            ? withUptime.reduce((a, s) => a + Number(s.uptime_24h), 0) / withUptime.length
            : null;
        return {
            total,
            online,
            offline: total - online,
            avgUptime: avgUptime !== null ? Number(avgUptime.toFixed(1)) : null,
            avgDowntime: avgUptime !== null ? Number((100 - avgUptime).toFixed(1)) : null,
        };
    }, [stations]);

    const exportAllCsv = () => {
        // Use the current chartRange? No — for the top-of-page export the user
        // hasn't picked a range, so default to the broadest meaningful one (1y).
        // They'll get all data accumulated since launch up to 1y.
        window.location.href = `${RAIN_GAUGES_API_BASE}/api/weather-stations-export?range=1y`;
    };
    const exportSelectedCsv = () => {
        if (!selected) return;
        window.location.href = `${RAIN_GAUGES_API_BASE}/api/weather-station-export/${encodeURIComponent(selected.id)}?range=${chartRange}`;
    };

    const columns = [
        {
            title: 'Station',
            dataIndex: 'name',
            key: 'name',
            sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
            render: (name, row) => (
                <div>
                    <div style={{ fontWeight: 600 }}>{name}</div>
                    <div style={{ fontSize: 11, color: subColor }}>{row.id}</div>
                </div>
            ),
        },
        { title: 'Status', dataIndex: 'status', key: 'status', align: 'center', width: 110, render: statusTag },
        {
            title: 'Uptime (24h)', dataIndex: 'uptime_24h', key: 'uptime_24h', align: 'right', width: 110,
            sorter: (a, b) => (Number(a.uptime_24h) || 0) - (Number(b.uptime_24h) || 0),
            render: (v, row) => uptimeCell(v, row.checks_24h),
        },
        {
            title: 'Temp', dataIndex: 'temperature', key: 'temperature', align: 'right', width: 90,
            sorter: (a, b, sortOrder) => {
                const s = sortOrder === 'descend' ? -Infinity : Infinity;
                return (a.temperature ?? s) - (b.temperature ?? s);
            },
            render: (v) => num(v, 1, ' °C'),
        },
        {
            title: 'Humidity', dataIndex: 'humidity', key: 'humidity', align: 'right', width: 100,
            render: (v) => num(v, 1, ' %'),
        },
        {
            title: 'Wind Speed', dataIndex: 'wind_speed', key: 'wind_speed', align: 'right', width: 110,
            sorter: (a, b, sortOrder) => {
                const s = sortOrder === 'descend' ? -Infinity : Infinity;
                return (a.wind_speed ?? s) - (b.wind_speed ?? s);
            },
            render: (v) => num(msToKmh(v), 1, ' km/h'),
        },
        {
            title: 'Wind Dir', dataIndex: 'wind_direction', key: 'wind_direction', align: 'center', width: 110,
            render: (v) => {
                const cardinal = degToCardinal(v);
                if (cardinal === '—') return <Text type="secondary">—</Text>;
                return (
                    <span>
                        <span style={{ fontWeight: 600 }}>{cardinal}</span>
                        <span style={{ fontSize: 11, color: subColor, marginLeft: 4 }}>({Number(v).toFixed(0)}°)</span>
                    </span>
                );
            },
        },
        {
            title: 'Pressure (MSLP)', dataIndex: 'pressure', key: 'pressure', align: 'right', width: 130,
            render: (v, row) => num(toMSLP(row.id, v), 1, ' hPa'),
        },
        {
            title: 'Heat Index', dataIndex: 'heat_index', key: 'heat_index', align: 'right', width: 110,
            render: (v) => num(v, 1, ' °C'),
        },
        {
            title: 'Last Online', dataIndex: 'last_online', key: 'last_online', width: 110,
            render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{timeAgo(v)}</Text>,
        },
    ];

    const lastUpdatedText = lastUpdated
        ? `Last updated: ${new Date(lastUpdated).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}`
        : '';

    return (
        <div>
            {/* Aggregate tiles — Total, Online, Offline, Avg Uptime, Avg Downtime */}
            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🌤️ Total Stations" value={aggregate.total} valueStyle={{ color: '#0ea5e9' }} /></Card></Col>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🟢 Online"  value={aggregate.online}  valueStyle={{ color: '#10b981' }} /></Card></Col>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🔴 Offline" value={aggregate.offline} valueStyle={{ color: '#ef4444' }} /></Card></Col>
                <Col xs={12} md={5}><Card size="small"><Statistic title="📈 Avg Uptime (24h)"   value={aggregate.avgUptime   !== null ? `${aggregate.avgUptime}%`   : '—'} valueStyle={{ color: '#10b981' }} /></Card></Col>
                <Col xs={24} md={4}><Card size="small"><Statistic title="📉 Avg Downtime (24h)" value={aggregate.avgDowntime !== null ? `${aggregate.avgDowntime}%` : '—'} valueStyle={{ color: '#ef4444' }} /></Card></Col>
            </Row>

            {/* Stations table */}
            <Card styles={{ body: { padding: 16 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
                    <Space size={12} wrap>
                        <h3 style={{ margin: 0, fontSize: 16 }}>🌤️ Weather Stations</h3>
                        <span style={{ fontSize: 11, color: subColor }}>{lastUpdatedText}</span>
                    </Space>
                    <Space size={8} wrap>
                        <Button icon={<DownloadOutlined />} onClick={exportAllCsv} title="Export all stations' readings (last 1 year) as CSV">📥 Export CSV</Button>
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
                    </Space>
                </div>

                <Spin spinning={loading && stations.length === 0}>
                    <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={stations}
                        size="small"
                        pagination={false}
                        scroll={{ x: 'max-content' }}
                        onRow={(record) => ({
                            onClick: () => setSelected(record),
                            style: { cursor: 'pointer' },
                        })}
                    />
                </Spin>
            </Card>

            {/* Historical chart modal */}
            <Modal
                title={selected ? `🌤️  ${selected.name}` : 'Station Detail'}
                open={!!selected}
                onCancel={() => { setSelected(null); setHistory(null); setUptimeHistory(null); setChartRange('24h'); setChartType('line'); }}
                footer={<Button onClick={() => setSelected(null)}>Close</Button>}
                width={960}
            >
                {selected && (
                    <div>
                        {/* Current readings strip with applied conversions */}
                        <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Temperature</div><div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444' }}>{num(selected.temperature, 1, '°C')}</div></Card></Col>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Humidity</div><div style={{ fontSize: 18, fontWeight: 700, color: '#06b6d4' }}>{num(selected.humidity, 1, '%')}</div></Card></Col>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Wind Speed</div><div style={{ fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>{num(msToKmh(selected.wind_speed), 1, ' km/h')}</div></Card></Col>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Wind Dir</div><div style={{ fontSize: 18, fontWeight: 700, color: '#0ea5e9' }}>{degToCardinal(selected.wind_direction)} <span style={{ fontSize: 11, color: subColor, fontWeight: 400 }}>({Number(selected.wind_direction || 0).toFixed(0)}°)</span></div></Card></Col>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Pressure (MSLP)</div><div style={{ fontSize: 18, fontWeight: 700, color: '#10b981' }}>{num(toMSLP(selected.id, selected.pressure), 1, ' hPa')}</div></Card></Col>
                            <Col xs={12} md={4}><Card size="small" styles={{ body: { padding: 8 } }}><div style={{ fontSize: 11, color: subColor }}>Heat Index</div><div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{num(selected.heat_index, 1, '°C')}</div></Card></Col>
                        </Row>

                        {/* Controls strip: chart type, range, export */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: subColor }}>Historical readings</div>
                            <Space size={6} wrap>
                                <Radio.Group size="small" value={chartType} onChange={e => setChartType(e.target.value)} buttonStyle="solid">
                                    <Radio.Button value="line">Line</Radio.Button>
                                    <Radio.Button value="bar">Bar</Radio.Button>
                                </Radio.Group>
                                <Radio.Group size="small" value={chartRange} onChange={e => setChartRange(e.target.value)} buttonStyle="solid">
                                    <Radio.Button value="24h">24h</Radio.Button>
                                    <Radio.Button value="daily">Daily</Radio.Button>
                                    <Radio.Button value="7d">7d</Radio.Button>
                                    <Radio.Button value="30d">30d</Radio.Button>
                                    <Radio.Button value="1y">1y</Radio.Button>
                                </Radio.Group>
                                <Button size="small" icon={<DownloadOutlined />} onClick={exportSelectedCsv} title="Export this station's readings for the selected range">CSV</Button>
                            </Space>
                        </div>

                        {/* Uptime chart (uses /api/rain-gauge-history because WS uptime
                            is in the same rain_gauge_logs table) */}
                        <Spin spinning={uptimeHistoryLoading}>
                            <div style={{ marginBottom: 16 }}>
                                {uptimeHistory && uptimeHistory.trend && uptimeHistory.trend.length > 0 ? (
                                    <MiniChart
                                        trend={uptimeHistory.trend}
                                        granularity={uptimeHistory.granularity}
                                        valueOf={(t) => Number(t.uptime_pct)}
                                        label={`Uptime (${uptimeHistory.range || chartRange})`}
                                        unit="%"
                                        color="#10b981"
                                        chartType={chartType}
                                        isDark={isDark}
                                        yIsPercent={true}
                                    />
                                ) : (
                                    <div style={{ textAlign: 'center', padding: 16, color: subColor, fontSize: 12 }}>
                                        Uptime data: not enough samples yet
                                    </div>
                                )}
                            </div>
                        </Spin>

                        {/* Reading charts (temp / humidity / wind / pressure) */}
                        <Spin spinning={historyLoading}>
                            {history && history.trend && history.trend.length > 0 ? (
                                <Row gutter={[12, 12]}>
                                    <Col xs={24} md={12}>
                                        <MiniChart trend={history.trend} granularity={history.granularity}
                                            valueOf={(t) => Number(t.temperature)}
                                            label="Temperature" unit="°C" color="#ef4444"
                                            chartType={chartType} isDark={isDark} />
                                    </Col>
                                    <Col xs={24} md={12}>
                                        <MiniChart trend={history.trend} granularity={history.granularity}
                                            valueOf={(t) => Number(t.humidity)}
                                            label="Humidity" unit="%" color="#06b6d4"
                                            chartType={chartType} isDark={isDark} />
                                    </Col>
                                    <Col xs={24} md={12}>
                                        <MiniChart trend={history.trend} granularity={history.granularity}
                                            valueOf={(t) => msToKmh(t.wind_speed)}
                                            label="Wind Speed" unit=" km/h" color="#8b5cf6"
                                            chartType={chartType} isDark={isDark} />
                                    </Col>
                                    <Col xs={24} md={12}>
                                        <MiniChart trend={history.trend} granularity={history.granularity}
                                            valueOf={(t) => toMSLP(selected.id, t.pressure)}
                                            label="Pressure (MSLP)" unit=" hPa" color="#10b981"
                                            chartType={chartType} isDark={isDark} />
                                    </Col>
                                </Row>
                            ) : (
                                <div style={{ textAlign: 'center', padding: 24, color: subColor }}>
                                    Reading charts: not enough samples yet — they'll fill in as polls accumulate (15-min cadence).
                                </div>
                            )}
                        </Spin>
                    </div>
                )}
            </Modal>
        </div>
    );
}
