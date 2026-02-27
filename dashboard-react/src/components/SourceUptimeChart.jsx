import React, { useMemo, useRef, useEffect } from 'react';

const SOURCES = ['Davis', 'Misol', 'WU'];
const SOURCE_COLORS = { Davis: '#3b82f6', Misol: '#10b981', WU: '#f59e0b' };

export default function SourceUptimeChart({ stations, isDark }) {
    const canvasRef = useRef(null);

    const sourceData = useMemo(() => {
        return SOURCES.map(src => {
            const srcStations = stations.filter(s => {
                if (src === 'WU') return s.category === 'wu';
                return (s.api_source || '').toLowerCase().includes(src.toLowerCase());
            });
            const total = srcStations.length;
            const active = srcStations.filter(s => s.status === 'Active').length;
            const uptimes = srcStations
                .filter(s => s.checks_24h && s.checks_24h > 0)
                .map(s => parseFloat(s.uptime_24h !== undefined && s.uptime_24h !== null ? s.uptime_24h : s.uptime))
                .filter(v => !isNaN(v));
            const avgUptime = uptimes.length > 0 ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : 0;
            return { name: src, color: SOURCE_COLORS[src], total, active, avgUptime: Number(avgUptime.toFixed(1)) };
        });
    }, [stations]);

    useEffect(() => { drawChart(); }, [sourceData, isDark]);

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
        const n = sourceData.length;

        ctx.clearRect(0, 0, W, H);

        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Space Grotesk'; ctx.textAlign = 'right';
            ctx.fillText((100 - 25 * i) + '%', pad.left - 6, y + 3);
        }

        const barW = Math.min(50, plotW / n * 0.5);
        const gap = plotW / n;
        sourceData.forEach((d, i) => {
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
            ctx.font = 'bold 11px Space Grotesk'; ctx.textAlign = 'center';
            ctx.fillText(d.avgUptime + '%', x + barW / 2, y - 4);
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Space Grotesk';
            ctx.fillText(d.name, x + barW / 2, H - pad.bottom + 14);
            ctx.fillText(`(${d.active}/${d.total})`, x + barW / 2, H - pad.bottom + 25);
        });
    }

    const cardBg = isDark ? 'rgba(30, 41, 59, 0.8)' : '#fff';
    const border = isDark ? '1px solid #334155' : '1px solid #e2e8f0';

    return (
        <div style={{ background: cardBg, border, borderRadius: 16, padding: '20px', backdropFilter: 'blur(20px)', height: '100%' }}>
            <div style={{ marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#f1f5f9' : '#1e293b' }}>📡 Source Uptime</span>
            </div>
            <canvas ref={canvasRef} style={{ width: '100%', height: 200 }} />
        </div>
    );
}
