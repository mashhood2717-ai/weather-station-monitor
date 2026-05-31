import React, { useEffect, useState } from 'react';
import { Modal, Button, Tag, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import axios from 'axios';
import { RAIN_GAUGES_API_BASE } from '../utils/constants';

const { Text } = Typography;

// Storm Watch: polls /api/storm-watch every 5 min. If any WS shows a pressure
// drop ≥ 1.5 hPa in the past hour, a warning modal pops up listing them.
//
// Behaviour:
//   * Modal shows ONCE per "alert event" — once the user dismisses, we cache
//     a fingerprint of the alert payload in sessionStorage so the same alert
//     doesn't keep popping back during the same browser tab session.
//   * A FRESH alert (different station, different timestamp, etc.) gets a new
//     fingerprint and pops up again — that's the whole point of "storm watch".
const POLL_INTERVAL_MS = 5 * 60_000; // 5 min
const STORAGE_KEY = 'storm-watch-acknowledged';

function fingerprint(alerts) {
    // Stable hash key — same alerts = same fingerprint = no re-prompt.
    return alerts
        .map(a => `${a.device_id}:${a.current_timestamp}:${a.delta_hpa.toFixed(2)}`)
        .sort()
        .join('|');
}

export default function StormWatchAlert() {
    const [alerts, setAlerts] = useState([]);
    const [open, setOpen] = useState(false);

    async function check() {
        try {
            const resp = await axios.get(`${RAIN_GAUGES_API_BASE}/api/storm-watch`);
            const data = resp.data;
            if (!data?.success) return;
            const newAlerts = data.alerts || [];
            if (!newAlerts.length) {
                setAlerts([]);
                setOpen(false);
                return;
            }
            // Have we already acknowledged this exact alert set?
            const fp = fingerprint(newAlerts);
            const acked = sessionStorage.getItem(STORAGE_KEY);
            if (acked === fp) {
                // Same alerts as before — don't re-pop.
                setAlerts(newAlerts);
                return;
            }
            setAlerts(newAlerts);
            setOpen(true);
        } catch (e) {
            // Non-fatal — silently skip if the endpoint is unreachable.
            console.warn('Storm watch check failed:', e.message);
        }
    }

    useEffect(() => {
        check();
        const t = setInterval(check, POLL_INTERVAL_MS);
        return () => clearInterval(t);
    }, []);

    const dismiss = () => {
        sessionStorage.setItem(STORAGE_KEY, fingerprint(alerts));
        setOpen(false);
    };

    return (
        <Modal
            open={open}
            onCancel={dismiss}
            footer={<Button type="primary" danger onClick={dismiss}>Acknowledge</Button>}
            closable
            maskClosable={false}
            title={
                <span style={{ color: '#ef4444', fontSize: 18 }}>
                    <WarningOutlined style={{ marginRight: 8 }} />
                    ⚠️ Storm Watch
                </span>
            }
            width={580}
        >
            <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    Rapid pressure drop detected — possible incoming storm front.
                </Text>
                <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
                    Any weather station whose pressure dropped more than{' '}
                    {alerts[0]?.threshold_hpa ?? 1.5} hPa in the past{' '}
                    {alerts[0]?.window_minutes ?? 60} minutes is listed below.
                </Text>

                {alerts.map((a) => (
                    <div
                        key={a.device_id + a.current_timestamp}
                        style={{
                            border: '1px solid rgba(239, 68, 68, 0.35)',
                            background: 'rgba(239, 68, 68, 0.08)',
                            borderRadius: 8,
                            padding: 12,
                            marginBottom: 10,
                        }}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>
                            🌤️ {a.name || a.device_id}
                        </div>
                        <div style={{ fontSize: 13 }}>
                            <Tag color="red" style={{ fontWeight: 700 }}>
                                {a.delta_hpa.toFixed(2)} hPa
                            </Tag>
                            <span style={{ marginLeft: 4 }}>
                                {a.previous_pressure_hpa} → {a.current_pressure_hpa} hPa
                            </span>
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                            From {a.previous_timestamp} UTC → {a.current_timestamp} UTC
                        </div>
                    </div>
                ))}
            </div>
        </Modal>
    );
}
