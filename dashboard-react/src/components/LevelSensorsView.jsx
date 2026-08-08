import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Card, Table, Tag, Space, Spin, Statistic, Row, Col, Typography, Button, Input, Select, Progress } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';
import DeviceMap from './DeviceMap';

const { Text } = Typography;

const STATUS_OPTIONS = [
    { value: 'all', label: 'All Status' },
    { value: 'online', label: 'Online Only' },
    { value: 'offline', label: 'Offline Only' },
];

const FT_TO_M = 0.3048;

function num(v, digits = 2, suffix = '') {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    return Number(v).toFixed(digits) + suffix;
}

function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// These run on cells, unlike the mains-powered gauges, so battery is a
// first-class operational signal rather than a footnote.
function batteryColor(pct) {
    if (pct === null || pct === undefined) return '#8c8c8c';
    if (pct < 15) return '#ef4444';
    if (pct < 30) return '#f59e0b';
    return '#10b981';
}

// `onCount` lets the parent label its sub-view toggle with the real sensor count.
export default function LevelSensorsView({ isDark, onCount }) {
    const [sensors, setSensors] = useState([]);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // Uptime shares rain_gauge_logs with the gauges — the online/offline
            // sync is device-type agnostic, so LS history is already there.
            const [lsResp, uptimeResp] = await Promise.allSettled([
                axios.get(`${RAIN_GAUGES_API_BASE}/api/level-sensors`),
                axios.get(`${RAIN_GAUGES_API_BASE}/api/rain-gauges-uptime?range=24h`),
            ]);

            if (lsResp.status !== 'fulfilled' || !lsResp.value.data?.success) {
                throw new Error(lsResp.reason?.message || 'Failed to load level sensors');
            }

            const uptimeMap = {};
            if (uptimeResp.status === 'fulfilled' && uptimeResp.value.data?.success) {
                (uptimeResp.value.data.gauges || []).forEach((u) => { uptimeMap[u.gauge_id] = u; });
            }

            const rows = (lsResp.value.data.sensors || []).map((s) => ({
                ...s,
                uptime_24h: uptimeMap[s.id]?.uptime_24h ?? null,
                checks_24h: uptimeMap[s.id]?.checks_24h ?? 0,
                last_online: uptimeMap[s.id]?.last_online ?? null,
            }));

            setSensors(rows);
            setLastUpdated(lsResp.value.data.last_updated || null);
            if (onCount) onCount(rows.length);
        } catch (e) {
            console.error('LevelSensorsView fetch error:', e);
        } finally {
            setLoading(false);
        }
    }, [onCount]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const filtered = useMemo(() => {
        let rows = sensors.slice();
        if (statusFilter !== 'all') rows = rows.filter((s) => s.status === statusFilter);
        const q = search.trim().toLowerCase();
        if (q) rows = rows.filter((s) => (s.name || '').toLowerCase().includes(q));
        return rows;
    }, [sensors, search, statusFilter]);

    const aggregate = useMemo(() => {
        const online = sensors.filter((s) => s.status === 'online').length;
        const levels = sensors.map((s) => s.water_level_ft).filter((v) => Number.isFinite(v));
        const batts = sensors.map((s) => s.battery_level).filter((v) => Number.isFinite(v));
        const highest = levels.length
            ? sensors.reduce((a, b) => ((b.water_level_ft ?? -Infinity) > (a.water_level_ft ?? -Infinity) ? b : a))
            : null;
        return {
            total: sensors.length,
            online,
            offline: sensors.length - online,
            lowBattery: batts.filter((v) => v < 30).length,
            highest,
        };
    }, [sensors]);

    const subColor = isDark ? '#9ca3af' : '#6b7280';

    const columns = [
        {
            title: 'Sensor',
            dataIndex: 'name',
            key: 'name',
            sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
            render: (v, r) => (
                <div>
                    <strong>{v}</strong>
                    <br />
                    <Text type="secondary" style={{ fontSize: 11 }}>{r.id}</Text>
                </div>
            ),
        },
        {
            title: 'Status',
            dataIndex: 'status',
            key: 'status',
            align: 'center',
            sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
            render: (v) => <Tag color={v === 'online' ? 'green' : 'red'}>{String(v).toUpperCase()}</Tag>,
        },
        {
            title: 'Water Level',
            dataIndex: 'water_level_ft',
            key: 'water_level_ft',
            align: 'right',
            defaultSortOrder: 'descend',
            sorter: (a, b) => (a.water_level_ft ?? -Infinity) - (b.water_level_ft ?? -Infinity),
            render: (v) => (v === null || v === undefined ? '—' : <strong>{num(v, 2, ' ft')}</strong>),
        },
        {
            title: 'Level (m)',
            key: 'level_m',
            align: 'right',
            sorter: (a, b) => (a.water_level_ft ?? -Infinity) - (b.water_level_ft ?? -Infinity),
            render: (_, r) => (r.water_level_ft === null || r.water_level_ft === undefined ? '—' : num(r.water_level_ft * FT_TO_M, 2, ' m')),
        },
        {
            title: 'Battery',
            dataIndex: 'battery_level',
            key: 'battery_level',
            align: 'right',
            sorter: (a, b) => (a.battery_level ?? -Infinity) - (b.battery_level ?? -Infinity),
            render: (v) => (v === null || v === undefined ? '—' : (
                <Progress
                    percent={v}
                    size="small"
                    strokeColor={batteryColor(v)}
                    format={(p) => `${p}%`}
                    style={{ minWidth: 90, marginBottom: 0 }}
                />
            )),
        },
        {
            title: 'Uptime (24h)',
            dataIndex: 'uptime_24h',
            key: 'uptime_24h',
            align: 'right',
            sorter: (a, b) => (a.uptime_24h ?? -Infinity) - (b.uptime_24h ?? -Infinity),
            render: (v, r) => (v === null || v === undefined || !r.checks_24h
                ? <Text type="secondary">—</Text>
                : <span style={{ color: v >= 90 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>{Number(v).toFixed(1)}%</span>),
        },
        {
            title: 'Last Seen',
            dataIndex: 'last_seen',
            key: 'last_seen',
            render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{timeAgo(v)}</Text>,
        },
    ];

    const lastUpdatedText = lastUpdated
        ? `Last updated: ${new Date(lastUpdated).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}`
        : '';

    return (
        <div>
            <Row gutter={[12, 12]} style={{ marginTop: 16, marginBottom: 12 }}>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🌊 Total Sensors" value={aggregate.total} valueStyle={{ color: '#0ea5e9' }} /></Card></Col>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🟢 Online" value={aggregate.online} valueStyle={{ color: '#10b981' }} /></Card></Col>
                <Col xs={12} md={5}><Card size="small"><Statistic title="🔴 Offline" value={aggregate.offline} valueStyle={{ color: '#ef4444' }} /></Card></Col>
                <Col xs={12} md={4}><Card size="small"><Statistic title="🔋 Low Battery (<30%)" value={aggregate.lowBattery} valueStyle={{ color: aggregate.lowBattery ? '#f59e0b' : '#10b981' }} /></Card></Col>
                <Col xs={24} md={5}>
                    <Card size="small">
                        <div style={{ fontSize: 12, color: subColor }}>🌊 Highest Level</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: '#0ea5e9', fontFamily: "'Orbitron','Inter',sans-serif" }}>
                            {aggregate.highest ? num(aggregate.highest.water_level_ft, 2, ' ft') : '—'}
                        </div>
                        <div style={{ fontSize: 11, color: subColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {aggregate.highest ? aggregate.highest.name : '—'}
                        </div>
                    </Card>
                </Col>
            </Row>

            <DeviceMap
                devices={filtered}
                isDark={isDark}
                title="📍 Level Sensor Locations"
                height={360}
                renderPopup={(s) => `
                    <b style="font-size:14px;">${s.name}</b><br/>
                    <hr style="margin:6px 0;border:0;border-top:1px solid #f0f0f0;"/>
                    <div style="font-size:12px;">
                      <b>Status:</b> <span style="color:${s.status === 'online' ? '#52c41a' : '#ff4d4f'}">${s.status}</span><br/>
                      <b>Water level:</b> ${num(s.water_level_ft, 2, ' ft')} (${num((s.water_level_ft ?? 0) * FT_TO_M, 2, ' m')})<br/>
                      <b>Battery:</b> <span style="color:${batteryColor(s.battery_level)}">${s.battery_level ?? '—'}%</span><br/>
                      <b>Last seen:</b> ${timeAgo(s.last_seen)}<br/>
                      ${s.uptime_24h != null ? `<b>Uptime 24h:</b> ${Number(s.uptime_24h).toFixed(1)}%` : ''}
                    </div>
                `}
            />

            <Card style={{ marginTop: 16 }} styles={{ body: { padding: 16 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'center' }}>
                    <Space size={12} wrap>
                        <h3 style={{ margin: 0, fontSize: 16 }}>🌊 Level Sensors</h3>
                        <span style={{ fontSize: 11, color: subColor }}>{lastUpdatedText}</span>
                    </Space>
                    <Space size={8} wrap>
                        <Input
                            prefix={<SearchOutlined />}
                            placeholder="Search sensor..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            allowClear
                            style={{ width: 200 }}
                        />
                        <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }} options={STATUS_OPTIONS} />
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
                    </Space>
                </div>

                <Spin spinning={loading && sensors.length === 0}>
                    <Table
                        rowKey="id"
                        columns={columns}
                        dataSource={filtered}
                        size="small"
                        pagination={false}
                        scroll={{ x: 'max-content' }}
                    />
                </Spin>
            </Card>
        </div>
    );
}
