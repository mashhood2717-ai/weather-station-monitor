import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Card, Statistic, Row, Col, Input, Select, Button, Table, Tag, Space, Spin, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { API_BASE } from '../utils/constants';

const STATUS_OPTIONS = [
    { value: 'all', label: 'All Status' },
    { value: 'online', label: 'Online Only' },
    { value: 'offline', label: 'Offline Only' },
];

function formatMm(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        return { text: '—', color: '#94a3b8', bold: false };
    }
    const n = Number(v);
    if (n <= 0) return { text: '0.0', color: '#94a3b8', bold: false };
    let color = '#22c55e';
    if (n >= 50) color = '#ef4444';
    else if (n >= 20) color = '#f59e0b';
    else if (n >= 5) color = '#06b6d4';
    return { text: n.toFixed(1), color, bold: true };
}

function MmCell({ value }) {
    const { text, color, bold } = formatMm(value);
    return <span style={{ color, fontWeight: bold ? 700 : 400 }}>{text}</span>;
}

export default function RainGauges({ isDark }) {
    const [gauges, setGauges] = useState([]);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [loading, setLoading] = useState(false);

    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const resp = await axios.get(`${API_BASE}/api/rain-gauges`);
            if (resp.data?.success) {
                setGauges(resp.data.gauges || []);
                setLastUpdated(resp.data.last_updated || null);
            } else {
                throw new Error(resp.data?.error || 'Failed to fetch rain gauges');
            }
        } catch (e) {
            console.error('RainGauges fetch error:', e);
            message.error(`Failed to load rain gauges: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const stats = useMemo(() => {
        const total = gauges.length;
        const online = gauges.filter(g => g.status === 'online').length;
        let max = null;
        let sum24h = 0;
        for (const g of gauges) {
            const v = Number(g.rain_24h);
            if (Number.isFinite(v)) {
                sum24h += v;
                if (!max || v > Number(max.rain_24h)) max = g;
            }
        }
        return { total, online, offline: total - online, max, sum24h };
    }, [gauges]);

    const filteredRows = useMemo(() => {
        const q = search.toLowerCase().trim();
        let rows = gauges.slice();
        if (statusFilter !== 'all') rows = rows.filter(g => g.status === statusFilter);
        if (q) rows = rows.filter(g => (g.name || '').toLowerCase().includes(q));
        return rows;
    }, [gauges, search, statusFilter]);

    const numericSorter = (key) => (a, b) => {
        const av = Number(a[key]); const bv = Number(b[key]);
        const an = Number.isFinite(av) ? av : -Infinity;
        const bn = Number.isFinite(bv) ? bv : -Infinity;
        return an - bn;
    };

    const subColor = isDark ? '#94a3b8' : '#64748b';
    const lastUpdatedText = lastUpdated
        ? `Last updated: ${new Date(lastUpdated).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}`
        : '';

    const cardCfgs = [
        { title: '🌧️ Total Gauges', value: stats.total, color: '#0ea5e9', sub: 'DynaSys Network' },
        { title: '🟢 Online', value: stats.online, color: '#10b981', sub: 'Currently active' },
        { title: '🔴 Offline', value: stats.offline, color: '#ef4444', sub: 'Currently inactive' },
        {
            title: '💧 Max 24h Rainfall',
            value: stats.max ? `${Number(stats.max.rain_24h).toFixed(1)} mm` : '0.0 mm',
            color: '#3b82f6',
            sub: stats.max ? stats.max.name : '—',
        },
        { title: '☔ Total 24h Rainfall', value: `${stats.sum24h.toFixed(1)} mm`, color: '#06b6d4', sub: 'Network-wide' },
    ];

    const columns = [
        {
            title: 'Gauge Name',
            dataIndex: 'name',
            key: 'name',
            sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
            render: (name, row) => (
                <div>
                    <div style={{ fontWeight: 600 }}>{name}</div>
                    <div style={{ fontSize: 11, color: subColor }}>{row.id}</div>
                </div>
            ),
        },
        {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            align: 'center',
            width: 100,
            sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
            render: (s) => s === 'online'
                ? <Tag color="green" style={{ fontWeight: 600 }}>ONLINE</Tag>
                : <Tag color="red" style={{ fontWeight: 600 }}>OFFLINE</Tag>,
        },
        { title: 'Today (mm)', dataIndex: 'rain_daily', key: 'rain_daily', align: 'right', width: 110, sorter: numericSorter('rain_daily'), render: (v) => <MmCell value={v} /> },
        { title: '24h (mm)', dataIndex: 'rain_24h', key: 'rain_24h', align: 'right', width: 100, sorter: numericSorter('rain_24h'), defaultSortOrder: 'descend', render: (v) => <MmCell value={v} /> },
        { title: '7 Days (mm)', dataIndex: 'rain_7d', key: 'rain_7d', align: 'right', width: 110, sorter: numericSorter('rain_7d'), render: (v) => <MmCell value={v} /> },
        { title: '30 Days (mm)', dataIndex: 'rain_30d', key: 'rain_30d', align: 'right', width: 120, sorter: numericSorter('rain_30d'), render: (v) => <MmCell value={v} /> },
        { title: 'This Year (mm)', dataIndex: 'rain_this_year', key: 'rain_this_year', align: 'right', width: 120, sorter: numericSorter('rain_this_year'), render: (v) => <MmCell value={v} /> },
        { title: '365 Days (mm)', dataIndex: 'rain_365d', key: 'rain_365d', align: 'right', width: 120, sorter: numericSorter('rain_365d'), render: (v) => <MmCell value={v} /> },
    ];

    return (
        <div>
            {/* Stat Cards */}
            <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
                {cardCfgs.map((c) => (
                    <Col xs={12} sm={12} md={8} lg={Math.floor(24 / cardCfgs.length)} key={c.title}>
                        <Card size="small" style={{ borderTop: `3px solid ${c.color}` }} styles={{ body: { padding: 12 } }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: subColor, textTransform: 'uppercase' }}>{c.title}</div>
                            <Statistic
                                value={c.value}
                                valueStyle={{ color: c.color, fontSize: 20, fontWeight: 700, fontFamily: "'Orbitron', 'Space Grotesk', sans-serif" }}
                            />
                            <div style={{ fontSize: 11, color: subColor, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {c.sub}
                            </div>
                        </Card>
                    </Col>
                ))}
            </Row>

            {/* Controls + Table */}
            <Card style={{ marginTop: 16 }} styles={{ body: { padding: 16 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
                    <Space size={12} wrap>
                        <h3 style={{ margin: 0, fontSize: 16 }}>🌧️ Rain Gauges Data</h3>
                        <span style={{ fontSize: 11, color: subColor }}>{lastUpdatedText}</span>
                    </Space>
                    <Space size={8} wrap>
                        <Input
                            prefix={<SearchOutlined />}
                            placeholder="Search gauge..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            allowClear
                            style={{ width: 200 }}
                        />
                        <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }} options={STATUS_OPTIONS} />
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
                    </Space>
                </div>

                <Spin spinning={loading && gauges.length === 0}>
                    <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={filteredRows}
                        size="small"
                        pagination={{ pageSize: 25, showSizeChanger: true, pageSizeOptions: ['10', '25', '50', '100'] }}
                        scroll={{ x: 'max-content' }}
                    />
                </Spin>
            </Card>
        </div>
    );
}
