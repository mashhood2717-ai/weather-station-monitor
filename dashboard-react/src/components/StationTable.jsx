import React, { useState, useMemo } from 'react';
import { Input, Select, Tag, Table, Progress, Space, Button, Typography, DatePicker } from 'antd';
import dayjs from 'dayjs';
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons';
import { CATEGORY_CONFIG } from '../utils/constants';
import { UPTIME_RANGE_LABELS, rangeLabelFor } from '../hooks/useRangeUptimes';

const { Text } = Typography;

// Every filter below is multi-select, so none of them carries an 'all' entry:
// selecting nothing is what "all" means.
const STATUS_OPTIONS = [
    { value: 'online', label: 'Active' },
    { value: 'offline', label: 'Inactive' },
    { value: 'disabled', label: 'Disabled' },
];

// s.status is capitalised; the option values are not.
const STATUS_VALUE = { online: 'Active', offline: 'Inactive', disabled: 'Disabled' };

const CATEGORY_OPTIONS =
    Object.entries(CATEGORY_CONFIG).map(([k, v]) => ({ value: k, label: `${v.icon} ${v.name}` }));

// Same order the Province availability chart plots them in.
const PROVINCE_OPTIONS = [
    { value: 'Islamabad', label: 'Islamabad' },
    { value: 'Punjab', label: 'Punjab' },
    { value: 'AJK', label: 'AJK' },
    { value: 'Balochistan', label: 'Balochistan' },
    { value: 'GB', label: 'Gilgit-Baltistan' },
    { value: 'KPK', label: 'KPK' },
    { value: 'Sindh', label: 'Sindh' },
    { value: 'unassigned', label: '❓ Unassigned' },
];

const SOURCE_OPTIONS = [
    { value: 'Davis', label: 'Davis' },
    { value: 'Misol', label: 'Misol' },
    { value: 'WU', label: 'WU' },
];

const RANGE_OPTIONS = Object.entries(UPTIME_RANGE_LABELS)
    .map(([value, label]) => ({ value, label }));

// Returns NaN when the station has nothing logged for the selected period, so
// callers can show "no data" instead of the Worker's synthetic 100%.
function getUptimeValue(station, rangeUptimes) {
    const override = rangeUptimes?.[String(station.station_id)];
    if (override !== undefined && override !== null) {
        if (!override.checks) return NaN;
        return parseFloat(override.uptime);
    }
    if (station.uptime_24h !== undefined && station.uptime_24h !== null) {
        return parseFloat(station.uptime_24h);
    }
    if (station.uptime !== undefined && station.uptime !== null) {
        return parseFloat(station.uptime);
    }
    return 0;
}

export default function StationTable({ stations, statusFilter, categoryFilter, onFilterChange, onCategoryChange, onStationClick,
    range, onRangeChange, rangeUptimes, rangeLoading }) {
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState([]);
    const [provinceFilter, setProvinceFilter] = useState([]);

    const filtered = useMemo(() => {
        let result = stations;
        // Within a filter the ticked values are OR'd; across filters they AND.
        if (statusFilter.length) {
            const want = new Set(statusFilter.map(k => STATUS_VALUE[k]));
            result = result.filter(s => want.has(s.status));
        }
        if (categoryFilter.length) result = result.filter(s => categoryFilter.includes(s.category));
        if (provinceFilter.length) {
            // A station with no province answers to the 'unassigned' option.
            result = result.filter(s => provinceFilter.includes(s.province || 'unassigned'));
        }
        if (sourceFilter.length) {
            result = result.filter(s => sourceFilter.some(f => (
                f === 'WU' ? s.category === 'wu'
                    : (s.api_source || '').toLowerCase().includes(f.toLowerCase())
            )));
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
    }, [stations, statusFilter, categoryFilter, provinceFilter, sourceFilter, search]);

    function handleExport(format) {
        if (format === 'csv') {
            const rows = [['Station', 'Source', 'Status', 'Temp', 'Rain', `Uptime % (${range})`, 'Province']];
            filtered.forEach(s => rows.push([
                s.station_name,
                s.api_source,
                s.status,
                s.temperature ?? '',
                s.rainfall ?? '',
                isNaN(getUptimeValue(s, rangeUptimes)) ? 'no data' : getUptimeValue(s, rangeUptimes).toFixed(1),
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
            // First click sorts DESCENDING (hottest first) — what users
            // actually want when they click "Temp". Null sentinel pushes
            // stations with no temperature to the bottom in that direction.
            sortDirections: ['descend', 'ascend'],
            sorter: (a, b) => (a.temperature ?? -Infinity) - (b.temperature ?? -Infinity),
            render: (value) => value !== null && value !== undefined ? `${value}°C` : '--',
        },
        {
            title: 'Rain',
            dataIndex: 'rainfall',
            key: 'rainfall',
            sortDirections: ['descend', 'ascend'],
            sorter: (a, b) => (a.rainfall ?? -Infinity) - (b.rainfall ?? -Infinity),
            render: (value) => value !== null && value !== undefined ? `${value} mm` : '--',
        },
        {
            title: `Availability (${rangeLabelFor(range)})${rangeLoading ? ' …' : ''}`,
            dataIndex: 'uptime',
            key: 'uptime',
            // NaN (no data) sorts below every real figure rather than poisoning
            // the comparison, which would scramble the whole column.
            sorter: (a, b) => {
                const av = getUptimeValue(a, rangeUptimes), bv = getUptimeValue(b, rangeUptimes);
                if (isNaN(av) && isNaN(bv)) return 0;
                if (isNaN(av)) return -1;
                if (isNaN(bv)) return 1;
                return av - bv;
            },
            render: (_, record) => {
                const value = getUptimeValue(record, rangeUptimes);
                if (isNaN(value)) {
                    return <Text type="secondary" style={{ fontSize: 12 }}>no data</Text>;
                }
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
                <Select size="small" mode="multiple" allowClear maxTagCount="responsive" placeholder="All Categories"
                    value={categoryFilter} onChange={onCategoryChange} options={CATEGORY_OPTIONS} style={{ minWidth: 180 }} />
                <Select size="small" mode="multiple" allowClear maxTagCount="responsive" placeholder="All Provinces"
                    value={provinceFilter} onChange={setProvinceFilter} options={PROVINCE_OPTIONS} style={{ minWidth: 170 }} />
                <Select size="small" mode="multiple" allowClear maxTagCount="responsive" placeholder="All Sources"
                    value={sourceFilter} onChange={setSourceFilter} options={SOURCE_OPTIONS} style={{ minWidth: 150 }} />
                <Select size="small" mode="multiple" allowClear maxTagCount="responsive" placeholder="All Status"
                    value={statusFilter} onChange={onFilterChange} options={STATUS_OPTIONS} style={{ minWidth: 160 }} />
                <Select size="small" value={range.startsWith('month:') ? undefined : range}
                    placeholder={rangeLabelFor(range)} onChange={onRangeChange}
                    options={RANGE_OPTIONS} style={{ width: 140 }} />
                <DatePicker size="small" picker="month" placeholder="Pick a month" style={{ width: 140 }}
                    value={range.startsWith('month:') ? dayjs(range.slice(6), 'YYYY-MM') : null}
                    onChange={(d) => onRangeChange(d ? `month:${d.format('YYYY-MM')}` : '24h')} />
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
