import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Radio } from 'antd';
import { CATEGORY_CONFIG, CATEGORY_LIST } from '../utils/constants';

export default function CategoryUptimeChart({ stations, isDark }) {
    const [chartType, setChartType] = useState('bar');
    const canvasRef = useRef(null);

    const categoryData = useMemo(() => {
        return CATEGORY_LIST.map(cat => {
            const config = CATEGORY_CONFIG[cat];
            const catStations = stations.filter(s => s.category === cat);
            const total = catStations.length;
            const active = catStations.filter(s => s.status === 'Active').length;
            const uptimes = catStations
                .filter(s => s.checks_24h && s.checks_24h > 0)
                .map(s => {
                    const val = s.uptime_24h !== undefined && s.uptime_24h !== null ? s.uptime_24h : s.uptime;
                    return val !== undefined && val !== null ? parseFloat(val) : NaN;
                })
                .filter(v => !isNaN(v));
            const avgUptime = uptimes.length > 0 ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : 0;
            return { key: cat, name: config.name, icon: config.icon, color: config.color, total, active, avgUptime: Number(avgUptime.toFixed(1)) };
        });
    }, [stations]);

    useEffect(() => { drawChart(); }, [categoryData, chartType, isDark]);

    function drawChart() {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = 200 * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = '200px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = 200;
        const pad = { top: 15, right: 15, bottom: 35, left: 45 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;
        const n = categoryData.length;

        ctx.clearRect(0, 0, W, H);

        // Grid
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            const val = 100 - 25 * i;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Space Grotesk';
            ctx.textAlign = 'right';
            ctx.fillText(val + '%', pad.left - 6, y + 3);
        }

        if (chartType === 'bar') {
            const barW = Math.min(36, plotW / n * 0.6);
            const gap = plotW / n;
            categoryData.forEach((d, i) => {
                const x = pad.left + gap * i + gap / 2 - barW / 2;
                const barH = (d.avgUptime / 100) * plotH;
                const y = pad.top + plotH - barH;
                // Bar
                ctx.fillStyle = d.color;
                ctx.beginPath();
                const r = 4;
                ctx.moveTo(x + r, y); ctx.lineTo(x + barW - r, y); ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
                ctx.lineTo(x + barW, pad.top + plotH); ctx.lineTo(x, pad.top + plotH); ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y); ctx.fill();
                // Value on top
                ctx.fillStyle = isDark ? '#f1f5f9' : '#1e293b';
                ctx.font = 'bold 11px Space Grotesk';
                ctx.textAlign = 'center';
                ctx.fillText(d.avgUptime + '%', x + barW / 2, y - 4);
                // Label
                ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
                ctx.font = '9px Space Grotesk';
                ctx.fillText(d.name, x + barW / 2, H - pad.bottom + 14);
                ctx.fillText(`(${d.active}/${d.total})`, x + barW / 2, H - pad.bottom + 25);
            });
        } else {
            // Line chart
            const gap = plotW / (n - 1);
            ctx.beginPath();
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            categoryData.forEach((d, i) => {
                const x = pad.left + gap * i;
                const y = pad.top + plotH - (d.avgUptime / 100) * plotH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
            // Points + labels
            categoryData.forEach((d, i) => {
                const x = pad.left + gap * i;
                const y = pad.top + plotH - (d.avgUptime / 100) * plotH;
                ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = d.color; ctx.fill();
                ctx.strokeStyle = isDark ? '#1e293b' : '#fff'; ctx.lineWidth = 2; ctx.stroke();
                ctx.fillStyle = isDark ? '#f1f5f9' : '#1e293b';
                ctx.font = '10px Space Grotesk'; ctx.textAlign = 'center';
                ctx.fillText(d.avgUptime + '%', x, y - 10);
                ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
                ctx.font = '9px Space Grotesk';
                ctx.fillText(d.name, x, H - pad.bottom + 14);
            });
        }
    }

    const cardBg = isDark ? 'rgba(30, 41, 59, 0.8)' : '#fff';
    const border = isDark ? '1px solid #334155' : '1px solid #e2e8f0';

    return (
        <div style={{ background: cardBg, border, borderRadius: 16, padding: '20px', backdropFilter: 'blur(20px)', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#f1f5f9' : '#1e293b' }}>📊 Category Uptime</span>
                <Radio.Group value={chartType} onChange={(e) => setChartType(e.target.value)} size="small">
                    <Radio.Button value="bar">Bar</Radio.Button>
                    <Radio.Button value="line">Line</Radio.Button>
                </Radio.Group>
            </div>
            <canvas ref={canvasRef} style={{ width: '100%', height: 200 }} />
        </div>
    );
}
