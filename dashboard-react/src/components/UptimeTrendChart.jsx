import React, { useState, useEffect, useRef } from 'react';
import { Card, Radio } from 'antd';
import axios from 'axios';
import { API_BASE } from '../utils/constants';

export default function UptimeTrendChart({ isDark }) {
    const [range, setRange] = useState('24h');
    const [data, setData] = useState(null);
    const canvasRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        async function fetchTrend() {
            try {
                const resp = await axios.get(`${API_BASE}/api/uptime-trend-chart?range=${range}`);
                if (resp.data && resp.data.success) {
                    setData(resp.data);
                }
            } catch (e) {
                console.warn('Failed to fetch uptime trend:', e.message);
            }
        }
        fetchTrend();
    }, [range]);

    useEffect(() => {
        if (!data || !canvasRef.current) return;
        // Lazy import chart.js via CDN is already in HTML, use simple canvas drawing
        drawChart();
    }, [data, isDark]);

    function drawChart() {
        if (!data || !data.trend || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = 220 * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = '220px';
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = 220;
        const pad = { top: 20, right: 20, bottom: 40, left: 50 };

        // Process data
        let labels = [];
        let values = [];
        const trend = data.trend;

        if (data.granularity === 'hourly') {
            if (range === '24h') {
                labels = trend.map(item => {
                    // Convert UTC to PKT (UTC+5)
                    const d = new Date(item.period);
                    const pktDate = new Date(d.getTime() + 5 * 60 * 60 * 1000);
                    return pktDate.toISOString().substring(11, 16);
                });
                values = trend.map(item => item.uptime_pct);
            } else if (range === 'daily') {
                // Show hourly data for TODAY only (from 12 AM PKT to now)
                const nowPKT = new Date(new Date().getTime() + 5 * 60 * 60 * 1000);
                const todayStr = nowPKT.toISOString().substring(0, 10); // YYYY-MM-DD in PKT

                const todayHourly = trend.filter(item => {
                    const d = new Date(item.period);
                    const pktDate = new Date(d.getTime() + 5 * 60 * 60 * 1000);
                    return pktDate.toISOString().startsWith(todayStr); // Only today's hours
                });

                labels = todayHourly.map(item => {
                    const d = new Date(item.period);
                    const pktDate = new Date(d.getTime() + 5 * 60 * 60 * 1000);
                    return pktDate.toISOString().substring(11, 16);
                });
                values = todayHourly.map(item => item.uptime_pct);
            } else {
                const dailyData = {};
                trend.forEach(item => {
                    const day = item.period.split(' ')[0];
                    if (!dailyData[day]) dailyData[day] = { sum: 0, count: 0 };
                    dailyData[day].sum += item.uptime_pct;
                    dailyData[day].count++;
                });
                const days = Object.keys(dailyData).sort();
                labels = days.map(d => {
                    const date = new Date(d);
                    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                });
                values = days.map(day => parseFloat((dailyData[day].sum / dailyData[day].count).toFixed(1)));
            }
        } else if (data.granularity === 'daily') {
            labels = trend.map(item => {
                const date = new Date(item.period);
                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
            values = trend.map(item => item.uptime_pct);
        } else if (data.granularity === 'weekly') {
            labels = trend.map(item => {
                const parts = item.period.split('-');
                return `W${parts[1]}`;
            });
            values = trend.map(item => item.uptime_pct);
        }

        if (values.length === 0) return;

        const minVal = Math.max(0, Math.min(...values) - 5);
        const maxVal = 100;
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        ctx.clearRect(0, 0, W, H);

        // Grid lines
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (plotH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(W - pad.right, y);
            ctx.stroke();
            // Y-axis label
            const val = maxVal - ((maxVal - minVal) / 4) * i;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Space Grotesk, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(val.toFixed(0) + '%', pad.left - 8, y + 3);
        }

        // X-axis labels (show every nth)
        const step = Math.max(1, Math.floor(labels.length / 8));
        ctx.textAlign = 'center';
        for (let i = 0; i < labels.length; i += step) {
            const x = pad.left + (i / (labels.length - 1)) * plotW;
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = '10px Space Grotesk, sans-serif';
            ctx.fillText(labels[i], x, H - pad.bottom + 18);
        }

        // Line + gradient fill
        const getX = (i) => pad.left + (i / (values.length - 1)) * plotW;
        const getY = (v) => pad.top + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

        // Fill gradient
        const gradient = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
        ctx.beginPath();
        ctx.moveTo(getX(0), H - pad.bottom);
        for (let i = 0; i < values.length; i++) {
            ctx.lineTo(getX(i), getY(values[i]));
        }
        ctx.lineTo(getX(values.length - 1), H - pad.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        for (let i = 0; i < values.length; i++) {
            if (i === 0) ctx.moveTo(getX(i), getY(values[i]));
            else ctx.lineTo(getX(i), getY(values[i]));
        }
        ctx.stroke();

        // Dots
        for (let i = 0; i < values.length; i += Math.max(1, Math.floor(values.length / 20))) {
            ctx.beginPath();
            ctx.arc(getX(i), getY(values[i]), 3, 0, Math.PI * 2);
            ctx.fillStyle = '#10b981';
            ctx.fill();
            ctx.strokeStyle = isDark ? '#1e293b' : '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
    }

    return (
        <Card
            title={(
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span>Uptime Trend</span>
                    {data && (
                        <span style={{
                            padding: '2px 10px',
                            borderRadius: 12,
                            fontSize: 12,
                            fontWeight: 600,
                            background: data.overall_uptime >= 95 ? 'rgba(16,185,129,0.15)' : data.overall_uptime >= 80 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                            color: data.overall_uptime >= 95 ? '#10b981' : data.overall_uptime >= 80 ? '#f59e0b' : '#ef4444',
                        }}>
                            Avg: {data.overall_uptime}%
                        </span>
                    )}
                </div>
            )}
            size="small"
            extra={(
                <Radio.Group value={range} onChange={(e) => setRange(e.target.value)} size="small" buttonStyle="solid">
                    <Radio.Button value="24h">24h</Radio.Button>
                    <Radio.Button value="daily">Daily</Radio.Button>
                    <Radio.Button value="7d">7d</Radio.Button>
                    <Radio.Button value="30d">30d</Radio.Button>
                    <Radio.Button value="1y">1y</Radio.Button>
                </Radio.Group>
            )}
            styles={{ body: { padding: 16 } }}
        >
            <canvas ref={canvasRef} style={{ width: '100%', height: 220 }} />
        </Card>
    );
}
