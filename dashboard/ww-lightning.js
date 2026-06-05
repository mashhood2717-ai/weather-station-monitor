/*
 * WeatherWalay Lightning Layer  (additive, dependency-free)
 * -------------------------------------------------------------
 * Adds a live lightning overlay to an existing Leaflet map. It is completely
 * self-contained: it creates its own map panes ABOVE the tiles, draws into its
 * own canvas renderers, and never calls or modifies any page code. Removing
 * this file + its <script> tag returns the dashboard to its exact prior state.
 *
 * Data: GET <API>?windowMs=12000 -> { serverTime, windowMs, count,
 *        strikes: [[lat, lon, epochMs], ...] }  (already filtered to
 *        India / Pakistan / Afghanistan / Iran / Nepal / Bangladesh).
 *
 * Severity = strike density (the feed has no per-strike intensity):
 *   severe (red)  >= 10 strikes in a ~25 km cell over the last 2 min
 *   moderate(amber)>= 4
 *   low (cyan)     < 4
 *
 * Usage (vanilla): just load this file; it auto-attaches to the global `map`.
 * Usage (manual):  window.attachWWLightning(mapInstance, { auto: false });
 */
(function () {
  'use strict';

  var API = 'https://station-history-api.wwfigma-dashboard.workers.dev/api/lightning/recent';
  var WINDOW_MS = 12000; // worker read window (max it allows)
  var POLL_GAP_MS = 8000; // idle gap -> ~20s cadence (~4,300 req/day per tab)
  var STRIKE_TTL_MS = 2 * 60 * 1000; // each strike lives 2 minutes
  var MAX_MARKERS = 5000;
  var PULSE_MS = 850;
  var MAX_PULSES = 120;
  var CELL_DEG = 0.25; // ~25 km
  var SEVERE_AT = 10;
  var MODERATE_AT = 4;
  var ISLAMABAD = [33.6844, 73.0479];
  var RING_KM = [100, 200, 300, 400];

  var STYLE = {
    low: { c: '#22d3ee', d: 3, g: 9, go: 0.1 },
    moderate: { c: '#f59e0b', d: 5, g: 15, go: 0.14 },
    severe: { c: '#ef4444', d: 7, g: 22, go: 0.18 },
  };

  function sevOf(n) {
    return n >= SEVERE_AT ? 'severe' : n >= MODERATE_AT ? 'moderate' : 'low';
  }
  function cellOf(lat, lon) {
    return Math.floor(lat / CELL_DEG) + '_' + Math.floor(lon / CELL_DEG);
  }

  function attach(map, opts) {
    opts = opts || {};
    if (!map || !map.addLayer || typeof L === 'undefined' || !L.canvas) return function () {};
    if (map.__wwLightningAttached) return map.__wwLightningDetach || function () {};
    map.__wwLightningAttached = true;

    function pane(name, z) {
      if (!map.getPane(name)) map.createPane(name);
      var p = map.getPane(name);
      p.style.zIndex = String(z);
      p.style.pointerEvents = 'none';
    }
    pane('ww-ltg-glow', 410);
    pane('ww-ltg-rings', 415);
    pane('ww-ltg-pulse', 420);
    pane('ww-ltg-dots', 425);

    var glowR = L.canvas({ pane: 'ww-ltg-glow', padding: 0.5 });
    var pulseR = L.canvas({ pane: 'ww-ltg-pulse', padding: 0.5 });
    var dotR = L.canvas({ pane: 'ww-ltg-dots', padding: 0.5 });

    // ---- Islamabad distance rings (drawn once) ----
    var ringLayers = [];
    if (opts.rings !== false) {
      ringLayers.push(
        L.circleMarker(ISLAMABAD, {
          pane: 'ww-ltg-rings', radius: 4, color: '#0ea5e9',
          fillColor: '#0ea5e9', fillOpacity: 1, weight: 1, interactive: false,
        }).addTo(map)
      );
      RING_KM.forEach(function (km) {
        ringLayers.push(
          L.circle(ISLAMABAD, {
            pane: 'ww-ltg-rings', radius: km * 1000, color: '#0ea5e9',
            weight: 1, opacity: 0.55, fill: false, dashArray: '4 6', interactive: false,
          }).addTo(map)
        );
        ringLayers.push(
          L.marker([ISLAMABAD[0] + km / 111, ISLAMABAD[1]], {
            pane: 'ww-ltg-rings', interactive: false,
            icon: L.divIcon({
              className: '',
              html: '<span style="background:rgba(14,165,233,.85);color:#fff;font-size:10px;font-weight:600;padding:1px 5px;border-radius:6px;white-space:nowrap;">' + km + ' km</span>',
              iconSize: [44, 16], iconAnchor: [22, 8],
            }),
          }).addTo(map)
        );
      });
    }

    var active = new Map(); // key -> { dot, glow, expireAt, sev }
    var counts = new Map(); // cell -> active strike count
    var pulses = [];
    var pulseTimer = null;
    var pollTimer = null;
    var fadeTimer = null;
    var backoff = 5000;
    var cancelled = false;
    var visible = opts.visible !== false;
    var waitingForVisible = false;
    var hasDoc = typeof document !== 'undefined' && document.addEventListener;
    var stationsVisible = true;

    function tickPulses() {
      var now = Date.now();
      for (var i = pulses.length - 1; i >= 0; i--) {
        var p = pulses[i];
        var t = (now - p.start) / PULSE_MS;
        if (t >= 1) {
          if (map.hasLayer(p.ring)) map.removeLayer(p.ring);
          pulses.splice(i, 1);
        } else {
          p.ring.setRadius(p.base + t * p.base * 2.2);
          p.ring.setStyle({ opacity: 0.7 * (1 - t) });
        }
      }
      if (pulses.length === 0 && pulseTimer) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
    }
    function spawnPulse(lat, lon, sev) {
      if (!visible || pulses.length >= MAX_PULSES) return;
      var base = STYLE[sev].d;
      var ring = L.circleMarker([lat, lon], {
        renderer: pulseR, radius: base, color: STYLE[sev].c,
        weight: 2, opacity: 0.7, fill: false, interactive: false,
      }).addTo(map);
      pulses.push({ ring: ring, start: Date.now(), base: base });
      if (!pulseTimer) pulseTimer = setInterval(tickPulses, 60);
    }

    function addStrike(lat, lon, key, sev) {
      if (active.has(key) || active.size >= MAX_MARKERS) return;
      var s = STYLE[sev];
      var glow = L.circleMarker([lat, lon], {
        renderer: glowR, radius: s.g, stroke: false,
        fillColor: s.c, fillOpacity: visible ? s.go : 0, interactive: false,
      }).addTo(map);
      var dot = L.circleMarker([lat, lon], {
        renderer: dotR, radius: s.d, color: '#ffffff', weight: 1,
        fillColor: s.c, fillOpacity: visible ? 0.95 : 0, opacity: visible ? 0.9 : 0,
        interactive: false,
      }).addTo(map);
      active.set(key, { dot: dot, glow: glow, sev: sev, expireAt: Date.now() + STRIKE_TTL_MS });
      var c = cellOf(lat, lon);
      counts.set(c, (counts.get(c) || 0) + 1);
      spawnPulse(lat, lon, sev);
    }

    function ingest(data) {
      var fresh = [];
      for (var i = 0; i < data.strikes.length; i++) {
        var st = data.strikes[i];
        var key = st[0] + ',' + st[1] + ',' + st[2];
        if (!active.has(key)) fresh.push({ lat: st[0], lon: st[1], key: key });
      }
      var batch = new Map(counts);
      fresh.forEach(function (f) {
        var c = cellOf(f.lat, f.lon);
        batch.set(c, (batch.get(c) || 0) + 1);
      });
      fresh.forEach(function (f) {
        addStrike(f.lat, f.lon, f.key, sevOf(batch.get(cellOf(f.lat, f.lon)) || 1));
      });
    }

    function poll() {
      if (cancelled) return;
      // Don't spend a request while the tab is hidden; resume on visibility.
      if (hasDoc && document.hidden) { waitingForVisible = true; return; }
      fetch(API + '?windowMs=' + WINDOW_MS, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('Lightning API ' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (cancelled) return;
          if (data && Array.isArray(data.strikes)) ingest(data);
          backoff = 5000;
          pollTimer = setTimeout(poll, POLL_GAP_MS);
        })
        .catch(function (err) {
          if (cancelled) return;
          if (window.console) console.warn('Lightning poll failed, retrying:', err);
          pollTimer = setTimeout(poll, backoff);
          backoff = Math.min(backoff * 2, 60000);
        });
    }

    fadeTimer = setInterval(function () {
      var now = Date.now();
      active.forEach(function (e, key) {
        var remaining = e.expireAt - now;
        if (remaining <= 0) {
          if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
          if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
          active.delete(key);
          var ll = e.dot.getLatLng();
          var c = cellOf(ll.lat, ll.lng);
          var left = (counts.get(c) || 1) - 1;
          if (left <= 0) counts.delete(c); else counts.set(c, left);
        } else if (visible) {
          var frac = remaining / STRIKE_TTL_MS;
          var s = STYLE[e.sev];
          e.dot.setStyle({ opacity: frac * 0.9, fillOpacity: frac * 0.95 });
          e.glow.setStyle({ fillOpacity: frac * s.go });
        }
      });
    }, 1000);

    // ---- stations layer toggle (uses the page's existing cluster group) ----
    function getStationsLayer() {
      if (opts.stationsLayer) return opts.stationsLayer;
      try {
        if (typeof markerClusterGroup !== 'undefined' && markerClusterGroup) return markerClusterGroup;
      } catch (e) {}
      return null;
    }
    function setStations(v) {
      stationsVisible = v;
      var layer = getStationsLayer();
      if (!layer) return;
      if (v) {
        if (!map.hasLayer(layer)) map.addLayer(layer);
      } else if (map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    }

    // ---- combined toggle panel (self-contained, top-right) ----
    var control = null;
    if (opts.control !== false && L.Control) {
      var Ctl = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
          var wrap = L.DomUtil.create('div', 'leaflet-bar');
          wrap.style.cssText = 'background:#fff;font:600 12px system-ui,sans-serif;color:#333;overflow:hidden;';
          L.DomEvent.disableClickPropagation(wrap);
          L.DomEvent.disableScrollPropagation(wrap);

          var btnStyle = 'padding:5px 9px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;white-space:nowrap;';
          var ltgBtn = L.DomUtil.create('div', '', wrap);
          ltgBtn.style.cssText = btnStyle + 'border-bottom:1px solid #eee;';
          var staBtn = L.DomUtil.create('div', '', wrap);
          staBtn.style.cssText = btnStyle;

          function renderLtg() {
            ltgBtn.innerHTML = '<span style="font-size:14px;">⚡</span> Lightning: ' + (visible ? 'On' : 'Off');
            ltgBtn.style.opacity = visible ? '1' : '0.55';
          }
          function renderSta() {
            staBtn.innerHTML = '<span style="font-size:14px;">📍</span> Stations: ' + (stationsVisible ? 'On' : 'Off');
            staBtn.style.opacity = stationsVisible ? '1' : '0.55';
          }
          renderLtg();
          renderSta();

          L.DomEvent.on(ltgBtn, 'click', function (ev) {
            L.DomEvent.stop(ev);
            setVisible(!visible);
            renderLtg();
          });
          L.DomEvent.on(staBtn, 'click', function (ev) {
            L.DomEvent.stop(ev);
            setStations(!stationsVisible);
            renderSta();
          });

          // Hide the stations button only if there is genuinely no layer to toggle.
          if (opts.stations === false || !getStationsLayer()) staBtn.style.display = 'none';
          return wrap;
        },
      });
      control = new Ctl();
      control.addTo(map);
    }

    function setVisible(v) {
      visible = v;
      active.forEach(function (e) {
        var s = STYLE[e.sev];
        e.dot.setStyle({ opacity: v ? 0.9 : 0, fillOpacity: v ? 0.95 : 0 });
        e.glow.setStyle({ fillOpacity: v ? s.go : 0 });
      });
      ringLayers.forEach(function (l) {
        if (l.setStyle) l.setStyle({ opacity: v ? 0.55 : 0 });
        if (l._icon) l._icon.style.display = v ? '' : 'none';
      });
    }

    function onVisibility() {
      if (!cancelled && !document.hidden && waitingForVisible) {
        waitingForVisible = false;
        poll();
      }
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);

    poll();

    var detach = function () {
      cancelled = true;
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimer) clearTimeout(pollTimer);
      if (fadeTimer) clearInterval(fadeTimer);
      if (pulseTimer) clearInterval(pulseTimer);
      pulses.forEach(function (p) { if (map.hasLayer(p.ring)) map.removeLayer(p.ring); });
      active.forEach(function (e) {
        if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
        if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
      });
      ringLayers.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
      if (control) map.removeControl(control);
      active.clear();
      counts.clear();
      map.__wwLightningAttached = false;
    };
    map.__wwLightningDetach = detach;
    return detach;
  }

  // Public manual API.
  window.attachWWLightning = attach;

  // Auto-attach to the page's global `map` for the vanilla dashboards.
  // (Classic scripts share the global scope, so the top-level `let map` is
  //  visible here.) Polls briefly, then gives up quietly.
  try {
    var tries = 0;
    var wait = setInterval(function () {
      tries++;
      var m = null;
      try { m = typeof map !== 'undefined' && map ? map : window.map || null; } catch (e) { m = window.map || null; }
      if (m && m.addLayer && typeof L !== 'undefined' && L.canvas) {
        clearInterval(wait);
        attach(m, {});
      } else if (tries > 60) {
        clearInterval(wait); // ~30s, then stop trying
      }
    }, 500);
  } catch (e) {
    if (window.console) console.warn('Lightning auto-attach skipped:', e);
  }
})();
