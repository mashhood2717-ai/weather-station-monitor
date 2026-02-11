import React, { useState, useMemo } from 'react';
import { Card, Input, Radio, List, Tag, Typography, Badge } from 'antd';
import { SearchOutlined, EnvironmentOutlined } from '@ant-design/icons';

const { Text } = Typography;

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
}

const statusColor = {
    Active: '#52c41a',
    Inactive: '#ff4d4f',
    Disabled: '#8c8c8c',
};

export default function StationList({ stations, statusFilter, onFilterChange, onStationClick }) {
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        let result = stations;

        // Status filter
        if (statusFilter === 'online') {
            result = result.filter((s) => s.status === 'Active');
        } else if (statusFilter === 'offline') {
            result = result.filter((s) => s.status === 'Inactive');
        } else if (statusFilter === 'disabled') {
            result = result.filter((s) => s.status === 'Disabled');
        }

        // Search filter
        if (search.trim()) {
            const q = search.toLowerCase();
            result = result.filter(
                (s) =>
                    (s.station_name && s.station_name.toLowerCase().includes(q)) ||
                    (s.station_id && s.station_id.toString().toLowerCase().includes(q)) ||
                    (s.location && s.location.toLowerCase().includes(q))
            );
        }

        // Sort by status (offline first) then by name
        return result.sort((a, b) => {
            const statusOrder = { Inactive: 0, Disabled: 1, Active: 2 };
            const diff = (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2);
            if (diff !== 0) return diff;
            return (a.station_name || '').localeCompare(b.station_name || '');
        });
    }, [stations, statusFilter, search]);

    return (
        <Card
            size="small"
            style={{ borderRadius: 12, height: 540, display: 'flex', flexDirection: 'column' }}
            styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' } }}
        >
            {/* Filter tabs */}
            <div style={{ padding: '10px 12px 0' }}>
                <Radio.Group
                    value={statusFilter}
                    onChange={(e) => onFilterChange(e.target.value)}
                    size="small"
                    buttonStyle="solid"
                    style={{ width: '100%', display: 'flex' }}
                >
                    <Radio.Button value="all" style={{ flex: 1, textAlign: 'center', fontSize: 12 }}>All</Radio.Button>
                    <Radio.Button value="online" style={{ flex: 1, textAlign: 'center', fontSize: 12 }}>Online</Radio.Button>
                    <Radio.Button value="offline" style={{ flex: 1, textAlign: 'center', fontSize: 12 }}>Offline</Radio.Button>
                    <Radio.Button value="disabled" style={{ flex: 1, textAlign: 'center', fontSize: 12 }}>Disabled</Radio.Button>
                </Radio.Group>

                <Input
                    prefix={<SearchOutlined />}
                    placeholder="Search station..."
                    size="small"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    allowClear
                    style={{ marginTop: 8 }}
                />
            </div>

            {/* Column headers */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 12px 4px',
                borderBottom: '1px solid #f0f0f0',
                fontSize: 11,
                color: '#8c8c8c',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
            }}>
                <span>Station</span>
                <span>Status</span>
            </div>

            {/* Station list */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <List
                    dataSource={filtered}
                    size="small"
                    renderItem={(station) => (
                        <List.Item
                            onClick={() => onStationClick(station)}
                            style={{
                                cursor: 'pointer',
                                padding: '8px 12px',
                                transition: 'background 0.2s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#fafafa'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <Text strong style={{ fontSize: 13, display: 'block' }} ellipsis>
                                    {station.station_name}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                    <EnvironmentOutlined style={{ marginRight: 2 }} />
                                    {station.location || station.station_id}
                                </Text>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                                <Tag
                                    color={statusColor[station.status] || '#8c8c8c'}
                                    style={{ marginRight: 0, fontSize: 11, borderRadius: 10, lineHeight: '18px' }}
                                >
                                    {station.status}
                                </Tag>
                                <div style={{ fontSize: 10, color: '#bfbfbf', marginTop: 2 }}>
                                    {timeAgo(station.last_update || station.last_seen)}
                                </div>
                            </div>
                        </List.Item>
                    )}
                />
            </div>
        </Card>
    );
}
