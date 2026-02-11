import React from 'react';
import { Typography, Button, Space, Tooltip, Tag } from 'antd';
import { ReloadOutlined, SunOutlined, MoonOutlined, LogoutOutlined } from '@ant-design/icons';
import logoBlue from '../assets/ww-logo-blue.svg';
import logoWhite from '../assets/ww-logo-white.svg';

const { Title, Text } = Typography;

export default function DashboardHeader({
    isDark,
    onToggleTheme,
    lastUpdated,
    lastSync,
    onRefresh,
    onLogout,
    loading,
}) {
    const formatTime = (date) => {
        if (!date) return '--:--';
        return date.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true });
    };

    const formatSyncLabel = (date) => {
        if (!date) return '--';
        return date.toLocaleString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Karachi',
            hour12: true,
        });
    };

    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
                padding: '14px 20px',
                background: isDark ? 'rgba(15, 23, 42, 0.9)' : '#ffffff',
                borderRadius: 14,
                border: isDark ? '1px solid rgba(148, 163, 184, 0.2)' : '1px solid #e5e7eb',
                boxShadow: '0 8px 20px rgba(15, 23, 42, 0.08)',
                backdropFilter: 'blur(20px)',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <img
                    src={isDark ? logoWhite : logoBlue}
                    alt="WeatherWalay"
                    style={{ height: 32, width: 'auto' }}
                />
                <div>
                    <Title level={4} style={{ margin: 0, fontWeight: 700 }}>
                        Weather Station Monitoring
                    </Title>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            Last updated: {formatTime(lastUpdated)}
                        </Text>
                        <Tag color={isDark ? 'geekblue' : 'blue'} style={{ marginInlineEnd: 0 }}>
                            Last sync: {formatSyncLabel(lastSync)}
                        </Tag>
                    </div>
                </div>
            </div>

            <Space size="middle" wrap>
                <Tooltip title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
                    <Button
                        onClick={onToggleTheme}
                        icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                    >
                        {isDark ? 'Light' : 'Dark'}
                    </Button>
                </Tooltip>

                <Tooltip title="Refresh data">
                    <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh} />
                </Tooltip>

                <Tag color="green" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="live-dot" /> LIVE
                </Tag>

                <Button danger icon={<LogoutOutlined />} onClick={onLogout}>
                    Logout
                </Button>
            </Space>
        </div>
    );
}
