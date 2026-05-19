import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal, Input, Select, Button, Tag, Card, Statistic, Row, Col, Table, Space, message, Popconfirm } from 'antd';
import { useIssueTracker } from '../hooks/useIssueTracker';
import { STATION_CATEGORIES } from '../utils/constants';

const { TextArea } = Input;
const { Option } = Select;

const STATUS_CONFIG = {
    open: { color: 'gold', label: '🟡 Open' },
    in_progress: { color: 'blue', label: '🔵 In Progress' },
    resolved: { color: 'green', label: '🟢 Resolved' },
    unresolvable: { color: 'red', label: '🔴 Unresolvable' },
};

const PRIORITY_CONFIG = {
    low: { color: 'default', icon: '⬇️' },
    medium: { color: 'gold', icon: '➡️' },
    high: { color: 'orange', icon: '⬆️' },
    critical: { color: 'red', icon: '🔥' },
};

const OUTCOME_OPTIONS = [
    { value: 'answered', label: '✅ Answered' },
    { value: 'no_answer', label: '📵 No Answer' },
    { value: 'busy', label: '🔴 Busy' },
    { value: 'voicemail', label: '📧 Voicemail' },
    { value: 'callback_scheduled', label: '📅 Callback' },
];

const OUTCOME_COLORS = { answered: 'green', no_answer: 'red', busy: 'orange', voicemail: 'blue', callback_scheduled: 'gold' };

