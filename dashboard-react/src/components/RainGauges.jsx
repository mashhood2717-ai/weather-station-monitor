import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Card, Statistic, Row, Col, Input, Select, Button, Table, Tag, Space, Spin, Progress, Typography, Modal, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';

const { Text } = Typography;

const STATUS_OPTIONS = [
    { value: 'all', label: 'All Status' },
    { value: 'online', label: 'Online Only' },
    { value: 'offline', label: 'Offline Only' },
];

// Mirrors stations' StationTable range options so both dashboards feel the same.
const RANGE_OPTIONS = [
    { value: '24h', label: '24h' },
    { value: 'daily', label: 'Daily' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '1y', label: '1y' },
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
    const [range, setRange] = useState('24h');

    // Click-to-detail modal state
    const [selectedGauge, setSelectedGauge] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // Two independent fetches: upstream rain totals + Worker-tracked uptime
            // for the selected range. Uptime endpoint may be 4xx briefly during
            // initial deploy; we don't want that to mask the live rain data, so
            // handle errors per-call.
            const [gaugesResp, uptimeResp] = await Promise.allSettled([
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges`),
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges-uptime?range=${range}`),
            ]);

            if (gaugesResp.status !== 'fulfilled' || !gaugesResp.value.data?.success) {
                throw new Error(gaugesResp.value?.data?.error || gaugesResp.reason?.message || 'Failed to fetch rain gauges');
            }
            const liveGauges = gaugesResp.value.data.gauges || [];

            // Build a map of gauge_id -> { uptime_24h, uptime_1h, checks_24h, checks_1h, last_online }
            const uptimeMap = {};
            if (uptimeResp.status === 'fulfilled' && uptimeResp.value.data?.success) {
                (uptimeResp.value.data.gauges || []).forEach(u => {
                    uptimeMap[u.gauge_id] = u;
                });
            } else {
                console.warn('Uptime fetch failed (proxy still works):', uptimeResp.reason?.message);
            }

            const merged = liveGauges.map(g => ({
                ...g,
                uptime_24h: uptimeMap[g.id]?.uptime_24h ?? null,
                uptime_1h: uptimeMap[g.id]?.uptime_1h ?? null,
                checks_24h: uptimeMap[g.id]?.checks_24h ?? 0,
                checks_1h: uptimeMap[g.id]?.checks_1h ?? 0,
                last_online: uptimeMap[g.id]?.last_online ?? null,
            }));

            setGauges(merged);
            setLastUpdated(gaugesResp.value.data.last_updated || null);
        } catch (e) {
            console.error('RainGauges fetch error:', e);
            message.error(`Failed to load rain gauges: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        fetchData();
        // fetchData is recreated when `range` changes (closure-captured), so this
        // also re-fires on range switches and the table updates.
    }, [fetchData]);

    const openDetail = useCallback(async (gauge) => {
        setSelectedGauge(gauge);
        setDetail(null);
        setDetailLoading(true);
        try {
            const resp = await axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauge-detail/${encodeURIComponent(gauge.id)}`);
            if (resp.data?.success) {
                setDetail(resp.data);
            } else {
                message.error(resp.data?.error || 'Failed to load gauge detail');
            }
        } catch (e) {
            message.error(`Failed to load gauge detail: ${e.message}`);
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeDetail = () => {
        setSelectedGauge(null);
        setDetail(null);
    };

    const stats = useMemo(() => {
        const total = gauges.length;
        const online = gauges.filter(g => g.status === 'online').length;

        const maxBy = (key) => {
            let max = null;
            for (const g of gauges) {
                const v = Number(g[key]);
                if (!Number.isFinite(v)) continue;
                if (!max || v > Number(max[key])) max = g;
            }
            return max;
        };

        return {
            total,
            online,
            offline: total - online,
            maxDaily:   maxBy('rain_daily'),
            maxWeekly:  maxBy('rain_7d'),
            maxMonthly: maxBy('rain_30d'),
            maxAnnual:  maxBy('rain_this_year'),
        };
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

    const maxCard = (title, color, gauge, key) => ({
        title,
        color,
        value: gauge ? `${Number(gauge[key]).toFixed(1)} mm` : '0.0 mm',
        sub: gauge ? gauge.name : '—',
    });

    const cardCfgs = [
        { title: '🌧️ Total Gauges', value: stats.total, color: '#0ea5e9', sub: 'DynaSys Network' },
        { title: '🟢 Online', value: stats.online, color: '#10b981', sub: 'Currently active' },
        { title: '🔴 Offline', value: stats.offline, color: '#ef4444', sub: 'Currently inactive' },
        maxCard('💧 Daily Max Rainfall',   '#3b82f6', stats.maxDaily,   'rain_daily'),
        maxCard('💦 Weekly Max Rainfall',  '#06b6d4', stats.maxWeekly,  'rain_7d'),
        maxCard('☔ Monthly Max Rainfall', '#8b5cf6', stats.maxMonthly, 'rain_30d'),
        maxCard('🌊 Annual Max Rainfall',  '#f59e0b', stats.maxAnnual,  'rain_this_year'),
    ];

    // Reused for both Uptime 24h and Uptime 1h columns — same color thresholds as
    // the station table.
    const renderUptime = (value, checks) => {
        if (value === null || value === undefined || !checks) {
            return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        }
        const v = Number(value);
        const color = v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
        return (
            <Space size={6}>
                <Progress percent={Math.min(100, v)} size="small" strokeColor={color} showInfo={false} style={{ width: 60 }} />
                <Text style={{ color, fontWeight: 600, fontSize: 12 }}>{v.toFixed(1)}%</Text>
            </Space>
        );
    };

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
        {
            title: `Uptime (${range})${loading ? ' …' : ''}`,
            dataIndex: 'uptime_24h',
            key: 'uptime_range',
            align: 'left',
            width: 140,
            sorter: (a, b) => (Number(a.uptime_24h) || -1) - (Number(b.uptime_24h) || -1),
            render: (v, row) => renderUptime(v, row.checks_24h),
        },
        {
            title: 'Uptime 1h',
            dataIndex: 'uptime_1h',
            key: 'uptime_1h',
            align: 'left',
            width: 140,
            sorter: (a, b) => (Number(a.uptime_1h) || -1) - (Number(b.uptime_1h) || -1),
            render: (v, row) => renderUptime(v, row.checks_1h),
        },
        { title: 'Today (mm)', dataIndex: 'rain_daily', key: 'rain_daily', align: 'right', width: 110, sorter: numericSorter('rain_daily'), render: (v) => <MmCell value={v} /> },
        { title: '24h (mm)', dataIndex: 'rain_24h', key: 'rain_24h', align: 'right', width: 100, sorter: numericSorter('rain_24h'), defaultSortOrder: 'descend', render: (v) => <MmCell value={v} /> },
        { title: '7 Days (mm)', dataIndex: 'rain_7d', key: 'rain_7d', align: 'right', width: 110, sorter: numericSorter('rain_7d'), render: (v) => <MmCell value={v} /> },
        { title: '30 Days (mm)', dataIndex: 'rain_30d', key: 'rain_30d', align: 'right', width: 120, sorter: numericSorter('rain_30d'), render: (v) => <MmCell value={v} /> },
        { title: 'This Year (mm)', dataIndex: 'rain_this_year', key: 'rain_this_year', align: 'right', width: 120, sorter: numericSorter('rain_this_year'), render: (v) => <MmCell value={v} /> },
        { title: 'All Time (mm)', dataIndex: 'rain_all_time', key: 'rain_all_time', align: 'right', width: 120, sorter: numericSorter('rain_all_time'), render: (v) => <MmCell value={v} /> },
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
                                valueStyle={{ color: c.color, fontSize: 20, fontWeight: 700, fontFamily: "'Orbitron', 'Inter', sans-serif" }}
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
                        <Space size={6} align="center">
                            <Text strong style={{ fontSize: 13, color: subColor }}>Range:</Text>
                            <Select value={range} onChange={setRange} style={{ width: 110 }} options={RANGE_OPTIONS} />
                        </Space>
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
                    </Space>
                </div>

                <Spin spinning={loading && gauges.length === 0}>
                    <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={filteredRows}
                        size="small"
                        pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ['10', '25', '50', '75', '100'] }}
                        scroll={{ x: 'max-content' }}
                        onRow={(record) => ({
                            onClick: () => openDetail(record),
                            style: { cursor: 'pointer' },
                        })}
                    />
                </Spin>
            </Card>

            {/* Gauge detail modal — shows all 5 uptime windows + current rain totals */}
            <Modal
                title={selectedGauge ? `🌧️  ${selectedGauge.name}` : 'Gauge Detail'}
                open={!!selectedGauge}
                onCancel={closeDetail}
                footer={<Button onClick={closeDetail}>Close</Button>}
                width={760}
            >
                {selectedGauge && (
                    <div>
                        <div style={{ marginBottom: 14, fontSize: 12, color: subColor }}>
                            <Text type="secondary">ID: {selectedGauge.id}</Text>
                            <span style={{ marginLeft: 12 }}>
                                {selectedGauge.status === 'online'
                                    ? <Tag color="green">ONLINE</Tag>
                                    : <Tag color="red">OFFLINE</Tag>}
                            </span>
                        </div>

                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: subColor }}>Uptime across all windows</div>
                        <Spin spinning={detailLoading}>
                            <Row gutter={[8, 8]}>
                                {['1h', '24h', '7d', '30d', '1y'].map(w => {
                                    const win = detail?.windows?.[w];
                                    const v = win?.uptime;
                                    const checks = win?.checks ?? 0;
                                    const color = v == null
                                        ? '#94a3b8'
                                        : v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';
                                    return (
                                        <Col span={Math.floor(24 / 5)} key={w}>
                                            <Card size="small" style={{ borderTop: `3px solid ${color}` }} styles={{ body: { padding: 10, textAlign: 'center' } }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: subColor, textTransform: 'uppercase' }}>{w}</div>
                                                <div style={{ fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>
                                                    {v == null ? '—' : `${v.toFixed(1)}%`}
                                                </div>
                                                <div style={{ fontSize: 11, color: subColor }}>{checks} polls</div>
                                            </Card>
                                        </Col>
                                    );
                                })}
                            </Row>
                        </Spin>

                        <div style={{ fontWeight: 600, fontSize: 13, marginTop: 18, marginBottom: 8, color: subColor }}>Rain totals (live from upstream)</div>
                        <Row gutter={[8, 8]}>
                            {[
                                { label: 'Today',     key: 'rain_daily' },
                                { label: '24h',       key: 'rain_24h' },
                                { label: '7 days',    key: 'rain_7d' },
                                { label: '30 days',   key: 'rain_30d' },
                                { label: 'This year', key: 'rain_this_year' },
                                { label: 'All time',  key: 'rain_all_time' },
                            ].map(({ label, key }) => {
                                const { text, color } = formatMm(selectedGauge[key]);
                                return (
                                    <Col span={4} key={key}>
                                        <Card size="small" styles={{ body: { padding: 10, textAlign: 'center' } }}>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: subColor }}>{label}</div>
                                            <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2 }}>{text === '—' ? '—' : `${text} mm`}</div>
                                        </Card>
                                    </Col>
                                );
                            })}
                        </Row>

                        {detail?.last_online && (
                            <div style={{ marginTop: 14, fontSize: 12, color: subColor }}>
                                <Text type="secondary">
                                    Last seen online: {new Date(detail.last_online + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}
                                    {' · '}
                                    Tracked since: {detail.tracking_since ? new Date(detail.tracking_since + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : '—'}
                                    {' · '}
                                    {detail.total_rows} polls stored
                                </Text>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}
