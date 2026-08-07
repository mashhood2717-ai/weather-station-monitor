import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import { Card, Statistic, Row, Col, Input, Select, Button, Table, Tag, Space, Spin, Progress, Typography, Modal, Radio, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';
import WeatherStationsView from './WeatherStationsView';

const { Text } = Typography;

const STATUS_OPTIONS = [
    { value: 'all', label: 'All Status' },
    { value: 'online', label: 'Online Only' },
    { value: 'offline', label: 'Offline Only' },
];

// Mirrors stations' StationTable range options so both dashboards feel the same.
const RANGE_OPTIONS = [
    { value: '24h', label: '24h' },
    { value: 'daily', label: 'Daily' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '1y', label: '1y' },
];

function formatMm(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        return { text: '—', color: '#94a3b8', bold: false };
    }
    const n = Number(v);
    if (n <= 0) return { text: '0.0', color: '#94a3b8', bold: false };
    let color = '#22c55e';
    if (n >= 50) color = '#ef4444';
    else if (n >= 20) color = '#f59e0b';
    else if (n >= 5) color = '#06b6d4';
    return { text: n.toFixed(1), color, bold: true };
}

function MmCell({ value }) {
    const { text, color, bold } = formatMm(value);
    return <span style={{ color, fontWeight: bold ? 700 : 400 }}>{text}</span>;
}

