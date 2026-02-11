import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Tag, Radio, Spin } from 'antd';
import axios from 'axios';
import { API_BASE, CATEGORY_CONFIG } from '../utils/constants';

function formatDate(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '--';
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h < 24) return `${h}h ${m}m`;
    const days = Math.floor(h / 24);
    return `${days}d ${h % 24}h`;
}

export default function StationDetailModal({ station, onClose, isDark }) {
    const [interval, setInterval_] = useState('24h');
    const [historyData, setHistoryData] = useState(null);
    const [loading, setLoading] = useState(false);
    const uptimeCanvasRef = useRef(null);
    const tempCanvasRef = useRef(null);

    const fetchHistory = useCallback(async (stationId, range) => {
        setLoading(true);
        try {
            // Map UI interval to backend 'days' param (backend defaults to 24h if no param)
            const daysMap = { '24h': 1, '7d': 7, '30d': 30, '1y': 365 };
            const days = daysMap[range] || 1;
            const resp = await axios.get(`${API_BASE}/api/station-history/${stationId}?days=${days}`);
            if (resp.data && resp.data.success) {
                setHistoryData(resp.data);
            } else {
                setHistoryData(null);
            }
        } catch (e) {
            console.warn('Failed to fetch station history:', e.message);
            setHistoryData(null);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        if (station) {
            setInterval_('24h');
            fetchHistory(station.station_id, '24h');
        } else {
            setHistoryData(null);
        }
    }, [station, fetchHistory]);

    useEffect(() => {
        if (station) {
            fetchHistory(station.station_id, interval);
        }
    }, [interval, station, fetchHistory]);

    useEffect(() => {
        if (historyData) {
            drawUptimeChart();
            drawTempChart();
        }
    }, [historyData, isDark]);

    function drawUptimeChart() {
        const hourlyData = historyData?.hourly_data;
        if (!uptimeCanvasRef.current || !hourlyData || hourlyData.length === 0) return;

        const canvas = uptimeCanvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = 180 * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = '180px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = 180;
        const pad = { top: 15, right: 15, bottom: 30, left: 45 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        ctx.clearRect(0, 0, W, H);

        // Grid
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '9px Space Grotesk'; ctx.textAlign = 'right';
            ctx.fillText((100 - 25 * i) + '%', pad.left - 6, y + 3);
        }

        const values = hourlyData.map(h => h.uptime);
        const labels = hourlyData.map(h => h.period_label || h.period);
        const getX = (i) => pad.left + (i / Math.max(1, values.length - 1)) * plotW;
        const getY = (pct) => pad.top + plotH - (pct / 100) * plotH;

        // Gradient fill
        const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
        gradient.addColorStop(0, 'rgba(16,185,129,0.3)');
        gradient.addColorStop(1, 'rgba(16,185,129,0.02)');
        ctx.beginPath();
        ctx.moveTo(getX(0), H - pad.bottom);
        values.forEach((v, i) => ctx.lineTo(getX(i), getY(v)));
        ctx.lineTo(getX(values.length - 1), H - pad.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        values.forEach((v, i) => {
            const color = v >= 80 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
            if (i === 0) {
                ctx.strokeStyle = color;
                ctx.moveTo(getX(i), getY(v));
            } else {
                ctx.strokeStyle = color;
                ctx.lineTo(getX(i), getY(v));
            }
        });
        ctx.stroke();

        // Dots
        values.forEach((v, i) => {
            if (i % Math.max(1, Math.floor(values.length / 15)) !== 0 && i !== values.length - 1) return;
            ctx.beginPath();
            ctx.arc(getX(i), getY(v), 3, 0, Math.PI * 2);
            ctx.fillStyle = v >= 80 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
            ctx.fill();
            ctx.strokeStyle = isDark ? '#1e293b' : '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });

        // X-axis labels
        const step = Math.max(1, Math.floor(labels.length / 6));
        ctx.textAlign = 'center';
        for (let i = 0; i < labels.length; i += step) {
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '9px Space Grotesk';
            ctx.fillText(labels[i], getX(i), H - pad.bottom + 14);
        }
    }

    function drawTempChart() {
        const hourlyData = historyData?.hourly_data;
        if (!tempCanvasRef.current || !hourlyData) return;
        const temps = hourlyData.filter(h => h.avg_temperature !== null && h.avg_temperature !== undefined);
        if (temps.length === 0) return;

        const canvas = tempCanvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = 180 * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = '180px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = 180;
        const pad = { top: 15, right: 15, bottom: 30, left: 45 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        const values = temps.map(h => parseFloat(h.avg_temperature));
        const minT = Math.floor(Math.min(...values) - 2);
        const maxT = Math.ceil(Math.max(...values) + 2);
        const range = maxT - minT || 1;

        ctx.clearRect(0, 0, W, H);

        // Grid
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '9px Space Grotesk'; ctx.textAlign = 'right';
            ctx.fillText((maxT - (range / 4) * i).toFixed(0) + '°', pad.left - 6, y + 3);
        }

        const getX = (i) => pad.left + (i / Math.max(1, temps.length - 1)) * plotW;
        const getY = (v) => pad.top + plotH - ((v - minT) / range) * plotH;

        // Gradient fill
        const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
        gradient.addColorStop(0, 'rgba(245,158,11,0.3)');
        gradient.addColorStop(1, 'rgba(245,158,11,0.02)');
        ctx.beginPath();
        ctx.moveTo(getX(0), H - pad.bottom);
        values.forEach((v, i) => ctx.lineTo(getX(i), getY(v)));
        ctx.lineTo(getX(values.length - 1), H - pad.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        values.forEach((v, i) => { if (i === 0) ctx.moveTo(getX(i), getY(v)); else ctx.lineTo(getX(i), getY(v)); });
        ctx.stroke();

        // Dots
        values.forEach((v, i) => {
            if (i % Math.max(1, Math.floor(values.length / 15)) !== 0 && i !== values.length - 1) return;
            ctx.beginPath();
            ctx.arc(getX(i), getY(v), 3, 0, Math.PI * 2);
            ctx.fillStyle = '#f59e0b';
            ctx.fill();
            ctx.strokeStyle = isDark ? '#1e293b' : '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });

        // X-axis labels
        const labels = temps.map(h => h.period_label || h.period);
        const step = Math.max(1, Math.floor(labels.length / 6));
        ctx.textAlign = 'center';
        for (let i = 0; i < labels.length; i += step) {
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '9px Space Grotesk';
            ctx.fillText(labels[i], getX(i), H - pad.bottom + 14);
        }
    }

    if (!station) return null;

    const catConfig = CATEGORY_CONFIG[station.category] || {};
    const statusColor = station.status === 'Active' ? '#10b981' : station.status === 'Disabled' ? '#6b7280' : '#ef4444';
    const uptimeVal = historyData?.uptime?.percentage ?? station.uptime ?? 0;
    const uptimeColor = uptimeVal >= 90 ? '#10b981' : uptimeVal >= 50 ? '#f59e0b' : '#ef4444';
    const rangeLabel = interval === '24h' ? '24 Hours' : interval === '7d' ? '7 Days' : interval === '30d' ? '30 Days' : '1 Year';

    // Extract downtime data from API response
    const downtime = historyData?.downtime;
    const downtimeMinutes = downtime?.total_minutes ?? 0;
    const outages = downtime?.records ?? [];

    return (
        <Modal
            open={!!station}
            onCancel={onClose}
            footer={null}
            width={900}
            styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
            destroyOnClose
        >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{station.station_name}</h2>
                <Tag color={catConfig.color}>{catConfig.icon} {catConfig.name}</Tag>
                <span style={{ padding: '2px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: statusColor + '20', color: statusColor }}>
                    {station.status}
                </span>
                <div style={{ marginLeft: 'auto' }}>
                    <Radio.Group value={interval} onChange={(e) => setInterval_(e.target.value)} size="small" buttonStyle="solid">
                        <Radio.Button value="24h">24h</Radio.Button>
                        <Radio.Button value="7d">7d</Radio.Button>
                        <Radio.Button value="30d">30d</Radio.Button>
                        <Radio.Button value="1y">1y</Radio.Button>
                    </Radio.Group>
                </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                <div style={{ textAlign: 'center', padding: 16, background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>
                        Availability ({rangeLabel})
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: uptimeColor }}>
                        {uptimeVal.toFixed(1)}%
                    </div>
                </div>
                <div style={{ textAlign: 'center', padding: 16, background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Current Temp</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#f59e0b' }}>
                        {station.temperature !== null && station.temperature !== undefined ? `${station.temperature}°C` : historyData?.station?.temperature !== null ? `${historyData?.station?.temperature}°C` : '--'}
                    </div>
                </div>
                <div style={{ textAlign: 'center', padding: 16, background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Offline Time</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#ef4444' }}>
                        {downtimeMinutes > 0 ? formatDuration(downtimeMinutes) : '0m'}
                    </div>
                </div>
                <div style={{ textAlign: 'center', padding: 16, background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Outages</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#0ea5e9' }}>
                        {downtime?.incidents ?? outages.length}
                    </div>
                </div>
            </div>

            {/* Info row */}
            <div style={{ display: 'flex', gap: 24, padding: '12px 16px', background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 8, marginBottom: 20, fontSize: 13, color: isDark ? '#94a3b8' : '#64748b', flexWrap: 'wrap' }}>
                <span><strong>Station ID:</strong> {station.station_id}</span>
                <span><strong>Source:</strong> {station.api_source}</span>
                <span><strong>Province:</strong> {station.province || 'N/A'}</span>
                <span><strong>Total Checks:</strong> {historyData?.uptime?.total_checks ?? station.checks_24h ?? '--'}</span>
                {historyData?.tracking_since && <span><strong>Tracking Since:</strong> {new Date(historyData.tracking_since).toLocaleDateString()}</span>}
            </div>

            {/* Uptime History Chart */}
            <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                    Uptime History (Last {rangeLabel})
                </h3>
                <div style={{ background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, padding: 12 }}>
                    {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div> :
                        historyData?.hourly_data?.length > 0 ?
                            <canvas ref={uptimeCanvasRef} style={{ width: '100%', height: 180 }} /> :
                            <div style={{ textAlign: 'center', padding: 30, color: isDark ? '#64748b' : '#94a3b8' }}>No uptime data available</div>
                    }
                </div>
            </div>

            {/* Temperature History Chart */}
            <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                    Temperature History (Last {rangeLabel})
                </h3>
                <div style={{ background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, padding: 12 }}>
                    {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div> :
                        historyData?.hourly_data?.some(h => h.avg_temperature !== null) ?
                            <canvas ref={tempCanvasRef} style={{ width: '100%', height: 180 }} /> :
                            <div style={{ textAlign: 'center', padding: 30, color: isDark ? '#64748b' : '#94a3b8' }}>No temperature data available</div>
                    }
                </div>
            </div>

            {/* Recent Outages */}
            <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                    Recent Outages ({outages.length} recorded)
                </h3>
                <div style={{ background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, padding: 12, fontSize: 13, color: isDark ? '#94a3b8' : '#64748b' }}>
                    {outages.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 16 }}>No outages recorded</div>
                    ) : (
                        outages.slice(0, 10).map((o, i) => (
                            <div key={i} style={{
                                padding: '10px 12px',
                                borderBottom: i < Math.min(outages.length, 10) - 1 ? (isDark ? '1px solid #334155' : '1px solid #e2e8f0') : 'none',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                            }}>
                                <div>
                                    <span style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                                        {formatDate(o.start_time)} → {formatDate(o.end_time)}
                                    </span>
                                    <div style={{ fontSize: 10, color: isDark ? '#64748b' : '#94a3b8', marginTop: 2 }}>
                                        {o.status === 'resolved' ? '✅ Resolved' : '🔴 Ongoing'}
                                    </div>
                                </div>
                                <span style={{ color: '#ef4444', fontWeight: 600, fontSize: 14 }}>
                                    {formatDuration(o.duration_minutes)}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
