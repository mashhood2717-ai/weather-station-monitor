import React, { useEffect, useRef, useMemo } from 'react';
import { Card } from 'antd';
import L from 'leaflet';
import 'leaflet.markercluster';

function createMarkerIcon(status) {
    const color = status === 'Active' ? '#52c41a' : status === 'Disabled' ? '#8c8c8c' : '#ff4d4f';
    const shadow = status === 'Active'
        ? 'rgba(82,196,26,0.4)'
        : status === 'Disabled'
            ? 'rgba(140,140,140,0.3)'
            : 'rgba(255,77,79,0.4)';

    return L.divIcon({
        className: '',
        html: `<div style="
      width:12px;height:12px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 0 6px ${shadow};
    "></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
    });
}

export default function StationMap({ stations, onStationClick }) {
    const mapRef = useRef(null);
    const mapInstance = useRef(null);
    const clusterRef = useRef(null);

    // Initialize map
    useEffect(() => {
        if (mapInstance.current) return;

        mapInstance.current = L.map(mapRef.current, {
            center: [30.3753, 69.3451],
            zoom: 5,
            zoomControl: true,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 18,
        }).addTo(mapInstance.current);

        // Legend
        const legend = L.control({ position: 'bottomright' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'map-legend');
            div.innerHTML = `
        <div class="map-legend-title">Station Status</div>
        <div><i style="background:#52c41a"></i> Online</div>
        <div><i style="background:#ff4d4f"></i> Offline</div>
        <div><i style="background:#8c8c8c"></i> Disabled</div>
      `;
            return div;
        };
        legend.addTo(mapInstance.current);

        clusterRef.current = L.markerClusterGroup({
            maxClusterRadius: 40,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
        });
        mapInstance.current.addLayer(clusterRef.current);

        return () => {
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    // Update markers when stations change
    useEffect(() => {
        if (!clusterRef.current) return;

        clusterRef.current.clearLayers();

        stations.forEach((s) => {
            if (!s.latitude || !s.longitude) return;

            const marker = L.marker([s.latitude, s.longitude], {
                icon: createMarkerIcon(s.status),
            });

            const tempStr = s.temperature !== null && s.temperature !== undefined
                ? `${s.temperature}°C`
                : 'N/A';

            marker.bindPopup(`
        <div style="min-width:180px; font-family: 'Space Grotesk', 'IBM Plex Sans', sans-serif;">
          <b style="font-size:14px;">${s.station_name}</b><br/>
          <span style="color:#8c8c8c; font-size:12px;">ID: ${s.station_id}</span><br/>
          <hr style="margin:6px 0;border:0;border-top:1px solid #f0f0f0;"/>
          <div style="font-size:12px;">
            <b>Status:</b> <span style="color:${s.status === 'Active' ? '#52c41a' : s.status === 'Disabled' ? '#8c8c8c' : '#ff4d4f'}">${s.status}</span><br/>
            <b>Temp:</b> ${tempStr}<br/>
            <b>Category:</b> ${s.category}<br/>
            ${s.uptime_24h !== null ? `<b>Uptime 24h:</b> ${parseFloat(s.uptime_24h).toFixed(1)}%` : ''}
          </div>
        </div>
      `);

            marker.on('click', () => {
                if (onStationClick) onStationClick(s);
            });

            clusterRef.current.addLayer(marker);
        });
    }, [stations, onStationClick]);

    return (
        <Card
            title="Station Coverage"
            size="small"
            styles={{ body: { padding: 0, height: 540 } }}
            style={{ borderRadius: 12, overflow: 'hidden' }}
        >
            <div ref={mapRef} style={{ width: '100%', height: 540 }} />
        </Card>
    );
}