export default function RainGauges({ isDark }) {
    // Sub-toggle inside this tab: rain gauges (87) vs weather stations (3).
    // The two views have completely different columns / charts / modals, so
    // they're separate components — this state just picks which one to render.
    const [subView, setSubView] = useState('rg'); // 'rg' | 'ws'
    // Reported up by WeatherStationsView so the toggle can show a real count.
    // null until that view has loaded at least once.
    const [wsCount, setWsCount] = useState(null);

    const [gauges, setGauges] = useState([]);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [loading, setLoading] = useState(false);

    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [range, setRange] = useState('24h');

    // Click-to-detail modal state
    const [selectedGauge, setSelectedGauge] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);

    // In-modal chart state
    const [chartRange, setChartRange] = useState('24h'); // 24h | 7d | 30d | 1y
    const [chartType, setChartType] = useState('bar');   // 'bar' | 'line'
    const [chartData, setChartData] = useState(null);
    const [chartLoading, setChartLoading] = useState(false);
    const chartCanvasRef = useRef(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // Two independent fetches: upstream rain totals + Worker-tracked uptime
            // for the selected range. Uptime endpoint may be 4xx briefly during
            // initial deploy; we don't want that to mask the live rain data, so
            // handle errors per-call.
            const [gaugesResp, uptimeResp] = await Promise.allSettled([
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges`),
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges-uptime?range=${range}`),
            ]);

            if (gaugesResp.status !== 'fulfilled' || !gaugesResp.value.data?.success) {
                throw new Error(gaugesResp.value?.data?.error || gaugesResp.reason?.message || 'Failed to fetch rain gauges');
            }
            const liveGauges = gaugesResp.value.data.gauges || [];

            // Build a map of gauge_id -> { uptime_24h, uptime_1h, checks_24h, checks_1h, last_online }
            const uptimeMap = {};
            if (uptimeResp.status === 'fulfilled' && uptimeResp.value.data?.success) {
                (uptimeResp.value.data.gauges || []).forEach(u => {
                    uptimeMap[u.gauge_id] = u;
                });
            } else {
                console.warn('Uptime fetch failed (proxy still works):', uptimeResp.reason?.message);
            }

            const merged = liveGauges.map(g => ({
                ...g,
                uptime_24h: uptimeMap[g.id]?.uptime_24h ?? null,
                uptime_1h: uptimeMap[g.id]?.uptime_1h ?? null,
                checks_24h: uptimeMap[g.id]?.checks_24h ?? 0,
                checks_1h: uptimeMap[g.id]?.checks_1h ?? 0,
                last_online: uptimeMap[g.id]?.last_online ?? null,
            }));

            setGauges(merged);
            setLastUpdated(gaugesResp.value.data.last_updated || null);
        } catch (e) {
            console.error('RainGauges fetch error:', e);
            message.error(`Failed to load rain gauges: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        fetchData();
        // fetchData is recreated when `range` changes (closure-captured), so this
        // also re-fires on range switches and the table updates.
    }, [fetchData]);

    const openDetail = useCallback(async (gauge) => {
        setSelectedGauge(gauge);
        setDetail(null);
        setDetailLoading(true);
        try {
            const resp = await axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauge-detail/${encodeURIComponent(gauge.id)}`);
            if (resp.data?.success) {
                setDetail(resp.data);
            } else {
                message.error(resp.data?.error || 'Failed to load gauge detail');
            }
        } catch (e) {
            message.error(`Failed to load gauge detail: ${e.message}`);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeDetail = () => {
        setSelectedGauge(null);
        setDetail(null);
        setChartData(null);
        setChartRange('24h');
        setChartType('bar');
    };

    // Build a per-gauge PDF on demand. Uses jsPDF + autotable (lazy-imported
    // so it doesn't bloat the initial bundle). Includes: title, header info,
    // uptime windows table, rain totals table, and a screenshot of the
    // in-modal chart canvas.
    const downloadPdf = useCallback(async () => {
        if (!selectedGauge) return;
        try {
            const [{ jsPDF }, autoTableMod] = await Promise.all([
                import('jspdf'),
                import('jspdf-autotable'),
            ]);
            const autoTable = autoTableMod.default || autoTableMod;
            const doc = new jsPDF({ unit: 'pt', format: 'a4' });
            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();

            // Title
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.text(`Rain Gauge Report`, 40, 50);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(12);
            doc.text(`${selectedGauge.name}`, 40, 70);
            doc.setFontSize(9);
            doc.setTextColor(120);
            doc.text(`ID: ${selectedGauge.id}    Status: ${(selectedGauge.status || '').toUpperCase()}`, 40, 86);
            const generatedAt = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
            doc.text(`Generated: ${generatedAt} PKT`, 40, 100);
            doc.setTextColor(0);

            // Uptime windows table
            const win = detail?.windows || {};
            const uptimeRows = ['1h', '24h', '7d', '30d', '1y'].map(w => [
                w.toUpperCase(),
                win[w]?.uptime != null ? `${win[w].uptime.toFixed(1)}%` : '—',
                win[w]?.checks ?? 0,
            ]);
            autoTable(doc, {
                startY: 120,
                head: [['Window', 'Uptime', 'Polls']],
                body: uptimeRows,
                theme: 'striped',
                headStyles: { fillColor: [16, 185, 129] },
                margin: { left: 40, right: 40 },
            });

            // Embed the chart canvas if present
            const cursor = doc.lastAutoTable?.finalY || 240;
            let chartY = cursor + 16;
            const canvas = chartCanvasRef.current;
            if (canvas) {
                try {
                    const png = canvas.toDataURL('image/png');
                    doc.setFontSize(10);
                    doc.setFont('helvetica', 'bold');
                    doc.text(`Uptime history (${chartRange})`, 40, chartY);
                    chartY += 6;
                    const imgW = pageW - 80;
                    const imgH = 180;
                    doc.addImage(png, 'PNG', 40, chartY, imgW, imgH);
                    chartY += imgH + 16;
                } catch (e) {
                    console.warn('chart embed failed:', e);
                }
            }

            // Rain totals table
            if (chartY > pageH - 200) { doc.addPage(); chartY = 50; }
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text('Rain totals (live from upstream)', 40, chartY);
            autoTable(doc, {
                startY: chartY + 6,
                head: [['Period', 'Rainfall']],
                body: [
                    ['Today',     selectedGauge.rain_daily != null ? `${Number(selectedGauge.rain_daily).toFixed(1)} mm` : '—'],
                    ['Last 24h',  selectedGauge.rain_24h  != null ? `${Number(selectedGauge.rain_24h).toFixed(1)} mm`  : '—'],
                    ['Last 7d',   selectedGauge.rain_7d   != null ? `${Number(selectedGauge.rain_7d).toFixed(1)} mm`   : '—'],
                    ['Last 30d',  selectedGauge.rain_30d  != null ? `${Number(selectedGauge.rain_30d).toFixed(1)} mm`  : '—'],
                    ['This year', selectedGauge.rain_this_year != null ? `${Number(selectedGauge.rain_this_year).toFixed(1)} mm` : '—'],
                    ['All time',  selectedGauge.rain_all_time  != null ? `${Number(selectedGauge.rain_all_time).toFixed(1)} mm`  : '—'],
                ],
                theme: 'striped',
                headStyles: { fillColor: [59, 130, 246] },
                margin: { left: 40, right: 40 },
            });

            // Footer
            const footY = doc.lastAutoTable?.finalY + 16 || pageH - 30;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(120);
            if (detail?.tracking_since) {
                doc.text(`Tracked since: ${new Date(detail.tracking_since + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}  ·  ${detail.total_rows} polls stored`, 40, footY);
            }

            doc.save(`rain-gauge-${selectedGauge.id}-${new Date().toISOString().slice(0, 10)}.pdf`);
        } catch (e) {
            console.error('PDF generation failed:', e);
            message.error('Failed to generate PDF: ' + (e.message || e));
        }
    }, [selectedGauge, detail, chartRange]);

    // Build a network-wide PDF: one row per gauge with the key uptime/rain
    // numbers already shown in the table. No per-gauge chart (would explode
    // page count); aggregate stats land in the header instead.
    const downloadAllPdf = useCallback(async () => {
        if (!gauges.length) {
            message.warning('No gauges loaded yet');
            return;
        }
        try {
            const [{ jsPDF }, autoTableMod] = await Promise.all([
                import('jspdf'),
                import('jspdf-autotable'),
            ]);
            const autoTable = autoTableMod.default || autoTableMod;
            const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();

            // Header
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.text('Rain Gauges — Network Report', 40, 50);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(120);
            const generatedAt = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
            doc.text(`Range: ${range.toUpperCase()}    Generated: ${generatedAt} PKT`, 40, 68);
            doc.setTextColor(0);

            // Aggregate stats strip — computed inline (mirrors the tiles).
            // `stats` is declared further down via useMemo so we can't depend
            // on it here without a temporal-dead-zone crash.
            const total = gauges.length;
            const online = gauges.filter(g => g.status === 'online').length;
            const withChecks = gauges.filter(g =>
                (g.checks_24h || 0) > 0 && g.uptime_24h !== null && g.uptime_24h !== undefined
            );
            const avgUptime = withChecks.length
                ? withChecks.reduce((a, g) => a + Number(g.uptime_24h), 0) / withChecks.length
                : null;

            autoTable(doc, {
                startY: 82,
                head: [['Total', 'Online', 'Offline', `Avg Uptime (${range})`, `Avg Downtime (${range})`, 'Gauges w/ data']],
                body: [[
                    total,
                    online,
                    total - online,
                    avgUptime !== null ? `${avgUptime.toFixed(1)}%` : '—',
                    avgUptime !== null ? `${(100 - avgUptime).toFixed(1)}%` : '—',
                    withChecks.length,
                ]],
                theme: 'grid',
                headStyles: { fillColor: [14, 165, 233], fontSize: 9 },
                bodyStyles: { fontSize: 10, halign: 'center' },
                margin: { left: 40, right: 40 },
            });

            // Per-gauge table — sorted by uptime (range) descending so the
            // worst-performing gauges sink to the bottom and the report
            // reads like a leaderboard.
            const rows = gauges.slice().sort((a, b) => {
                const av = a.uptime_24h == null ? -1 : Number(a.uptime_24h);
                const bv = b.uptime_24h == null ? -1 : Number(b.uptime_24h);
                return bv - av;
            }).map(g => [
                g.name || g.id,
                (g.status || '—').toUpperCase(),
                g.uptime_24h != null ? `${Number(g.uptime_24h).toFixed(1)}%` : '—',
                g.checks_24h ?? 0,
                g.uptime_1h != null ? `${Number(g.uptime_1h).toFixed(1)}%` : '—',
                g.checks_1h ?? 0,
                g.rain_daily != null ? Number(g.rain_daily).toFixed(1) : '—',
                g.rain_24h   != null ? Number(g.rain_24h).toFixed(1)   : '—',
                g.rain_7d    != null ? Number(g.rain_7d).toFixed(1)    : '—',
                g.rain_30d   != null ? Number(g.rain_30d).toFixed(1)   : '—',
            ]);

            autoTable(doc, {
                startY: (doc.lastAutoTable?.finalY || 120) + 14,
                head: [[
                    'Gauge',
                    'Status',
                    `Uptime ${range.toUpperCase()}`,
                    'Polls',
                    'Uptime 1H',
                    'Polls',
                    'Today (mm)',
                    '24h (mm)',
                    '7d (mm)',
                    '30d (mm)',
                ]],
                body: rows,
                theme: 'striped',
                headStyles: { fillColor: [16, 185, 129], fontSize: 9 },
                bodyStyles: { fontSize: 9 },
                columnStyles: {
                    0: { cellWidth: 180 },
                    1: { halign: 'center' },
                    2: { halign: 'right' },
                    3: { halign: 'right' },
                    4: { halign: 'right' },
                    5: { halign: 'right' },
                    6: { halign: 'right' },
                    7: { halign: 'right' },
                    8: { halign: 'right' },
                    9: { halign: 'right' },
                },
                didParseCell: (data) => {
                    // Color the status cell + uptime cells
                    if (data.section !== 'body') return;
                    if (data.column.index === 1) {
                        const v = String(data.cell.raw || '').toUpperCase();
                        if (v === 'ONLINE')  data.cell.styles.textColor = [16, 134, 89];
                        if (v === 'OFFLINE') data.cell.styles.textColor = [220, 38, 38];
                    }
                    if (data.column.index === 2 || data.column.index === 4) {
                        const raw = String(data.cell.raw || '').replace('%', '');
                        const v = Number(raw);
                        if (Number.isFinite(v)) {
                            if (v >= 90) data.cell.styles.textColor = [16, 134, 89];
                            else if (v >= 50) data.cell.styles.textColor = [180, 120, 20];
                            else data.cell.styles.textColor = [220, 38, 38];
                        }
                    }
                },
                margin: { left: 40, right: 40 },
                didDrawPage: (data) => {
                    // Footer with page number
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(8);
                    doc.setTextColor(120);
                    doc.text(
                        `Page ${doc.internal.getNumberOfPages()}  ·  ${gauges.length} gauges  ·  weatherwalay.com`,
                        pageW / 2,
                        pageH - 18,
                        { align: 'center' },
                    );
                    doc.setTextColor(0);
                },
            });

            doc.save(`rain-gauges-network-${range}-${new Date().toISOString().slice(0, 10)}.pdf`);
        } catch (e) {
            console.error('All-gauges PDF failed:', e);
            message.error('Failed to generate report: ' + (e.message || e));
        }
    }, [gauges, range]);

    // Fetch history whenever the modal is open and the chart range changes.
    useEffect(() => {
        if (!selectedGauge) return;
        let cancelled = false;
        setChartLoading(true);
        axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauge-history/${encodeURIComponent(selectedGauge.id)}?range=${chartRange}`)
            .then(r => { if (!cancelled && r.data?.success) setChartData(r.data); })
            .catch(e => { if (!cancelled) console.warn('history fetch failed', e.message); })
            .finally(() => { if (!cancelled) setChartLoading(false); });
        return () => { cancelled = true; };
    }, [selectedGauge, chartRange]);

    // Canvas chart — uptime % per bucket. Bar by default; line on toggle.
    // Matches UptimeTrendChart.jsx (stations) styling so it feels consistent.
    useEffect(() => {
        if (!chartData?.trend || !chartCanvasRef.current) return;
        const canvas = chartCanvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const W = rect.width;
        const H = 200;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.scale(dpr, dpr);

        const pad = { top: 16, right: 12, bottom: 32, left: 40 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;
        const trend = chartData.trend;
        if (!trend.length) {
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.textAlign = 'center';
            ctx.font = '12px Inter, sans-serif';
            ctx.fillText('Not enough data yet — chart will fill in as polls accumulate', W / 2, H / 2);
            return;
        }

        const values = trend.map(t => Number(t.uptime_pct) || 0);
        const labels = trend.map(t => {
            // The Worker returns periods as UTC strings; for time-of-day formats
            // we add +5h to display in PKT.
            const g = chartData.granularity;
            if (g === 'hourly') {
                // "2026-05-30 14:00:00" UTC → "19:00" PKT
                const m = t.period.match(/(\d{2}):00/);
                if (!m) return t.period;
                const utcHour = parseInt(m[1], 10);
                const pktHour = (utcHour + 5) % 24;
                return `${String(pktHour).padStart(2, '0')}:00`;
            }
            if (g === '15min') {
                // Kept for backward compat with any older cached responses.
                const m = t.period.match(/(\d{2}):(\d{2})/);
                if (!m) return t.period;
                const utcHour = parseInt(m[1], 10);
                const min = m[2];
                const pktHour = (utcHour + 5) % 24;
                return `${String(pktHour).padStart(2, '0')}:${min}`;
            }
            if (g === '6hour') {
                // "2026-05-30 18:00:00" UTC → "MMM DD HH:00" PKT
                const parts = t.period.split(' ');
                if (parts.length < 2) return t.period;
                const dateStr = parts[0];
                const m = parts[1].match(/(\d{2}):/);
                const utcHour = m ? parseInt(m[1], 10) : 0;
                const pktHour = (utcHour + 5) % 24;
                const d = new Date(dateStr + 'T00:00:00');
                return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${String(pktHour).padStart(2, '0')}:00`;
            }
            if (g === 'daily') {
                const d = new Date(t.period + 'T00:00:00');
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }
            if (g === 'monthly') {
                // "2026-05" → "May 2026"
                const [Y, M] = t.period.split('-');
                if (!Y || !M) return t.period;
                const d = new Date(parseInt(Y, 10), parseInt(M, 10) - 1, 1);
                return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            }
            return t.period;
        });

        const minVal = Math.max(0, Math.min(...values) - 5);
        const maxVal = 100;

        ctx.clearRect(0, 0, W, H);

        // Y-axis grid + labels
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(W - pad.right, y);
            ctx.stroke();
            const val = maxVal - ((maxVal - minVal) / 4) * i;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(val.toFixed(0) + '%', pad.left - 6, y + 3);
        }

        // X-axis labels (every nth so they don't overlap)
        const labelStep = Math.max(1, Math.floor(values.length / 7));
        ctx.textAlign = 'center';
        for (let i = 0; i < labels.length; i += labelStep) {
            const x = pad.left + (i / Math.max(1, values.length - 1)) * plotW;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText(labels[i], x, H - pad.bottom + 16);
        }

        const yOf = (v) => pad.top + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

        if (chartType === 'bar') {
            const slot = plotW / values.length;
            const barW = Math.max(2, Math.min(28, slot * 0.7));
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                const cx = pad.left + slot * i + slot / 2;
                const y = yOf(v);
                const color = v >= 95 ? '#10b981' : v >= 80 ? '#f59e0b' : '#ef4444';
                ctx.fillStyle = color;
                ctx.fillRect(cx - barW / 2, y, barW, pad.top + plotH - y);
            }
        } else {
            // Filled area + line
            const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
            gradient.addColorStop(0, 'rgba(16, 185, 129, 0.30)');
            gradient.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
            ctx.beginPath();
            ctx.moveTo(pad.left, H - pad.bottom);
            values.forEach((v, i) => {
                const x = pad.left + (i / Math.max(1, values.length - 1)) * plotW;
                ctx.lineTo(x, yOf(v));
            });
            ctx.lineTo(pad.left + plotW, H - pad.bottom);
            ctx.closePath();
            ctx.fillStyle = gradient;
            ctx.fill();

            ctx.beginPath();
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            values.forEach((v, i) => {
                const x = pad.left + (i / Math.max(1, values.length - 1)) * plotW;
                if (i === 0) ctx.moveTo(x, yOf(v));
                else ctx.lineTo(x, yOf(v));
            });
            ctx.stroke();

            // Dots
            values.forEach((v, i) => {
                const x = pad.left + (i / Math.max(1, values.length - 1)) * plotW;
                ctx.beginPath();
                ctx.arc(x, yOf(v), 3, 0, Math.PI * 2);
                ctx.fillStyle = '#10b981';
                ctx.fill();
                ctx.strokeStyle = isDark ? '#1e293b' : '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            });
        }
    }, [chartData, chartType, isDark]);

    const stats = useMemo(() => {
        const total = gauges.length;
        const online = gauges.filter(g => g.status === 'online').length;

        const maxBy = (key) => {
            let max = null;
            for (const g of gauges) {
                const v = Number(g[key]);
                if (!Number.isFinite(v)) continue;
                if (!max || v > Number(max[key])) max = g;
            }
            return max;
        };

        // Aggregate uptime/downtime across all gauges with real data in the
        // currently selected range. Mirrors the stations dashboard's "Avg
        // Uptime / Avg Downtime" tiles. Computed client-side from data we
        // already fetched — no extra API call.
        const withChecks = gauges.filter(g => g.checks_24h > 0 && g.uptime_24h !== null && g.uptime_24h !== undefined);
        const avgUptime = withChecks.length
            ? withChecks.reduce((a, g) => a + Number(g.uptime_24h), 0) / withChecks.length
            : null;

        return {
            total,
            online,
            offline: total - online,
            avgUptime: avgUptime !== null ? Number(avgUptime.toFixed(1)) : null,
            avgDowntime: avgUptime !== null ? Number((100 - avgUptime).toFixed(1)) : null,
            uptimeStationCount: withChecks.length,
            maxDaily:   maxBy('rain_daily'),
            maxWeekly:  maxBy('rain_7d'),
            maxMonthly: maxBy('rain_30d'),
            maxAnnual:  maxBy('rain_this_year'),
        };
    }, [gauges]);

    const filteredRows = useMemo(() => {
        const q = search.toLowerCase().trim();
        let rows = gauges.slice();
        if (statusFilter !== 'all') rows = rows.filter(g => g.status === statusFilter);
        if (q) rows = rows.filter(g => (g.name || '').toLowerCase().includes(q));
        return rows;
    }, [gauges, search, statusFilter]);

    const numericSorter = (key) => (a, b) => {
        const av = Number(a[key]); const bv = Number(b[key]);
        const an = Number.isFinite(av) ? av : -Infinity;
        const bn = Number.isFinite(bv) ? bv : -Infinity;
        return an - bn;
    };

    const subColor = isDark ? '#94a3b8' : '#64748b';
    const lastUpdatedText = lastUpdated
        ? `Last updated: ${new Date(lastUpdated).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}`
        : '';

    const maxCard = (title, color, gauge, key) => ({
        title,
        color,
        value: gauge ? `${Number(gauge[key]).toFixed(1)} mm` : '0.0 mm',
        sub: gauge ? gauge.name : '—',
    });

    const cardCfgs = [
        { title: '🌧️ Total Gauges', value: stats.total, color: '#0ea5e9', sub: 'DynaSys Network' },
        { title: '🟢 Online', value: stats.online, color: '#10b981', sub: 'Currently active' },
        { title: '🔴 Offline', value: stats.offline, color: '#ef4444', sub: 'Currently inactive' },
        {
            title: `📈 Avg Uptime (${range})`,
            value: stats.avgUptime !== null ? `${stats.avgUptime}%` : '—',
            color: '#10b981',
            sub: stats.uptimeStationCount ? `${stats.uptimeStationCount} gauges avg` : '—',
        },
        {
            title: `📉 Avg Downtime (${range})`,
            value: stats.avgDowntime !== null ? `${stats.avgDowntime}%` : '—',
            color: '#ef4444',
            sub: stats.uptimeStationCount ? `${stats.uptimeStationCount} gauges avg` : '—',
        },
        maxCard('💧 Daily Max Rainfall',   '#3b82f6', stats.maxDaily,   'rain_daily'),
        maxCard('💦 Weekly Max Rainfall',  '#06b6d4', stats.maxWeekly,  'rain_7d'),
        maxCard('☔ Monthly Max Rainfall', '#8b5cf6', stats.maxMonthly, 'rain_30d'),
        maxCard('🌊 Annual Max Rainfall',  '#f59e0b', stats.maxAnnual,  'rain_this_year'),
    ];

    // Reused for both Uptime 24h and Uptime 1h columns — same color thresholds as
    // the station table.
    const renderUptime = (value, checks) => {
        if (value === null || value === undefined || !checks) {
            return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        }
        const v = Number(value);
        const color = v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
        return (
            <Space size={6}>
                <Progress percent={Math.min(100, v)} size="small" strokeColor={color} showInfo={false} style={{ width: 60 }} />
                <Text style={{ color, fontWeight: 600, fontSize: 12 }}>{v.toFixed(1)}%</Text>
            </Space>
        );
    };

    const columns = [
        {
            title: 'Gauge Name',
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
        {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            align: 'center',
            width: 100,
            sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
            render: (s) => s === 'online'
                ? <Tag color="green" style={{ fontWeight: 600 }}>ONLINE</Tag>
                : <Tag color="red" style={{ fontWeight: 600 }}>OFFLINE</Tag>,
        },
        {
            title: `Uptime (${range})${loading ? ' …' : ''}`,
            dataIndex: 'uptime_24h',
            key: 'uptime_range',
            align: 'left',
            width: 140,
            sorter: (a, b) => (Number(a.uptime_24h) || -1) - (Number(b.uptime_24h) || -1),
            render: (v, row) => renderUptime(v, row.checks_24h),
        },
        {
            title: 'Uptime 1h',
            dataIndex: 'uptime_1h',
            key: 'uptime_1h',
            align: 'left',
            width: 140,
            sorter: (a, b) => (Number(a.uptime_1h) || -1) - (Number(b.uptime_1h) || -1),
            render: (v, row) => renderUptime(v, row.checks_1h),
        },
        { title: 'Today (mm)', dataIndex: 'rain_daily', key: 'rain_daily', align: 'right', width: 110, sorter: numericSorter('rain_daily'), render: (v) => <MmCell value={v} /> },
        { title: '24h (mm)', dataIndex: 'rain_24h', key: 'rain_24h', align: 'right', width: 100, sorter: numericSorter('rain_24h'), defaultSortOrder: 'descend', render: (v) => <MmCell value={v} /> },
        { title: '7 Days (mm)', dataIndex: 'rain_7d', key: 'rain_7d', align: 'right', width: 110, sorter: numericSorter('rain_7d'), render: (v) => <MmCell value={v} /> },
        { title: '30 Days (mm)', dataIndex: 'rain_30d', key: 'rain_30d', align: 'right', width: 120, sorter: numericSorter('rain_30d'), render: (v) => <MmCell value={v} /> },
        { title: 'This Year (mm)', dataIndex: 'rain_this_year', key: 'rain_this_year', align: 'right', width: 120, sorter: numericSorter('rain_this_year'), render: (v) => <MmCell value={v} /> },
        { title: 'All Time (mm)', dataIndex: 'rain_all_time', key: 'rain_all_time', align: 'right', width: 120, sorter: numericSorter('rain_all_time'), render: (v) => <MmCell value={v} /> },
    ];

    return (
        <div>
            {/* Sub-view toggle: Rain Gauges vs Weather Stations. The two have
                different shapes and live charts so we render them as separate
                components rather than trying to unify the table. */}
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12, marginBottom: 8 }}>
                <Radio.Group value={subView} onChange={(e) => setSubView(e.target.value)} buttonStyle="solid" size="middle">
                    {/* Counts come from the data, not the markup — they used to be
                        baked in as 87 and 3 and went stale as the network changed.
                        The station count is only known once that view has loaded,
                        so it shows a dash until then rather than a wrong number. */}
                    <Radio.Button value="rg">🌧️ Rain Gauges ({gauges.length})</Radio.Button>
                    <Radio.Button value="ws">🌤️ Weather Stations ({wsCount ?? '—'})</Radio.Button>
                </Radio.Group>
            </div>

            {subView === 'ws' && <WeatherStationsView isDark={isDark} onCount={setWsCount} />}
            {subView === 'rg' && (
                <>
            {/* Stat Cards */}
            <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
                {cardCfgs.map((c) => (
                    <Col xs={12} sm={12} md={8} lg={Math.floor(24 / cardCfgs.length)} key={c.title}>
                        <Card size="small" style={{ borderTop: `3px solid ${c.color}` }} styles={{ body: { padding: 12 } }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: subColor, textTransform: 'uppercase' }}>{c.title}</div>
                            <Statistic
                                value={c.value}
                                valueStyle={{ color: c.color, fontSize: 20, fontWeight: 700, fontFamily: "'Orbitron', 'Inter', sans-serif" }}
                            />
                            <div style={{ fontSize: 11, color: subColor, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {c.sub}
                            </div>
                        </Card>
                    </Col>
                ))}
            </Row>

            {/* Controls + Table */}
            <Card style={{ marginTop: 16 }} styles={{ body: { padding: 16 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
                    <Space size={12} wrap>
                        <h3 style={{ margin: 0, fontSize: 16 }}>🌧️ Rain Gauges Data</h3>
                        <span style={{ fontSize: 11, color: subColor }}>{lastUpdatedText}</span>
                    </Space>
                    <Space size={8} wrap>
                        <Input
                            prefix={<SearchOutlined />}
                            placeholder="Search gauge..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            allowClear
                            style={{ width: 200 }}
                        />
                        <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }} options={STATUS_OPTIONS} />
                        <Space size={6} align="center">
                            <Text strong style={{ fontSize: 13, color: subColor }}>Range:</Text>
                            <Select value={range} onChange={setRange} style={{ width: 110 }} options={RANGE_OPTIONS} />
                        </Space>
                        <Button
                            onClick={() => {
                                // 15-min raw rows for ALL gauges in the selected range.
                                window.location.href = `${RAIN_GAUGES_API_BASE}/api/rain-gauges-export?range=${range}`;
                            }}
                        >📥 Export CSV</Button>
                        <Button onClick={downloadAllPdf} title="One-page network report (all gauges)">📄 All Gauges PDF</Button>
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
                    </Space>
                </div>

                <Spin spinning={loading && gauges.length === 0}>
                    <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={filteredRows}
                        size="small"
                        pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ['10', '25', '50', '75', '100'] }}
                        scroll={{ x: 'max-content' }}
                        onRow={(record) => ({
                            onClick: () => openDetail(record),
                            style: { cursor: 'pointer' },
                        })}
                    />
                </Spin>
            </Card>

            {/* Gauge detail modal — shows all 5 uptime windows + chart + rain totals */}
            <Modal
                title={selectedGauge ? `🌧️  ${selectedGauge.name}` : 'Gauge Detail'}
                open={!!selectedGauge}
                onCancel={closeDetail}
                footer={<Button onClick={closeDetail}>Close</Button>}
                width={920}
            >
                {selectedGauge && (
                    <div>
                        <div style={{ marginBottom: 14, fontSize: 12, color: subColor }}>
                            <Text type="secondary">ID: {selectedGauge.id}</Text>
                            <span style={{ marginLeft: 12 }}>
                                {selectedGauge.status === 'online'
                                    ? <Tag color="green">ONLINE</Tag>
                                    : <Tag color="red">OFFLINE</Tag>}
                            </span>
                        </div>

                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: subColor }}>Uptime across all windows</div>
                        <Spin spinning={detailLoading}>
                            <Row gutter={[8, 8]}>
                                {['1h', '24h', '7d', '30d', '1y'].map(w => {
                                    const win = detail?.windows?.[w];
                                    const v = win?.uptime;
                                    const checks = win?.checks ?? 0;
                                    const color = v == null
                                        ? '#94a3b8'
                                        : v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
                                    return (
                                        <Col span={Math.floor(24 / 5)} key={w}>
                                            <Card size="small" style={{ borderTop: `3px solid ${color}` }} styles={{ body: { padding: 10, textAlign: 'center' } }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: subColor, textTransform: 'uppercase' }}>{w}</div>
                                                <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>
                                                    {v == null ? '—' : `${v.toFixed(1)}%`}
                                                </div>
                                                <div style={{ fontSize: 11, color: subColor }}>{checks} polls</div>
                                            </Card>
                                        </Col>
                                    );
                                })}
                            </Row>
                        </Spin>

                        {/* Uptime/downtime chart over time — bucketed by the selected range */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: subColor }}>
                                Uptime history
                                {chartData && (
                                    <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10,
                                        background: chartData.overall_uptime >= 95 ? 'rgba(16,185,129,0.15)' : chartData.overall_uptime >= 80 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                                        color: chartData.overall_uptime >= 95 ? '#10b981' : chartData.overall_uptime >= 80 ? '#f59e0b' : '#ef4444' }}>
                                        Avg: {chartData.overall_uptime}%
                                    </span>
                                )}
                            </div>
                            <Space size={6} wrap>
                                <Radio.Group size="small" value={chartType} onChange={e => setChartType(e.target.value)} buttonStyle="solid">
                                    <Radio.Button value="bar">Bar</Radio.Button>
                                    <Radio.Button value="line">Line</Radio.Button>
                                </Radio.Group>
                                <Radio.Group size="small" value={chartRange} onChange={e => setChartRange(e.target.value)} buttonStyle="solid">
                                    <Radio.Button value="24h">24h</Radio.Button>
                                    <Radio.Button value="daily">Daily</Radio.Button>
                                    <Radio.Button value="7d">7d</Radio.Button>
                                    <Radio.Button value="30d">30d</Radio.Button>
                                    <Radio.Button value="1y">1y</Radio.Button>
                                    <Radio.Button value="all">All</Radio.Button>
                                </Radio.Group>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        const url = `${RAIN_GAUGES_API_BASE}/api/rain-gauge-export/${encodeURIComponent(selectedGauge.id)}?range=${chartRange}`;
                                        window.location.href = url;
                                    }}
                                >📥 Export CSV</Button>
                                <Button
                                    size="small"
                                    onClick={downloadPdf}
                                >📄 Download PDF</Button>
                            </Space>
                        </div>
                        <Spin spinning={chartLoading}>
                            <div style={{ width: '100%', height: 200, position: 'relative' }}>
                                <canvas ref={chartCanvasRef} style={{ width: '100%', height: 200 }} />
                            </div>
                        </Spin>

                        <div style={{ fontWeight: 600, fontSize: 13, marginTop: 18, marginBottom: 8, color: subColor }}>Rain totals (live from upstream)</div>
                        <Row gutter={[8, 8]}>
                            {[
                                { label: 'Today',     key: 'rain_daily' },
                                { label: '24h',       key: 'rain_24h' },
                                { label: '7 days',    key: 'rain_7d' },
                                { label: '30 days',   key: 'rain_30d' },
                                { label: 'This year', key: 'rain_this_year' },
                                { label: 'All time',  key: 'rain_all_time' },
                            ].map(({ label, key }) => {
                                const { text, color } = formatMm(selectedGauge[key]);
                                return (
                                    <Col span={4} key={key}>
                                        <Card size="small" styles={{ body: { padding: 10, textAlign: 'center' } }}>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: subColor }}>{label}</div>
                                            <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2 }}>{text === '—' ? '—' : `${text} mm`}</div>
                                        </Card>
                                    </Col>
                                );
                            })}
                        </Row>

                        {detail?.last_online && (
                            <div style={{ marginTop: 14, fontSize: 12, color: subColor }}>
                                <Text type="secondary">
                                    Last seen online: {new Date(detail.last_online + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}
                                    {' · '}
                                    Tracked since: {detail.tracking_since ? new Date(detail.tracking_since + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : '—'}
                                    {' · '}
                                    {detail.total_rows} polls stored
                                </Text>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
                </>
            )}
        </div>
    );
}