export default function IssueTracker({ stations = [], isDark }) {
    const {
        issues, callStats, loading,
        fetchIssues, fetchCallStats, createIssue, updateIssue,
        fetchCalls, logCall, loadAll, exportCalls,
    } = useIssueTracker();

    const [statusFilter, setStatusFilter] = useState('');
    const [rangeFilter, setRangeFilter] = useState('7d');
    const [includeWu, setIncludeWu] = useState(false);
    const [searchText, setSearchText] = useState('');

    // Modals
    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [callModalOpen, setCallModalOpen] = useState(false);
    const [detailModalOpen, setDetailModalOpen] = useState(false);
    const [detailIssue, setDetailIssue] = useState(null);
    const [detailCalls, setDetailCalls] = useState([]);
    const [callIssueId, setCallIssueId] = useState(null);

    // Forms
    const [newIssue, setNewIssue] = useState({ station_id: '', title: '', description: '', priority: 'medium', assigned_to: '', created_by: '' });
    const [newCall, setNewCall] = useState({ caller_name: '', contact_person: '', duration_minutes: '', outcome: 'no_answer', notes: '' });

    const [tabLoaded, setTabLoaded] = useState(false);

    useEffect(() => {
        if (!tabLoaded) {
            setTabLoaded(true);
            loadAll(statusFilter, rangeFilter).then(() => {
                autoResolve();
            });
        }
    }, []);// eslint-disable-line

    const reload = useCallback(async () => {
        await Promise.all([fetchIssues(statusFilter), fetchCallStats(rangeFilter)]);
    }, [statusFilter, rangeFilter, fetchIssues, fetchCallStats]);

    useEffect(() => { if (tabLoaded) reload(); }, [statusFilter, rangeFilter]);// eslint-disable-line

    // Station lookup helper
    const stationMap = useMemo(() => {
        const map = {};
        stations.forEach(s => { map[String(s.station_id)] = s; });
        return map;
    }, [stations]);

    const getStationName = (sid) => {
        const s = stationMap[String(sid)];
        return s ? (s.station_name || s.location || sid) : sid;
    };

    // Filter issues
    const filteredIssues = useMemo(() => {
        let list = includeWu ? [...issues] : issues.filter(i => (STATION_CATEGORIES[i.station_id] || 'community') !== 'wu');
        if (searchText) {
            const term = searchText.toLowerCase();
            list = list.filter(i => {
                const name = getStationName(i.station_id).toLowerCase();
                return name.includes(term) || (i.title || '').toLowerCase().includes(term) || (i.assigned_to || '').toLowerCase().includes(term);
            });
        }
        return list;
    }, [issues, includeWu, searchText, stationMap]);// eslint-disable-line

    // Issue stats
    const issueStats = useMemo(() => {
        const list = includeWu ? issues : issues.filter(i => (STATION_CATEGORIES[i.station_id] || 'community') !== 'wu');
        return {
            open: list.filter(i => i.status === 'open').length,
            in_progress: list.filter(i => i.status === 'in_progress').length,
            resolved: list.filter(i => i.status === 'resolved').length,
        };
    }, [issues, includeWu]);

    // Auto-resolve issues for stations that are back online
    const autoResolve = async () => {
        if (!stations.length) return;
        const activeIds = new Set(stations.filter(s => s.status === 'Active').map(s => String(s.station_id)));
        const freshIssues = await fetchIssues('');
        const toResolve = freshIssues.filter(i => (i.status === 'open' || i.status === 'in_progress') && activeIds.has(String(i.station_id)));
        if (!toResolve.length) return;
        let count = 0;
        for (const issue of toResolve) {
            try { await updateIssue(issue.id, { status: 'resolved' }); count++; } catch (e) { /* skip */ }
        }
        if (count > 0) { message.success(`Auto-resolved ${count} issue(s) for stations back online`); reload(); }
    };

    // Auto-populate inactive issues
    const handleAutoPopulate = async () => {
        if (!stations.length) { message.warning('Station data not loaded yet'); return; }
        const inactive = stations.filter(s => s.status !== 'Active' && (STATION_CATEGORIES[s.station_id] || 'community') !== 'wu');
        if (!inactive.length) { message.info('All stations are active!'); return; }
        const freshIssues = await fetchIssues('');
        const openIds = new Set(freshIssues.filter(i => i.status === 'open' || i.status === 'in_progress').map(i => String(i.station_id)));
        const toCreate = inactive.filter(s => !openIds.has(String(s.station_id)));
        if (!toCreate.length) { message.info('All inactive stations already have open issues'); return; }
        let created = 0;
        for (const s of toCreate) {
            try {
                await createIssue({
                    station_id: s.station_id,
                    title: `Station ${s.status || 'Offline'}: ${s.station_name}`,
                    description: `Auto-created: Station ${s.station_name} (${s.station_id}) is currently ${(s.status || 'offline').toLowerCase()}.`,
                    priority: s.status === 'Disabled' ? 'low' : 'medium',
                });
                created++;
            } catch (e) { /* skip */ }
        }
        message.success(`Created ${created} issue(s) for inactive stations`);
        reload();
    };

    // Create issue handler
    const handleCreateIssue = async () => {
        if (!newIssue.station_id || !newIssue.title) { message.warning('Station and title are required'); return; }
        try {
            await createIssue(newIssue);
            message.success('Issue created');
            setCreateModalOpen(false);
            setNewIssue({ station_id: '', title: '', description: '', priority: 'medium', assigned_to: '', created_by: '' });
            reload();
        } catch (e) { message.error('Failed to create issue'); }
    };

    // Log call handler
    const handleLogCall = async () => {
        if (!newCall.caller_name) { message.warning('Caller name is required'); return; }
        try {
            await logCall(callIssueId, { ...newCall, duration_minutes: newCall.duration_minutes ? parseInt(newCall.duration_minutes) : null });
            message.success('Call logged');
            setCallModalOpen(false);
            setNewCall({ caller_name: '', contact_person: '', duration_minutes: '', outcome: 'no_answer', notes: '' });
            reload();
            if (detailIssue) openDetail(detailIssue.id);
        } catch (e) { message.error('Failed to log call'); }
    };

    // Open issue detail
    const openDetail = async (issueId) => {
        const issue = issues.find(i => i.id === issueId);
        if (!issue) return;
        setDetailIssue(issue);
        try {
            const calls = await fetchCalls(issueId);
            setDetailCalls(calls);
        } catch (e) { setDetailCalls([]); }
        setDetailModalOpen(true);
    };

    // Update issue status from detail
    const handleUpdateStatus = async (newStatus) => {
        if (!detailIssue) return;
        try {
            await updateIssue(detailIssue.id, { status: newStatus });
            message.success('Issue updated');
            setDetailModalOpen(false);
            setDetailIssue(null);
            reload();
        } catch (e) { message.error('Failed to update'); }
    };

    const openCallModal = (issueId) => {
        setCallIssueId(issueId);
        setCallModalOpen(true);
    };

    const cardBg = isDark ? '#1e293b' : '#f8fafc';
    const borderColor = isDark ? '#334155' : '#e2e8f0';

    // Table columns
    const columns = [
        {
            title: 'Station', dataIndex: 'station_id', key: 'station',
            sorter: (a, b) => getStationName(a.station_id).localeCompare(getStationName(b.station_id)),
            render: (sid) => <span style={{ fontSize: 12 }}>{getStationName(sid)}</span>,
        },
        {
            title: 'Issue', dataIndex: 'title', key: 'title', ellipsis: true,
            sorter: (a, b) => (a.title || '').localeCompare(b.title || ''),
            render: (t) => <span style={{ fontSize: 12 }}>{t}</span>,
        },
        {
            title: 'Status', dataIndex: 'status', key: 'status', width: 130,
            sorter: (a, b) => { const o = { open: 0, in_progress: 1, resolved: 2, unresolvable: 3 }; return (o[a.status] ?? 9) - (o[b.status] ?? 9); },
            render: (s) => <Tag color={STATUS_CONFIG[s]?.color || 'default'}>{STATUS_CONFIG[s]?.label || s}</Tag>,
        },
        {
            title: 'Priority', dataIndex: 'priority', key: 'priority', width: 100,
            sorter: (a, b) => { const o = { critical: 0, high: 1, medium: 2, low: 3 }; return (o[a.priority] ?? 9) - (o[b.priority] ?? 9); },
            render: (p) => <Tag color={PRIORITY_CONFIG[p]?.color || 'default'}>{PRIORITY_CONFIG[p]?.icon} {p}</Tag>,
        },
        {
            title: 'Created', dataIndex: 'created_at', key: 'created', width: 100,
            sorter: (a, b) => (a.created_at || '').localeCompare(b.created_at || ''),
            render: (d) => d ? new Date(d + 'Z').toLocaleDateString() : '-',
        },
        {
            title: 'Actions', key: 'actions', width: 140,
            render: (_, record) => (
                <Space size="small">
                    <Button size="small" onClick={(e) => { e.stopPropagation(); openCallModal(record.id); }}>📞 Call</Button>
                    <Button size="small" onClick={(e) => { e.stopPropagation(); openDetail(record.id); }}>👁</Button>
                </Space>
            ),
        },
    ];

    return (
        <div style={{ marginTop: 16 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>📋 Issue Tracker & Call Log</h2>
                <Space wrap>
                    <Select value={rangeFilter} onChange={v => setRangeFilter(v)} style={{ width: 100 }}>
                        <Option value="24h">24h</Option>
                        <Option value="7d">7 Days</Option>
                        <Option value="30d">30 Days</Option>
                        <Option value="1y">1 Year</Option>
                    </Select>
                    <Select value={statusFilter} onChange={v => setStatusFilter(v)} style={{ width: 130 }} allowClear placeholder="All Issues">
                        <Option value="">All Issues</Option>
                        <Option value="open">🟡 Open</Option>
                        <Option value="in_progress">🔵 In Progress</Option>
                        <Option value="resolved">🟢 Resolved</Option>
                        <Option value="unresolvable">🔴 Unresolvable</Option>
                    </Select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={includeWu} onChange={e => setIncludeWu(e.target.checked)} /> Include WU
                    </label>
                    <Button type="default" style={{ background: '#d97706', color: '#fff', border: 'none' }} onClick={handleAutoPopulate}>⚡ Auto-Populate Inactive</Button>
                    <Button type="default" style={{ background: '#16a34a', color: '#fff', border: 'none' }} onClick={() => exportCalls(rangeFilter)}>⬇ Export Logs</Button>
                    <Button type="primary" onClick={() => setCreateModalOpen(true)}>+ New Issue</Button>
                </Space>
            </div>

            {/* Stats Cards */}
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                {[
                    { title: 'Total Calls', value: callStats?.summary?.total_calls || 0 },
                    { title: 'Open Issues', value: issueStats.open },
                    { title: 'In Progress', value: issueStats.in_progress },
                    { title: 'Resolved', value: issueStats.resolved },
                    { title: 'Active Callers', value: callStats?.summary?.active_callers || 0 },
                ].map((s, i) => (
                    <Col key={i} xs={12} sm={8} md={6} lg={4} xl={4}>
                        <Card size="small" style={{ background: cardBg, border: `1px solid ${borderColor}`, textAlign: 'center', borderRadius: 12 }}>
                            <Statistic title={s.title} value={s.value} valueStyle={{ fontSize: 22, fontWeight: 700 }} />
                        </Card>
                    </Col>
                ))}
            </Row>

            {/* Two columns: Issues Table + Calls by Person */}
            <Row gutter={[16, 16]}>
                <Col xs={24} lg={16}>
                    <Card size="small" title={<span style={{ fontSize: 15, fontWeight: 600 }}>Station Issues</span>}
                        extra={<Input placeholder="🔍 Search..." value={searchText} onChange={e => setSearchText(e.target.value)} style={{ width: 180 }} size="small" allowClear />}
                        style={{ background: cardBg, border: `1px solid ${borderColor}`, borderRadius: 12 }}>
                        <Table
                            dataSource={filteredIssues}
                            columns={columns}
                            rowKey="id"
                            size="small"
                            loading={loading}
                            pagination={{ pageSize: 15, showSizeChanger: false, size: 'small' }}
                            scroll={{ x: 600 }}
                            onRow={(record) => ({ onClick: () => openDetail(record.id), style: { cursor: 'pointer' } })}
                        />
                    </Card>
                </Col>
                <Col xs={24} lg={8}>
                    <Card size="small" title={<span style={{ fontSize: 15, fontWeight: 600 }}>Calls by Team Member</span>}
                        style={{ background: cardBg, border: `1px solid ${borderColor}`, borderRadius: 12 }}>
                        {(callStats?.by_person || []).length === 0 ? (
                            <div style={{ textAlign: 'center', padding: 20, color: isDark ? '#94a3b8' : '#666' }}>No calls in this period</div>
                        ) : (
                            (callStats.by_person || []).map((p, i) => (
                                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: i < callStats.by_person.length - 1 ? `1px solid ${borderColor}` : 'none' }}>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.caller_name}</div>
                                        <div style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#666' }}>{p.issues_handled} issue{p.issues_handled !== 1 ? 's' : ''} handled</div>
                                    </div>
                                    <Tag>{p.total_calls} calls</Tag>
                                </div>
                            ))
                        )}
                    </Card>
                </Col>
            </Row>

            {/* Create Issue Modal */}
            <Modal title="Create Issue" open={createModalOpen} onCancel={() => setCreateModalOpen(false)} onOk={handleCreateIssue} okText="Create Issue" width={500}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Station</label>
                        <Select showSearch filterOption={(input, opt) => (opt?.children || '').toLowerCase().includes(input.toLowerCase())}
                            value={newIssue.station_id || undefined} onChange={v => setNewIssue(p => ({ ...p, station_id: v }))} style={{ width: '100%' }} placeholder="Select station...">
                            {stations.map(s => <Option key={s.station_id} value={s.station_id}>{s.station_name} ({s.station_id})</Option>)}
                        </Select>
                    </div>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Title</label>
                        <Input value={newIssue.title} onChange={e => setNewIssue(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Station offline since morning" />
                    </div>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Description</label>
                        <TextArea rows={3} value={newIssue.description} onChange={e => setNewIssue(p => ({ ...p, description: e.target.value }))} placeholder="Details..." />
                    </div>
                    <Row gutter={10}>
                        <Col span={12}>
                            <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Priority</label>
                            <Select value={newIssue.priority} onChange={v => setNewIssue(p => ({ ...p, priority: v }))} style={{ width: '100%' }}>
                                <Option value="low">Low</Option><Option value="medium">Medium</Option>
                                <Option value="high">High</Option><Option value="critical">Critical</Option>
                            </Select>
                        </Col>
                        <Col span={12}>
                            <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Assigned To</label>
                            <Input value={newIssue.assigned_to} onChange={e => setNewIssue(p => ({ ...p, assigned_to: e.target.value }))} placeholder="Team member" />
                        </Col>
                    </Row>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Created By</label>
                        <Input value={newIssue.created_by} onChange={e => setNewIssue(p => ({ ...p, created_by: e.target.value }))} placeholder="Your name" />
                    </div>
                </div>
            </Modal>

            {/* Log Call Modal */}
            <Modal title="Log Call" open={callModalOpen} onCancel={() => setCallModalOpen(false)} onOk={handleLogCall} okText="Log Call" width={500}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Caller Name</label>
                        <Input value={newCall.caller_name} onChange={e => setNewCall(p => ({ ...p, caller_name: e.target.value }))} placeholder="Who made the call?" />
                    </div>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Contact Person</label>
                        <Input value={newCall.contact_person} onChange={e => setNewCall(p => ({ ...p, contact_person: e.target.value }))} placeholder="Who was called?" />
                    </div>
                    <Row gutter={10}>
                        <Col span={12}>
                            <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Duration (mins)</label>
                            <Input type="number" min={0} value={newCall.duration_minutes} onChange={e => setNewCall(p => ({ ...p, duration_minutes: e.target.value }))} placeholder="5" />
                        </Col>
                        <Col span={12}>
                            <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Outcome</label>
                            <Select value={newCall.outcome} onChange={v => setNewCall(p => ({ ...p, outcome: v }))} style={{ width: '100%' }}>
                                {OUTCOME_OPTIONS.map(o => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                            </Select>
                        </Col>
                    </Row>
                    <div>
                        <label style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'block' }}>Notes</label>
                        <TextArea rows={2} value={newCall.notes} onChange={e => setNewCall(p => ({ ...p, notes: e.target.value }))} placeholder="Call notes..." />
                    </div>
                </div>
            </Modal>

            {/* Issue Detail Modal */}
            <Modal title={detailIssue?.title || 'Issue Details'} open={detailModalOpen} onCancel={() => { setDetailModalOpen(false); setDetailIssue(null); }}
                footer={null} width={700}>
                {detailIssue && (
                    <div>
                        <div style={{ marginBottom: 12 }}>
                            <Tag color={STATUS_CONFIG[detailIssue.status]?.color}>{STATUS_CONFIG[detailIssue.status]?.label}</Tag>
                            <Tag color={PRIORITY_CONFIG[detailIssue.priority]?.color}>{PRIORITY_CONFIG[detailIssue.priority]?.icon} {detailIssue.priority}</Tag>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 16, color: isDark ? '#94a3b8' : '#666' }}>
                            <strong>Station:</strong> {getStationName(detailIssue.station_id)} &nbsp;|&nbsp;
                            <strong>Created:</strong> {detailIssue.created_at ? new Date(detailIssue.created_at + 'Z').toLocaleString() : '-'} &nbsp;|&nbsp;
                            <strong>Assigned:</strong> {detailIssue.assigned_to || 'Unassigned'}
                            {detailIssue.description && <><br /><strong>Description:</strong> {detailIssue.description}</>}
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <h4 style={{ margin: 0 }}>Call History</h4>
                            <Button size="small" type="primary" onClick={() => openCallModal(detailIssue.id)}>+ Log Call</Button>
                        </div>

                        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
                            {detailCalls.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: 20, color: isDark ? '#94a3b8' : '#999' }}>No calls logged yet</div>
                            ) : detailCalls.map((c, i) => (
                                <div key={i} style={{ padding: 10, borderBottom: `1px solid ${borderColor}`, fontSize: 13 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <strong>{c.caller_name}</strong>
                                        <Tag color={OUTCOME_COLORS[c.outcome] || 'default'}>{c.outcome?.replace('_', ' ')}</Tag>
                                    </div>
                                    <div style={{ color: isDark ? '#94a3b8' : '#666', marginTop: 4 }}>
                                        {c.contact_person && <>Called: {c.contact_person} &nbsp;|&nbsp;</>}
                                        {c.duration_minutes && <>{c.duration_minutes} min &nbsp;|&nbsp;</>}
                                        {c.call_time ? new Date(c.call_time + 'Z').toLocaleString() : '-'}
                                    </div>
                                    {c.notes && <div style={{ marginTop: 4, fontStyle: 'italic', color: isDark ? '#94a3b8' : '#999' }}>{c.notes}</div>}
                                </div>
                            ))}
                        </div>

                        <Space>
                            <Button style={{ background: '#1890ff', color: '#fff' }} onClick={() => handleUpdateStatus('in_progress')}>🔵 In Progress</Button>
                            <Button style={{ background: '#52c41a', color: '#fff' }} onClick={() => handleUpdateStatus('resolved')}>🟢 Resolved</Button>
                            <Button style={{ background: '#ff4d4f', color: '#fff' }} onClick={() => handleUpdateStatus('unresolvable')}>🔴 Can't Resolve</Button>
                        </Space>
                    </div>
                )}
            </Modal>
        </div>
    );
}
