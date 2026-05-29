import React, { useState, useMemo, useEffect } from 'react';
import axios from 'axios';
import { Input, Select, Tag, Table, Progress, Space, Button, Typography, message } from 'antd';
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons';
import { CATEGORY_CONFIG, API_BASE } from '../utils/constants';

const { Text } = Typography;

const STATUS_OPTIONS = [
    { value: 'all', label: 'All Status' },
    { value: 'online', label: 'Active' },
    { value: 'offline', label: 'Inactive' },
    { value: 'disabled', label: 'Disabled' },
];

const CATEGORY_OPTIONS = [
    { value: 'all', label: 'All Categories' },
    ...Object.entries(CATEGORY_CONFIG).map(([k, v]) => ({ value: k, label: `${v.icon} ${v.name}` })),
];

const SOURCE_OPTIONS = [
    { value: 'all', label: 'All Sources' },
    { value: 'Davis', label: 'Davis' },
    { value: 'Misol', label: 'Misol' },
    { value: 'WU', label: 'WU' },
];

const RANGE_OPTIONS = [
    { value: '24h', label: '24h' },
    { value: 'daily', label: 'Daily' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '1y', label: '1y' },
];

function getUptimeValue(station, rangeUptimes) {
    // Range-specific override takes priority (matches legacy: GET /api/uptime-percentages?range=X)
    const override = rangeUptimes?.[String(station.station_id)];
    if (override !== undefined && override !== null) return parseFloat(override);
    if (station.uptime_24h !== undefined && station.uptime_24h !== null) {
        return parseFloat(station.uptime_24h);
    }
    if (station.uptime !== undefined && station.uptime !== null) {
        return parseFloat(station.uptime);
    }
    return 0;
}

