import React, { useState, useMemo, useEffect } from 'react';
import { ConfigProvider, Layout, theme as antdTheme, App as AntApp, Spin, Row, Col } from 'antd';
import DashboardHeader from './components/DashboardHeader';
import StatCards from './components/StatCards';
import StatusDistribution from './components/StatusDistribution';
import AvailabilitySummaryChart from './components/AvailabilitySummaryChart';
import UptimeTrendChart from './components/UptimeTrendChart';
import StationMap from './components/StationMap';
import StationTable from './components/StationTable';
import RecentlyOfflinePanel from './components/RecentlyOfflinePanel';
import StationDetailModal from './components/StationDetailModal';
import IssueTracker from './components/IssueTracker';
import RainGauges from './components/RainGauges';
import { useStations } from './hooks/useStations';

const { Content } = Layout;

export default function App() {
    const DISPLAY_TOTAL_STATIONS = 350;
    const [isDark, setIsDark] = useState(true);
    const [activeTab, setActiveTab] = useState('monitoring');
    const [selectedStation, setSelectedStation] = useState(null);
    const [statusFilter, setStatusFilter] = useState('all');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const { stations, stats, loading, error, lastUpdated, lastSync, refresh, uptimeTrend } = useStations();

    useEffect(() => {
        const token = localStorage.getItem('ww_token');
        if (!token) {
            window.location.href = 'login.html';
        }
    }, []);

    const handleLogout = () => {
        localStorage.removeItem('ww_token');
        window.location.href = 'login.html';
    };

    const themeConfig = useMemo(() => ({
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
            colorPrimary: '#0ea5e9',
            borderRadius: 8,
            fontFamily: "'Space Grotesk', 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
    }), [isDark]);

    const bgColor = isDark ? '#0b1220' : '#f0f2f5';

    return (
        <ConfigProvider theme={themeConfig}>
            <AntApp>
                <Layout className="dashboard-layout" style={{ background: bgColor, minHeight: '100vh' }}>
                    <Content style={{ padding: '16px 24px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>
                        {/* Header */}
                        <DashboardHeader
                            isDark={isDark}
                            onToggleTheme={() => setIsDark((v) => !v)}
                            lastUpdated={lastUpdated}
                            lastSync={lastSync}
                            onRefresh={refresh}
                            onLogout={handleLogout}
                            loading={loading}
                        />

                        {loading && stations.length === 0 ? (
                            <div style={{ textAlign: 'center', paddingTop: 120 }}>
                                <Spin size="large" />
                                <div style={{ marginTop: 16, color: isDark ? '#94a3b8' : '#666' }}>Loading stations...</div>
                            </div>
                        ) : (
                            <>
                                {/* Tab Navigation */}
                                <div style={{
                                    display: 'flex', gap: 0, marginBottom: 20,
                                    background: isDark ? '#1e293b' : '#f8fafc',
                                    borderRadius: 12, padding: 4,
                                    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                                }}>
                                    {[
                                        { key: 'monitoring', label: '📊 Station Monitoring' },
                                        { key: 'issues', label: '📋 Issue Tracker & Call Logs' },
                                        { key: 'rain', label: '🌧️ Rain Gauges' },
                                    ].map(tab => (
                                        <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
                                            flex: 1, padding: '12px 20px', border: 'none',
                                            background: activeTab === tab.key ? (isDark ? '#0b1220' : '#fff') : 'transparent',
                                            color: activeTab === tab.key ? (isDark ? '#f1f5f9' : '#1e293b') : (isDark ? '#94a3b8' : '#64748b'),
                                            fontSize: 15, fontWeight: 600, cursor: 'pointer', borderRadius: 10,
                                            transition: 'all 0.2s',
                                            boxShadow: activeTab === tab.key ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
                                        }}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>

                                {/* Tab 1: Station Monitoring */}
                                {activeTab === 'monitoring' && (
                                    <>
                                        {/* Stat Cards */}
                                        <StatCards stats={stats} uptimeTrend={uptimeTrend} onFilterChange={setStatusFilter} isDark={isDark} />

                                        {/* Status Distribution + Availability Summary */}
                                        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                                            <Col xs={24} lg={6} xl={5}>
                                                <StatusDistribution stats={stats} isDark={isDark} displayTotal={DISPLAY_TOTAL_STATIONS} />
                                            </Col>
                                            <Col xs={24} lg={18} xl={19}>
                                                <AvailabilitySummaryChart stations={stations} isDark={isDark} />
                                            </Col>
                                        </Row>

                                        {/* Uptime Trend Chart */}
                                        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                                            <Col xs={24}>
                                                <UptimeTrendChart isDark={isDark} />
                                            </Col>
                                        </Row>

                                        {/* Station Map */}
                                        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                                            <Col xs={24}>
                                                <StationMap
                                                    stations={stations}
                                                    isDark={isDark}
                                                    onStationClick={(s) => setSelectedStation(s)}
                                                />
                                            </Col>
                                        </Row>

                                        {/* Station List + Offline Panel */}
                                        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                                            <Col xs={24} lg={16}>
                                                <StationTable
                                                    stations={stations}
                                                    statusFilter={statusFilter}
                                                    categoryFilter={categoryFilter}
                                                    onFilterChange={setStatusFilter}
                                                    onCategoryChange={setCategoryFilter}
                                                    onStationClick={(s) => setSelectedStation(s)}
                                                />
                                            </Col>
                                            <Col xs={24} lg={8}>
                                                <RecentlyOfflinePanel
                                                    stations={stations}
                                                    onStationClick={(s) => setSelectedStation(s)}
                                                />
                                            </Col>
                                        </Row>
                                    </>
                                )}

                                {/* Tab 2: Issue Tracker & Call Logs */}
                                {activeTab === 'issues' && (
                                    <IssueTracker stations={stations} isDark={isDark} />
                                )}

                                {/* Tab 3: Rain Gauges */}
                                {activeTab === 'rain' && (
                                    <RainGauges isDark={isDark} />
                                )}
                            </>
                        )}

                        {/* Station detail modal */}
                        <StationDetailModal
                            station={selectedStation}
                            onClose={() => setSelectedStation(null)}
                            isDark={isDark}
                        />
                    </Content>
                </Layout>
            </AntApp>
        </ConfigProvider>
    );
}
