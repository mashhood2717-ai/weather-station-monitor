import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Card, Segmented, Radio, Select } from 'antd';
import { CATEGORY_CONFIG, CATEGORY_LIST, PROVINCE_CONFIG, PROVINCE_LIST } from '../utils/constants';

const SOURCE_LIST = ['Davis', 'Misol', 'WU'];
const SOURCE_COLORS = { Davis: '#3b82f6', Misol: '#10b981', WU: '#f59e0b' };

function getUptimeValue(station) {
    if (station.uptime_24h !== undefined && station.uptime_24h !== null) {
        return parseFloat(station.uptime_24h);
    }
    if (station.uptime !== undefined && station.uptime !== null) {
        return parseFloat(station.uptime);
    }
    return NaN;
}

export default function AvailabilitySummaryChart({ stations, isDark }) {
    const [groupBy, setGroupBy] = useState('category');
    const [chartType, setChartType] = useState('bar');
    const [networkFilter, setNetworkFilter] = useState('all');
    const canvasRef = useRef(null);

    const filteredStations = useMemo(() => {
        if (networkFilter === 'wu') {
            return stations.filter(s => s.category === 'wu');
        }
        if (networkFilter === 'ww') {
            return stations.filter(s => s.category !== 'wu');
        }
        return stations;
    }, [stations, networkFilter]);

    // Match legacy dashboard/index.html (line ~3347): only average stations that
    // actually had checks in the last 24h. Stations with checks_24h=0 carry stale
    // fallback uptime values and would skew the category averages downward.
    const avgUptimeFor = (list) => {
        const uptimes = list
            .filter(s => s.checks_24h && s.checks_24h > 0)
            .map(getUptimeValue)
            .filter(v => !isNaN(v));
        return uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : 0;
    };

    const data = useMemo(() => {
        if (groupBy === 'category') {
            return CATEGORY_LIST.map(cat => {
                const config = CATEGORY_CONFIG[cat];
                const list = filteredStations.filter(s => s.category === cat);
                return {
                    key: cat,
                    name: config.name,
                    color: config.color,
                    total: list.length,
                    active: list.filter(s => s.status === 'Active').length,
                    avgUptime: Number(avgUptimeFor(list).toFixed(1)),
                };
            });
        }

        if (groupBy === 'province') {
            return PROVINCE_LIST.map(prov => {
                const list = filteredStations.filter(s => s.province === prov);
                return {
                    key: prov,
                    name: prov,
                    color: PROVINCE_CONFIG[prov]?.color || '#8c8c8c',
                    total: list.length,
                    active: list.filter(s => s.status === 'Active').length,
                    avgUptime: Number(avgUptimeFor(list).toFixed(1)),
                };
            });
        }

        return SOURCE_LIST.map(src => {
            const list = filteredStations.filter(s => {
                if (src === 'WU') return s.category === 'wu';
                return (s.api_source || '').toLowerCase().includes(src.toLowerCase());
            });
            return {
                key: src,
                name: src,
                color: SOURCE_COLORS[src] || '#8c8c8c',
                total: list.length,
                active: list.filter(s => s.status === 'Active').length,
                avgUptime: Number(avgUptimeFor(list).toFixed(1)),
            };
        });
    }, [filteredStations, groupBy]);

    useEffect(() => {
        drawChart();
    }, [data, chartType, isDark]);

    function drawChart() {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const height = 220;

        canvas.width = rect.width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = height + 'px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = height;
        const pad = { top: 20, right: 20, bottom: 40, left: 50 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;
        const n = data.length || 1;

        ctx.clearRect(0, 0, W, H);

        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(W - pad.right, y);
            ctx.stroke();
            const val = 100 - 25 * i;
            ctx.fillStyle = isDark ? '#cbd5e1' : '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(val + '%', pad.left - 8, y + 3);
        }

        if (chartType === 'bar') {
            const barW = Math.min(40, plotW / n * 0.55);
            const gap = plotW / n;
            data.forEach((d, i) => {
                const x = pad.left + gap * i + gap / 2 - barW / 2;
                const barH = (d.avgUptime / 100) * plotH;
                const y = pad.top + plotH - barH;
                ctx.fillStyle = d.color + 'cc';
                ctx.beginPath();
                const r = 5;
                ctx.moveTo(x + r, y);
                ctx.lineTo(x + barW - r, y);
                ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
                ctx.lineTo(x + barW, pad.top + plotH);
                ctx.lineTo(x, pad.top + plotH);
                ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y);
                ctx.fill();
                ctx.fillStyle = isDark ? '#f8fafc' : '#1e293b';
                ctx.font = '11px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(d.avgUptime + '%', x + barW / 2, y - 6);
                ctx.fillStyle = isDark ? '#cbd5e1' : '#64748b';
                ctx.font = '10px Inter, sans-serif';
                ctx.fillText(d.name, x + barW / 2, H - pad.bottom + 16);
                ctx.fillText(`(${d.active}/${d.total})`, x + barW / 2, H - pad.bottom + 28);
            });
            return;
        }

        const gap = plotW / Math.max(1, n - 1);
        ctx.beginPath();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        data.forEach((d, i) => {
            const x = pad.left + gap * i;
            const y = pad.top + plotH - (d.avgUptime / 100) * plotH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        data.forEach((d, i) => {
            const x = pad.left + gap * i;
            const y = pad.top + plotH - (d.avgUptime / 100) * plotH;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = d.color;
            ctx.fill();
            ctx.strokeStyle = isDark ? '#0f172a' : '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = isDark ? '#f8fafc' : '#1e293b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(d.avgUptime + '%', x, y - 10);
            ctx.fillStyle = isDark ? '#cbd5e1' : '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText(d.name, x, H - pad.bottom + 16);
        });
    }

    return (
        <Card
            title={<span>Availability Summary <span style={{ fontSize: 11, fontWeight: 400, color: isDark ? '#94a3b8' : '#64748b', marginLeft: 6 }}>— 24h average</span></span>}
            size="small"
            styles={{ body: { padding: 16 } }}
            extra={(
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Select
                        size="small"
                        value={networkFilter}
                        onChange={setNetworkFilter}
                        options={[
                            { value: 'all', label: 'All Networks' },
                            { value: 'ww', label: 'WeatherWalay' },
                            { value: 'wu', label: 'Weather Underground' },
                        ]}
                        style={{ width: 150 }}
                    />
                    <Radio.Group
                        size="small"
                        value={chartType}
                        onChange={(e) => setChartType(e.target.value)}
                        buttonStyle="solid"
                    >
                        <Radio.Button value="bar">Bar</Radio.Button>
                        <Radio.Button value="line">Line</Radio.Button>
                    </Radio.Group>
                </div>
            )}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Segmented
                    size="small"
                    value={groupBy}
                    onChange={setGroupBy}
                    options={[
                        { label: 'Category', value: 'category' },
                        { label: 'Source', value: 'source' },
                        { label: 'Province', value: 'province' },
                    ]}
                />
            </div>
            <canvas ref={canvasRef} style={{ width: '100%', height: 220 }} />
        </Card>
    );
}
