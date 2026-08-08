import React, { useEffect, useRef } from 'react';
import { Card } from 'antd';
import L from 'leaflet';
import 'leaflet.markercluster';

// Map for rain-gauge / weather-station devices coming off the rain-gauges Worker.
//
// Deliberately NOT merged with StationMap: that one speaks the HubService station
// shape (latitude/longitude, status 'Active'|'Inactive'|'Disabled') while these
// devices use lat/lng with a plain online/offline bit. Sharing one component would
// mean a field-mapping layer at every call site for no real gain.

const COLORS = { online: '#52c41a', offline: '#ff4d4f' };

function createMarkerIcon(status) {
    const color = COLORS[status] || COLORS.offline;
    return L.divIcon({
        className: '',
        html: `<div style="
      width:12px;height:12px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 0 6px ${color}66;
    "></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
    });
}

export default function DeviceMap({
    devices,
    isDark,
    title = 'Device Locations',
    renderPopup,
    onDeviceClick,
    height = 420,
}) {
    const mapRef = useRef(null);
    const mapInstance = useRef(null);
    const clusterRef = useRef(null);
    const didFitRef = useRef(false);
    // Callbacks land in a ref so marker rebuilds don't depend on identity of an
    // inline arrow prop — otherwise every parent render would clear and re-add
    // every marker, which visibly flickers the cluster layer.
    const cbRef = useRef({ renderPopup, onDeviceClick });
    cbRef.current = { renderPopup, onDeviceClick };

    useEffect(() => {
        if (mapInstance.current) return;

        mapInstance.current = L.map(mapRef.current, {
            center: [30.3753, 69.3451], // Pakistan
            zoom: 5,
            zoomControl: true,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap',
            maxZoom: 18,
        }).addTo(mapInstance.current);

        const legend = L.control({ position: 'bottomright' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'map-legend');
            div.innerHTML = `
        <div class="map-legend-title">Status</div>
        <div><i style="background:${COLORS.online}"></i> Online</div>
        <div><i style="background:${COLORS.offline}"></i> Offline</div>
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

        // These maps live inside tabs that start hidden, so Leaflet measures the
        // container as 0×0 and renders a gray strip until told to re-measure.
        // ResizeObserver fires when the tab becomes visible, which covers both
        // that case and ordinary window resizes.
        let ro = null;
        if (typeof ResizeObserver !== 'undefined' && mapRef.current) {
            ro = new ResizeObserver(() => {
                if (mapInstance.current) mapInstance.current.invalidateSize();
            });
            ro.observe(mapRef.current);
        }

        return () => {
            if (ro) ro.disconnect();
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!clusterRef.current) return;
        clusterRef.current.clearLayers();

        const points = [];
        (devices || []).forEach((d) => {
            // The Worker range-checks coordinates and nulls out bad ones, so a
            // missing value here means "unknown location" — skip rather than
            // dropping a marker at 0,0 in the Gulf of Guinea.
            if (d.lat === null || d.lat === undefined || d.lng === null || d.lng === undefined) return;

            const marker = L.marker([d.lat, d.lng], { icon: createMarkerIcon(d.status) });
            const html = cbRef.current.renderPopup ? cbRef.current.renderPopup(d) : `<b>${d.name}</b>`;
            marker.bindPopup(`<div style="min-width:190px;font-family:'Inter','IBM Plex Sans',sans-serif;">${html}</div>`);
            marker.on('click', () => {
                if (cbRef.current.onDeviceClick) cbRef.current.onDeviceClick(d);
            });
            clusterRef.current.addLayer(marker);
            points.push([d.lat, d.lng]);
        });

        // Fit once, on the first load that actually has points. Re-fitting on every
        // refresh would yank the viewport back and undo the user's pan/zoom.
        if (!didFitRef.current && points.length && mapInstance.current) {
            mapInstance.current.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 11 });
            didFitRef.current = true;
        }
    }, [devices]);

    const located = (devices || []).filter((d) => d.lat != null && d.lng != null).length;
    const total = (devices || []).length;

    return (
        <Card
            title={title}
            size="small"
            extra={
                <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {located} of {total} located
                </span>
            }
            styles={{ body: { padding: 0 } }}
            style={{ borderRadius: 12, overflow: 'hidden', marginTop: 16 }}
        >
            <div
                ref={mapRef}
                className={isDark ? 'map-dark' : ''}
                style={{ width: '100%', height }}
            />
        </Card>
    );
}
