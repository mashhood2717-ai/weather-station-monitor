import React, { useMemo } from 'react';
import { Card, Typography } from 'antd';

const { Text } = Typography;

export default function StatusDistribution({ stats, isDark, displayTotal }) {
    const { online, offline, disabled, total } = stats;
    const totalDisplay = displayTotal ?? total;

    const segments = useMemo(() => {
        if (total === 0) return [];
        const onlinePct = (online / total) * 100;
        const offlinePct = (offline / total) * 100;
        const disabledPct = (disabled / total) * 100;
        return [
            { label: 'Online', value: online, pct: onlinePct, color: '#52c41a' },
            { label: 'Offline', value: offline, pct: offlinePct, color: '#ff4d4f' },
            { label: 'Disabled', value: disabled, pct: disabledPct, color: '#8c8c8c' },
        ];
    }, [online, offline, disabled, total]);

    // SVG donut chart params
    const size = 200;
    const strokeWidth = 28;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    let cumulativeOffset = 0;

    return (
        <Card
            title={<span style={{ fontWeight: 600, fontSize: 14 }}>Status Distribution</span>}
            size="small"
            styles={{ body: { padding: '12px 16px', textAlign: 'center' } }}
        >
            <div style={{ position: 'relative', display: 'inline-flex', justifyContent: 'center', alignItems: 'center' }}>
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
                {/* Background circle */}
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={isDark ? 'rgba(148,163,184,0.2)' : '#f0f0f0'}
                    strokeWidth={strokeWidth}
                />
                {/* Segments */}
                {segments.map((seg) => {
                    const dashLength = (seg.pct / 100) * circumference;
                    const offset = circumference - cumulativeOffset * (circumference / 100);
                    const gapOffset = circumference - dashLength;
                    cumulativeOffset += seg.pct;
                    return (
                        <circle
                            key={seg.label}
                            cx={size / 2}
                            cy={size / 2}
                            r={radius}
                            fill="none"
                            stroke={seg.color}
                            strokeWidth={strokeWidth}
                            strokeDasharray={`${dashLength} ${gapOffset}`}
                            strokeDashoffset={offset}
                            strokeLinecap="round"
                            style={{ transition: 'stroke-dasharray 1s ease, stroke-dashoffset 1s ease' }}
                        />
                    );
                })}
                </svg>
                <div style={{ position: 'absolute', textAlign: 'center' }}>
                    <div style={{ fontFamily: "'Orbitron', 'Inter', sans-serif", fontSize: 36, fontWeight: 800, color: isDark ? '#f8fafc' : '#1e293b' }}>
                        {totalDisplay}
                    </div>
                    <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', textTransform: 'uppercase', letterSpacing: 1 }}>
                        Stations
                    </div>
                </div>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                {segments.map((seg) => (
                    <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: seg.color,
                            display: 'inline-block',
                        }} />
                        <Text style={{ fontSize: 12 }}>
                            {seg.label} - {seg.pct.toFixed(0)}%
                        </Text>
                    </div>
                ))}
            </div>
        </Card>
    );
}
