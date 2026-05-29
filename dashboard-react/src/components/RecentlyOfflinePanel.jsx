import React, { useMemo, useState } from 'react';
import { Card, Segmented, Tag, List, Typography } from 'antd';

const { Text } = Typography;

function timeAgo(dateStr) {
    if (!dateStr) return 'Unknown';
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    if (diffMs < 0) return 'Just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ${hours % 24}h ago`;
    return `${days}d ago`;
}

function offlineDuration(dateStr) {
    if (!dateStr) return 'N/A';
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    if (diffMs < 0) return '0m';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

export default function RecentlyOfflinePanel({ stations, onStationClick }) {
    const [sourceFilter, setSourceFilter] = useState('all');

    const offlineStations = useMemo(() => {
        let offline = stations.filter(s => s.status === 'Inactive');
        if (sourceFilter !== 'all') {
            offline = offline.filter(s => {
                if (sourceFilter === 'WU') return s.category === 'wu';
                return (s.api_source || '').toLowerCase().includes(sourceFilter.toLowerCase());
            });
        }
        // Sort by last_seen (last time the station was confirmed online before going
        // offline) descending — matches dashboard/index.html line 5532-5539. Using
        // last_update would order by most-recently-polled, which is roughly identical
        // for all offline stations within a sync window and gives no real ordering.
        return offline.sort((a, b) => {
            const aTime = a.last_seen ? new Date(a.last_seen).getTime() : 0;
            const bTime = b.last_seen ? new Date(b.last_seen).getTime() : 0;
            return bTime - aTime;
        }).slice(0, 30);
    }, [stations, sourceFilter]);

    return (
        <Card
            title={(
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Recently Offline</span>
                    <Tag color="red">{offlineStations.length}</Tag>
                </div>
            )}
            size="small"
            styles={{ body: { padding: 0 } }}
        >
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
                <Segmented
                    size="small"
                    value={sourceFilter}
                    onChange={setSourceFilter}
                    options={['all', 'Davis', 'Misol', 'WU'].map(src => ({
                        value: src,
                        label: src === 'all' ? 'All' : src,
                    }))}
                />
            </div>
            <List
                dataSource={offlineStations}
                locale={{ emptyText: 'No offline stations' }}
                style={{ maxHeight: 220, overflow: 'auto' }}
                renderItem={(s) => {
                    const lastSeen = s.last_update || s.last_seen;
                    return (
                        <List.Item
                            onClick={() => onStationClick(s)}
                            style={{ cursor: 'pointer', padding: '10px 14px' }}
                        >
                            <div style={{ width: '100%' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {s.station_name}
                                        </div>
                                        <Text type="secondary" style={{ fontSize: 11 }}>
                                            {s.province || s.api_source} · ID: {s.station_id}
                                        </Text>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <Tag color="red">Offline</Tag>
                                        <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>
                                            {lastSeen ? offlineDuration(lastSeen) : 'N/A'}
                                        </div>
                                        <Text type="secondary" style={{ fontSize: 10 }}>
                                            {lastSeen ? timeAgo(lastSeen) : 'Never seen'}
                                        </Text>
                                    </div>
                                </div>
                            </div>
                        </List.Item>
                    );
                }}
            />
        </Card>
    );
}
