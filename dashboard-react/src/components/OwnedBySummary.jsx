import React, { useMemo } from 'react';
import { Card, Typography } from 'antd';
import { STATION_CATEGORIES, OWNER_LABELS } from '../utils/constants';

const { Text } = Typography;

const CATEGORY_COLORS = {
    corporate: '#3b82f6',
    community: '#10b981',
    wu: '#8b5cf6',
    reference: '#f59e0b',
    wow: '#ef4444',
};

export default function OwnedBySummary({ stations }) {
    const categoryData = useMemo(() => {
        const counts = {};
        stations.forEach((s) => {
            const cat = s.category || 'community';
            counts[cat] = (counts[cat] || 0) + 1;
        });

        return Object.entries(OWNER_LABELS).map(([key, label]) => ({
            key,
            label,
            count: counts[key] || 0,
            color: CATEGORY_COLORS[key] || '#8c8c8c',
        }));
    }, [stations]);

    const maxCount = Math.max(...categoryData.map((d) => d.count), 1);

    return (
        <Card
            title={<span style={{ fontWeight: 600, fontSize: 14 }}>Owned By Summary</span>}
            size="small"
            styles={{ body: { padding: '12px 16px' } }}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {categoryData.map((d) => (
                    <div key={d.key}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                            <Text style={{ fontSize: 12 }}>{d.label}</Text>
                            <Text strong style={{ fontSize: 12 }}>{d.count}</Text>
                        </div>
                        <div style={{
                            width: '100%',
                            height: 18,
                            background: '#f0f0f0',
                            borderRadius: 4,
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                width: `${(d.count / maxCount) * 100}%`,
                                height: '100%',
                                background: d.color,
                                borderRadius: 4,
                                transition: 'width 0.6s ease',
                                minWidth: d.count > 0 ? 4 : 0,
                            }} />
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}
