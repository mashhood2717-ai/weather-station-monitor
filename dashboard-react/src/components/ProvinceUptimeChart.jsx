import React, { useMemo, useRef, useEffect } from 'react';
import { PROVINCE_LIST, PROVINCE_CONFIG } from '../utils/constants';

export default function ProvinceUptimeChart({ stations, isDark }) {
    const canvasRef = useRef(null);

    const provinceData = useMemo(() => {
        return PROVINCE_LIST.map(prov => {
            const provStations = stations.filter(s => s.province === prov);
            const total = provStations.length;
            const active = provStations.filter(s => s.status === 'Active').length;
            const uptimes = provStations
                .filter(s => s.checks_24h && s.checks_24h > 0)
                .map(s => parseFloat(s.uptime_24h !== undefined && s.uptime_24h !== null ? s.uptime_24h : s.uptime))
                .filter(v => !isNaN(v));
            const avgUptime = uptimes.length > 0 ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : 0;
            return { name: prov, color: PROVINCE_CONFIG[prov]?.color || '#8c8c8c', total, active, avgUptime: Number(avgUptime.toFixed(1)) };
        });
    }, [stations]);

    useEffect(() => { drawChart(); }, [provinceData, isDark]);

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

        const W = rect.width; const H = 200;
        const pad = { top: 15, right: 15, bottom: 35, left: 45 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;
        const n = provinceData.length;

        ctx.clearRect(0, 0, W, H);

        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Inter'; ctx.textAlign = 'right';
            ctx.fillText((100 - 25 * i) + '%', pad.left - 6, y + 3);
        }

        const barW = Math.min(30, plotW / n * 0.6);
        const gap = plotW / n;
        provinceData.forEach((d, i) => {
            const x = pad.left + gap * i + gap / 2 - barW / 2;
            const barH = (d.avgUptime / 100) * plotH;
            const y = pad.top + plotH - barH;
            ctx.fillStyle = d.color;
            ctx.beginPath();
            const r = 4;
            ctx.moveTo(x + r, y); ctx.lineTo(x + barW - r, y); ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
            ctx.lineTo(x + barW, pad.top + plotH); ctx.lineTo(x, pad.top + plotH); ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y); ctx.fill();
            ctx.fillStyle = isDark ? '#f1f5f9' : '#1e293b';
            ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
            ctx.fillText(d.avgUptime + '%', x + barW / 2, y - 4);
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '9px Inter';
            ctx.fillText(d.name, x + barW / 2, H - pad.bottom + 14);
            ctx.fillText(`(${d.active}/${d.total})`, x + barW / 2, H - pad.bottom + 25);
        });
    }

    const cardBg = isDark ? 'rgba(30, 41, 59, 0.8)' : '#fff';
    const border = isDark ? '1px solid #334155' : '1px solid #e2e8f0';

    return (
        <div style={{ background: cardBg, border, borderRadius: 16, padding: '20px', backdropFilter: 'blur(20px)', height: '100%' }}>
            <div style={{ marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#f1f5f9' : '#1e293b' }}>🗺️ Province Uptime</span>
            </div>
            <canvas ref={canvasRef} style={{ width: '100%', height: 200 }} />
        </div>
    );
}