export default function StationTable({ stations, statusFilter, categoryFilter, onFilterChange, onCategoryChange, onStationClick }) {
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [range, setRange] = useState('24h');
    const [rangeUptimes, setRangeUptimes] = useState(null);
    const [rangeLoading, setRangeLoading] = useState(false);

    // When the user picks 7d / 30d / 1y / daily, fetch range-specific uptime from the
    // Worker (mirrors dashboard/index.html loadUptimeData at line ~4347). On 24h we
    // already have the values via /api/uptime-percentages in useStations() — clear
    // the override so the existing column data is used directly.
    useEffect(() => {
        let cancelled = false;
        if (range === '24h') {
            setRangeUptimes(null);
            return;
        }
        setRangeLoading(true);
        axios.get(`${API_BASE}/api/uptime-percentages?range=${range}`)
            .then(resp => {
                if (cancelled) return;
                const map = {};
                (resp.data?.uptime_data || []).forEach(u => { map[String(u.station_id)] = u.uptime_24h; });
                setRangeUptimes(map);
            })
            .catch(e => { if (!cancelled) message.error('Failed to load uptime for ' + range); })
            .finally(() => { if (!cancelled) setRangeLoading(false); });
        return () => { cancelled = true; };
    }, [range]);

    const filtered = useMemo(() => {
        let result = stations;
        if (statusFilter === 'online') result = result.filter(s => s.status === 'Active');
        else if (statusFilter === 'offline') result = result.filter(s => s.status === 'Inactive');
        else if (statusFilter === 'disabled') result = result.filter(s => s.status === 'Disabled');
        if (categoryFilter !== 'all') result = result.filter(s => s.category === categoryFilter);
        if (sourceFilter !== 'all') {
            result = result.filter(s => {
                if (sourceFilter === 'WU') return s.category === 'wu';
                return (s.api_source || '').toLowerCase().includes(sourceFilter.toLowerCase());
            });
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            result = result.filter(s =>
                (s.station_name || '').toLowerCase().includes(q) ||
                String(s.station_id).toLowerCase().includes(q) ||
                (s.location || '').toLowerCase().includes(q)
            );
        }
        return result;
    }, [stations, statusFilter, categoryFilter, sourceFilter, search]);

    function handleExport(format) {
        if (format === 'csv') {
            const rows = [['Station', 'Source', 'Status', 'Temp', 'Rain', `Uptime % (${range})`, 'Province']];
            filtered.forEach(s => rows.push([
                s.station_name,
                s.api_source,
                s.status,
                s.temperature ?? '',
                s.rainfall ?? '',
                getUptimeValue(s, rangeUptimes).toFixed(1),
                s.province,
            ]));
            const csv = rows.map(r => r.join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'stations.csv';
            a.click();
        }
    }

    const columns = [
        {
            title: 'Station',
            dataIndex: 'station_name',
            key: 'station_name',
            sorter: (a, b) => (a.station_name || '').localeCompare(b.station_name || ''),
            render: (_, record) => (
                <div>
                    <div style={{ fontWeight: 600 }}>{record.station_name}</div>
                    <Text type="secondary" style={{ fontSize: 11 }}>ID: {record.station_id}</Text>
                </div>
            ),
        },
        {
            title: 'Source',
            dataIndex: 'api_source',
            key: 'api_source',
            sorter: (a, b) => (a.api_source || '').localeCompare(b.api_source || ''),
            render: (value) => <Tag>{value || 'N/A'}</Tag>,
        },
        {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
            render: (value) => {
                const color = value === 'Active' ? 'green' : value === 'Disabled' ? 'default' : 'red';
                return <Tag color={color}>{value}</Tag>;
            },
        },
        {
            title: 'Temp',
            dataIndex: 'temperature',
            key: 'temperature',
            sorter: (a, b) => (a.temperature ?? -999) - (b.temperature ?? -999),
            render: (value) => value !== null && value !== undefined ? `${value}°C` : '--',
        },
        {
            title: 'Rain',
            dataIndex: 'rainfall',
            key: 'rainfall',
            sorter: (a, b) => (a.rainfall ?? -1) - (b.rainfall ?? -1),
            render: (value) => value !== null && value !== undefined ? `${value} mm` : '--',
        },
        {
            title: `Availability (${range})${rangeLoading ? ' …' : ''}`,
            dataIndex: 'uptime',
            key: 'uptime',
            sorter: (a, b) => getUptimeValue(a, rangeUptimes) - getUptimeValue(b, rangeUptimes),
            render: (_, record) => {
                const value = getUptimeValue(record, rangeUptimes);
                const color = value >= 90 ? '#10b981' : value >= 50 ? '#f59e0b' : '#ef4444';
                return (
                    <Space size={8}>
                        <Progress percent={Math.min(100, value)} size="small" strokeColor={color} showInfo={false} />
                        <Text style={{ color, fontWeight: 600 }}>{value.toFixed(1)}%</Text>
                    </Space>
                );
            },
        },
        {
            title: 'Province',
            dataIndex: 'province',
            key: 'province',
            sorter: (a, b) => (a.province || '').localeCompare(b.province || ''),
            render: (value) => value || '--',
        },
    ];

    return (
        <div>
            <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginRight: 'auto' }}>All Stations</div>
                <Input
                    prefix={<SearchOutlined />}
                    placeholder="Search stations..."
                    size="small"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    allowClear
                    style={{ width: 220 }}
                />
                <Select size="small" value={categoryFilter} onChange={onCategoryChange} options={CATEGORY_OPTIONS} style={{ width: 160 }} />
                <Select size="small" value={sourceFilter} onChange={setSourceFilter} options={SOURCE_OPTIONS} style={{ width: 120 }} />
                <Select size="small" value={statusFilter} onChange={onFilterChange} options={STATUS_OPTIONS} style={{ width: 130 }} />
                <Select size="small" value={range} onChange={setRange} options={RANGE_OPTIONS} style={{ width: 90 }} />
                <Button icon={<DownloadOutlined />} onClick={() => handleExport('csv')} size="small">
                    Export CSV
                </Button>
            </div>

            <Table
                rowKey="station_id"
                dataSource={filtered}
                columns={columns}
                size="small"
                pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '200', '500'] }}
                scroll={{ x: 900, y: 520 }}
                onRow={(record) => ({
                    onClick: () => onStationClick(record),
                })}
            />
        </div>
    );
}
