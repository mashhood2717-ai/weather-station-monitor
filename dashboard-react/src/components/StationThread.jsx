import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Button, Input, Select, InputNumber, Form, message, Spin } from 'antd';
import { PhoneOutlined } from '@ant-design/icons';
import { API_BASE } from '../utils/constants';

const { TextArea } = Input;

const OUTCOMES = [
    { value: 'answered', label: '✅ Answered' },
    { value: 'no_answer', label: '📵 No Answer' },
    { value: 'busy', label: '🔴 Busy' },
    { value: 'voicemail', label: '📧 Voicemail' },
    { value: 'callback_scheduled', label: '📅 Callback' },
];
const OUTCOME_LABELS = Object.fromEntries(OUTCOMES.map(o => [o.value, o.label]));

// D1 stores naive UTC; render on the PKT clock like the rest of the dashboard.
function threadTime(value) {
    if (!value) return '';
    const d = new Date(String(value).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return String(value);
    return d.toLocaleString('en-GB', {
        timeZone: 'Asia/Karachi', hour12: false,
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' PKT';
}

const DOT = { call: '#0ea5e9', opened: '#ef4444', resolved: '#10b981' };

// One merged history per station: issues opened, issues resolved, calls logged.
// Calls hang off an issue in the schema, so logging one against a station with
// no live issue opens a 'Host contact' issue first and attaches it there.
export default function StationThread({ station, isDark }) {
    const [entries, setEntries] = useState([]);
    const [counts, setCounts] = useState({ calls: 0, issues: 0 });
    const [loading, setLoading] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm();

    const stationId = station?.station_id;

    const load = useCallback(async () => {
        if (!stationId) return;
        setLoading(true);
        try {
            const [issuesResp, callsResp] = await Promise.all([
                axios.get(`${API_BASE}/api/issues?station_id=${encodeURIComponent(stationId)}`),
                axios.get(`${API_BASE}/api/calls?range=1y`),
            ]);
            const issues = Array.isArray(issuesResp.data) ? issuesResp.data : [];
            const calls = (callsResp.data?.calls || [])
                .filter(c => String(c.station_id) === String(stationId));

            const next = [];
            issues.forEach(i => {
                next.push({
                    at: i.created_at, kind: 'opened',
                    title: `Issue opened — ${i.title || 'Untitled'}`,
                    detail: [i.description, i.priority ? `Priority: ${i.priority}` : null].filter(Boolean).join('\n'),
                });
                if (i.resolved_at) {
                    next.push({
                        at: i.resolved_at, kind: 'resolved',
                        title: `Issue ${i.status === 'unresolvable' ? 'closed as unresolvable' : 'resolved'} — ${i.title || 'Untitled'}`,
                        detail: '',
                    });
                }
            });
            calls.forEach(c => {
                next.push({
                    at: c.call_time, kind: 'call',
                    title: `Call by ${c.caller_name || 'unknown'}${c.contact_person ? ' → ' + c.contact_person : ''}`,
                    detail: [OUTCOME_LABELS[c.outcome] || c.outcome,
                        c.duration_minutes ? `${c.duration_minutes} min` : null,
                        c.notes].filter(Boolean).join(' · '),
                });
            });
            next.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
            setEntries(next);
            setCounts({ calls: calls.length, issues: issues.length });
        } catch (e) {
            message.error('Could not load station history');
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [stationId]);

    useEffect(() => { load(); setShowForm(false); }, [load]);

    const submit = async (values) => {
        setSaving(true);
        try {
            const issues = await axios
                .get(`${API_BASE}/api/issues?station_id=${encodeURIComponent(stationId)}`)
                .then(r => (Array.isArray(r.data) ? r.data : []));
            // Reuse the station's live issue rather than opening a duplicate per call.
            let target = issues.find(i => i.status === 'open' || i.status === 'in_progress');
            if (!target) {
                const created = await axios.post(`${API_BASE}/api/issues`, {
                    station_id: String(stationId),
                    title: `Host contact — ${station.station_name || stationId}`,
                    description: 'Opened from the station thread to record a call to the host.',
                    priority: 'medium',
                    created_by: values.caller_name,
                });
                if (!created.data?.id) throw new Error('could not open an issue to attach the call to');
                target = { id: created.data.id };
            }
            await axios.post(`${API_BASE}/api/issues/${target.id}/calls`, {
                caller_name: values.caller_name,
                contact_person: values.contact_person || null,
                duration_minutes: values.duration_minutes || null,
                outcome: values.outcome || 'no_answer',
                notes: values.notes || null,
            });
            form.resetFields(['contact_person', 'duration_minutes', 'notes']);
            setShowForm(false);
            message.success('Call logged');
            await load();
        } catch (e) {
            message.error('Failed to log call: ' + (e.message || 'unknown error'));
        } finally {
            setSaving(false);
        }
    };

    const muted = isDark ? '#94a3b8' : '#64748b';
    const line = isDark ? '#334155' : '#e2e8f0';

    return (
        <div style={{ marginTop: 18 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                Station Thread
                <span style={{ fontSize: 12, fontWeight: 400, color: muted }}>
                    {counts.calls} call{counts.calls === 1 ? '' : 's'} · {counts.issues} issue{counts.issues === 1 ? '' : 's'}
                </span>
                <Button size="small" icon={<PhoneOutlined />} style={{ marginLeft: 'auto' }}
                    onClick={() => setShowForm(v => !v)}>
                    Log a Call
                </Button>
            </h3>

            {showForm && (
                <Form form={form} layout="vertical" size="small" onFinish={submit}
                    initialValues={{ outcome: 'no_answer' }}
                    style={{ border: `1px solid ${line}`, borderRadius: 10, padding: 12, marginBottom: 14 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Form.Item name="caller_name" label="Caller (you)" rules={[{ required: true, message: 'Caller name is required' }]}>
                            <Input placeholder="Your name" />
                        </Form.Item>
                        <Form.Item name="contact_person" label="Contact person (host)">
                            <Input placeholder="Who you spoke to" />
                        </Form.Item>
                        <Form.Item name="duration_minutes" label="Duration (minutes)">
                            <InputNumber min={0} style={{ width: '100%' }} placeholder="5" />
                        </Form.Item>
                        <Form.Item name="outcome" label="Outcome">
                            <Select options={OUTCOMES} />
                        </Form.Item>
                    </div>
                    <Form.Item name="notes" label="Notes" style={{ marginBottom: 10 }}>
                        <TextArea rows={2} placeholder="What did the host say?" />
                    </Form.Item>
                    <Button type="primary" size="small" htmlType="submit" loading={saving}>Save call</Button>
                    <Button size="small" style={{ marginLeft: 8 }} onClick={() => setShowForm(false)}>Cancel</Button>
                </Form>
            )}

            <div style={{ background: isDark ? '#0f172a' : '#f8fafc', borderRadius: 12, padding: 14, maxHeight: 320, overflowY: 'auto' }}>
                {loading ? (
                    <div style={{ textAlign: 'center', padding: 16 }}><Spin size="small" /></div>
                ) : entries.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 16, fontSize: 13, color: muted }}>
                        Nothing recorded for this station yet.
                    </div>
                ) : entries.map((e, i) => (
                    <div key={i} style={{
                        position: 'relative', paddingLeft: 22, paddingBottom: 14,
                        borderLeft: i === entries.length - 1 ? '2px solid transparent' : `2px solid ${line}`,
                    }}>
                        <span style={{
                            position: 'absolute', left: -7, top: 3, width: 12, height: 12, borderRadius: '50%',
                            background: isDark ? '#0f172a' : '#f8fafc', border: `2px solid ${DOT[e.kind] || line}`,
                        }} />
                        <div style={{ fontSize: 11, color: muted }}>{threadTime(e.at)}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isDark ? '#f1f5f9' : '#1e293b' }}>{e.title}</div>
                        {e.detail && (
                            <div style={{ fontSize: 12, color: muted, marginTop: 2, whiteSpace: 'pre-wrap' }}>{e.detail}</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
