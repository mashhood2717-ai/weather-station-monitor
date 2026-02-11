import React from 'react';
import { Card, Statistic } from 'antd';

export default function StatCards({ stats, onFilterChange }) {
    const cards = [
        { title: 'Online', value: stats.online, emoji: '🟢', color: '#10b981', filter: 'online' },
        { title: 'Inactive', value: stats.offline, emoji: '🔴', color: '#ef4444', filter: 'offline' },
        { title: 'Disabled', value: stats.disabled, emoji: '⚫', color: '#6b7280', sub: 'Not monitored', filter: 'disabled' },
        { title: 'Avg Uptime', value: `${stats.upPercent}%`, emoji: '📈', color: '#10b981', sub: stats.uptimeStationCount ? `${stats.uptimeStationCount} stations avg` : 'All stations avg' },
        { title: 'Avg Downtime', value: `${stats.downPercent}%`, emoji: '📉', color: '#ef4444', sub: stats.uptimeStationCount ? `${stats.uptimeStationCount} stations avg` : 'All stations avg' },
    ];

    if (stats.hottest) {
        cards.push({ title: 'Max Temp', value: `${stats.hottest.temperature}°C`, emoji: '🌡️', color: '#f59e0b', sub: stats.hottest.station_name });
    } else {
        cards.push({ title: 'Max Temp', value: '--°C', emoji: '🌡️', color: '#f59e0b', sub: '--' });
    }

    if (stats.coldest) {
        cards.push({ title: 'Min Temp', value: `${stats.coldest.temperature}°C`, emoji: '❄️', color: '#06b6d4', sub: stats.coldest.station_name });
    } else {
        cards.push({ title: 'Min Temp', value: '--°C', emoji: '❄️', color: '#06b6d4', sub: '--' });
    }

    if (stats.wettest) {
        cards.push({ title: 'Max Rainfall', value: `${stats.wettest.rainfall} mm`, emoji: '🌧️', color: '#3b82f6', sub: stats.wettest.station_name });
    } else {
        cards.push({ title: 'Max Rainfall', value: '-- mm', emoji: '🌧️', color: '#3b82f6', sub: 'No rainfall' });
    }

    if (stats.windiest) {
        cards.push({ title: 'Max Wind Gust', value: `${stats.windiest.wind} km/h`, emoji: '💨', color: '#8b5cf6', sub: stats.windiest.station_name });
    } else {
        cards.push({ title: 'Max Wind Gust', value: '-- km/h', emoji: '💨', color: '#8b5cf6', sub: 'No wind data' });
    }

    return (
        <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 12, marginTop: 16 }}>
            {cards.map((c) => (
                <Card
                    key={c.title}
                    size="small"
                    hoverable={Boolean(c.filter)}
                    onClick={() => c.filter && onFilterChange(c.filter)}
                    style={{ minWidth: 0, borderTop: `3px solid ${c.color}` }}
                    styles={{ body: { padding: 12 } }}
                >
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                        {c.emoji} {c.title}
                    </div>
                    <Statistic value={c.value} valueStyle={{ color: c.color, fontSize: 20, fontWeight: 700, fontFamily: "'Orbitron', 'Space Grotesk', sans-serif" }} />
                    {c.sub && (
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c.sub}
                        </div>
                    )}
                </Card>
            ))}
        </div>
    );
}
