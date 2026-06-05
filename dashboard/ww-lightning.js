/*
 * WeatherWalay Lightning Layer  (additive, dependency-free)
 * -------------------------------------------------------------
 * Adds a live lightning overlay to an existing Leaflet map. Self-contained:
 * creates its own map panes ABOVE the tiles, draws into its own canvas
 * renderers, and never modifies page code. Remove this file + its <script>
 * tag and the dashboard is exactly as before.
 *
 * Features:
 *  - Strikes filtered server-side to IN/PK/AF/IR/NP/BD; each shows 2 min, fading.
 *  - Severity by local strike density: severe(red)/moderate(amber)/low(cyan).
 *  - NEW strikes pulse (animated ring) + white outline for their first ~30s,
 *    then settle to static/faded — so new vs old is obvious at a glance.
 *  - Click a strike -> popup with distance from Islamabad.
 *  - 4 distance rings (100/200/300/400 km) around Islamabad.
 *  - Non-blocking alert banner when a strike lands within 50 km of Islamabad.
 *
 * Usage (vanilla): load this file; it auto-attaches to the global `map`.
 * Usage (modules): window.attachWWLightning(mapInstance, { auto:false, L });
 */
(function () {
  'use strict';

  var API = 'https://station-history-api.wwfigma-dashboard.workers.dev/api/lightning/recent';
  var WINDOW_MS = 12000;
  var POLL_GAP_MS = 8000;
  var STRIKE_TTL_MS = 2 * 60 * 1000; // strike lifetime on map
  var NEW_MS = 30 * 1000; // how long a strike counts as "new" (pulses + bright)
  var MAX_MARKERS = 5000;
  var MAX_PULSES = 150; // cap on simultaneously-animating rings
  var PULSE_MS = 1100; // pulse loop period
  var CELL_DEG = 0.25; // ~25 km density grid
  var SEVERE_AT = 10;
  var MODERATE_AT = 4;
  var ISLAMABAD = [33.6844, 73.0479];
  var RING_KM = [100, 200, 300, 400];
  var DEFAULT_ALERT_KM = 50;
  var ALERT_COOLDOWN_MS = 30 * 1000;
  var ALERT_SHOW_MS = 9000;

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
    var L =
      (opts && opts.L) ||
      (typeof window !== 'undefined' && window.L) ||
      (typeof globalThis !== 'undefined' && globalThis.L) ||
      null;
    if (!map || !map.addLayer || !L || !L.canvas) return function () {};
    if (map.__wwLightningAttached) return map.__wwLightningDetach || function () {};
    map.__wwLightningAttached = true;

    var alertKm = typeof opts.alertKm === 'number' ? opts.alertKm : DEFAULT_ALERT_KM;

    function pane(name, z, interactive) {
      if (!map.getPane(name)) map.createPane(name);
      var p = map.getPane(name);
      p.style.zIndex = String(z);
      p.style.pointerEvents = interactive ? 'auto' : 'none';
      return p;
    }
    pane('ww-ltg-glow', 410, false);
    pane('ww-ltg-rings', 415, false);
    pane('ww-ltg-pulse', 420, false);
    var dotsPane = pane('ww-ltg-dots', 425, true); // clickable

    var glowR = L.canvas({ pane: 'ww-ltg-glow', padding: 0.5 });
    var pulseR = L.canvas({ pane: 'ww-ltg-pulse', padding: 0.5 });
    var dotR = L.canvas({ pane: 'ww-ltg-dots', padding: 0.5 });

    function distanceKm(lat, lon) {
      try {
        return Math.round(map.distance([lat, lon], ISLAMABAD) / 1000);
      } catch (e) {
        return null;
      }
    }

    // ---- Islamabad distance rings ----
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

    var active = new Map(); // key -> entry
    var counts = new Map(); // cell -> count
    var pulsing = []; // entries with an active pulse ring
    var animTimer = null;
    var fadeTimer = null;
    var pollTimer = null;
    var backoff = 5000;
    var cancelled = false;
    var visible = opts.visible !== false;
    var waitingForVisible = false;
    var hasDoc = typeof document !== 'undefined' && document.addEventListener;
    var stationsVisible = true;
    var lastAlertAt = 0;

    // ---- alert banner ----
    var banner = null;
    var bannerTimer = null;
    var container = map.getContainer ? map.getContainer() : null;
    if (container) {
      banner = document.createElement('div');
      banner.style.cssText =
        'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;' +
        'background:#dc2626;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 14px;' +
        'border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none;cursor:pointer;' +
        'max-width:90%;text-align:center;';
      banner.title = 'Click to dismiss';
      banner.onclick = function () { banner.style.display = 'none'; };
      container.appendChild(banner);
    }
    function showAlert(km) {
      if (!visible || !banner) return;
      var now = Date.now();
      if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
      lastAlertAt = now;
      banner.innerHTML = '⚠️ Lightning strike ' + km + ' km from Islamabad';
      banner.style.display = 'block';
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(function () { if (banner) banner.style.display = 'none'; }, ALERT_SHOW_MS);
    }

    // ---- pulse animation loop (cheap: only the ≤MAX_PULSES newest rings) ----
    function tickAnim() {
      if (pulsing.length === 0) { if (animTimer) { clearInterval(animTimer); animTimer = null; } return; }
      var now = Date.now();
      for (var i = pulsing.length - 1; i >= 0; i--) {
        var e = pulsing[i];
        var age = now - e.born;
        if (!e.ring || !map.hasLayer(e.dot) || age >= NEW_MS) {
          if (e.ring && map.hasLayer(e.ring)) map.removeLayer(e.ring);
          e.ring = null;
          pulsing.splice(i, 1);
          continue;
        }
        if (!visible) continue;
        var t = ((now - e.pulseStart) % PULSE_MS) / PULSE_MS; // 0..1 looping
        e.ring.setRadius(e.base + t * e.base * 2.4);
        e.ring.setStyle({ opacity: 0.75 * (1 - t) });
      }
      if (pulsing.length === 0 && animTimer) { clearInterval(animTimer); animTimer = null; }
    }

    function addStrike(lat, lon, key, sev) {
      if (active.has(key) || active.size >= MAX_MARKERS) return null;
      var s = STYLE[sev];
      var now = Date.now();
      var km = distanceKm(lat, lon);

      var glow = L.circleMarker([lat, lon], {
        renderer: glowR, radius: s.g, stroke: false,
        fillColor: s.c, fillOpacity: visible ? s.go : 0, interactive: false,
      }).addTo(map);

      var dot = L.circleMarker([lat, lon], {
        renderer: dotR, radius: s.d + 1, color: '#ffffff', weight: 2,
        fillColor: s.c, fillOpacity: visible ? 1 : 0, opacity: visible ? 1 : 0,
        interactive: true,
      }).addTo(map);
      dot.bindPopup(
        '<div style="font:12px system-ui,sans-serif;">' +
          '<b>⚡ Lightning strike</b><br>' +
          (km !== null ? '<b>' + km + ' km</b> from Islamabad<br>' : '') +
          'Severity: ' + sev +
        '</div>'
      );

      var entry = { dot: dot, glow: glow, sev: sev, born: now, expireAt: now + STRIKE_TTL_MS, isNew: true };
      active.set(key, entry);
      var c = cellOf(lat, lon);
      counts.set(c, (counts.get(c) || 0) + 1);

      if (visible && pulsing.length < MAX_PULSES) {
        var ring = L.circleMarker([lat, lon], {
          renderer: pulseR, radius: s.d, color: s.c, weight: 2,
          opacity: 0.75, fill: false, interactive: false,
        }).addTo(map);
        entry.ring = ring;
        entry.base = s.d;
        entry.pulseStart = now;
        pulsing.push(entry);
        if (!animTimer) animTimer = setInterval(tickAnim, 70);
      }
      return km;
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
      var closest = Infinity;
      fresh.forEach(function (f) {
        var km = addStrike(f.lat, f.lon, f.key, sevOf(batch.get(cellOf(f.lat, f.lon)) || 1));
        if (km !== null && km < closest) closest = km;
      });
      if (closest <= alertKm) showAlert(closest);
    }

    function poll() {
      if (cancelled) return;
      if (hasDoc && document.hidden) { waitingForVisible = true; return; }
      fetch(API + '?windowMs=' + WINDOW_MS, { headers: { Accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('Lightning API ' + r.status); return r.json(); })
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

    // Fade + expire + new->old transition.
    fadeTimer = setInterval(function () {
      var now = Date.now();
      active.forEach(function (e, key) {
        var remaining = e.expireAt - now;
        if (remaining <= 0) {
          if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
          if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
          if (e.ring && map.hasLayer(e.ring)) map.removeLayer(e.ring);
          active.delete(key);
          var ll = e.dot.getLatLng();
          var cc = cellOf(ll.lat, ll.lng);
          var left = (counts.get(cc) || 1) - 1;
          if (left <= 0) counts.delete(cc); else counts.set(cc, left);
          return;
        }
        if (!visible) return;
        var s = STYLE[e.sev];
        var isNew = now - e.born < NEW_MS;
        if (isNew) {
          e.dot.setStyle({ color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 1 });
          e.glow.setStyle({ fillOpacity: s.go });
        } else {
          var frac = remaining / STRIKE_TTL_MS; // 1 -> 0
          e.dot.setStyle({ color: s.c, weight: 1, radius: s.d, opacity: frac * 0.85, fillOpacity: frac * 0.9 });
          e.glow.setStyle({ fillOpacity: frac * s.go });
          e.isNew = false;
        }
      });
    }, 1000);

    // ---- stations toggle (uses the page's existing cluster group) ----
    function getStationsLayer() {
      if (opts.stationsLayer) return opts.stationsLayer;
      try { if (typeof markerClusterGroup !== 'undefined' && markerClusterGroup) return markerClusterGroup; } catch (e) {}
      return null;
    }
    function setStations(v) {
      stationsVisible = v;
      var layer = getStationsLayer();
      if (!layer) return;
      if (v) { if (!map.hasLayer(layer)) map.addLayer(layer); }
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    }

    function setVisible(v) {
      visible = v;
      if (dotsPane) dotsPane.style.pointerEvents = v ? 'auto' : 'none';
      active.forEach(function (e) {
        var s = STYLE[e.sev];
        e.dot.setStyle({ opacity: v ? 0.9 : 0, fillOpacity: v ? 0.9 : 0 });
        e.glow.setStyle({ fillOpacity: v ? s.go : 0 });
        if (e.ring) e.ring.setStyle({ opacity: v ? 0.5 : 0 });
      });
      ringLayers.forEach(function (l) {
        if (l.setStyle) l.setStyle({ opacity: v ? 0.55 : 0 });
        if (l._icon) l._icon.style.display = v ? '' : 'none';
      });
      if (!v && banner) banner.style.display = 'none';
    }

    // ---- toggle panel (top-right) ----
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
          function renderLtg() { ltgBtn.innerHTML = '<span style="font-size:14px;">⚡</span> Lightning: ' + (visible ? 'On' : 'Off'); ltgBtn.style.opacity = visible ? '1' : '0.55'; }
          function renderSta() { staBtn.innerHTML = '<span style="font-size:14px;">📍</span> Stations: ' + (stationsVisible ? 'On' : 'Off'); staBtn.style.opacity = stationsVisible ? '1' : '0.55'; }
          renderLtg(); renderSta();
          L.DomEvent.on(ltgBtn, 'click', function (ev) { L.DomEvent.stop(ev); setVisible(!visible); renderLtg(); });
          L.DomEvent.on(staBtn, 'click', function (ev) { L.DomEvent.stop(ev); setStations(!stationsVisible); renderSta(); });
          if (opts.stations === false || !getStationsLayer()) staBtn.style.display = 'none';
          return wrap;
        },
      });
      control = new Ctl();
      control.addTo(map);
    }

    function onVisibility() {
      if (!cancelled && !document.hidden && waitingForVisible) { waitingForVisible = false; poll(); }
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);

    poll();

    var detach = function () {
      cancelled = true;
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimer) clearTimeout(pollTimer);
      if (fadeTimer) clearInterval(fadeTimer);
      if (animTimer) clearInterval(animTimer);
      if (bannerTimer) clearTimeout(bannerTimer);
      active.forEach(function (e) {
        if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
        if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
        if (e.ring && map.hasLayer(e.ring)) map.removeLayer(e.ring);
      });
      ringLayers.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
      if (control) map.removeControl(control);
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      active.clear();
      counts.clear();
      pulsing.length = 0;
      map.__wwLightningAttached = false;
    };
    map.__wwLightningDetach = detach;
    return detach;
  }

  window.attachWWLightning = attach;

  // Auto-attach to the page's global `map` (vanilla dashboards).
  try {
    var tries = 0;
    var wait = setInterval(function () {
      tries++;
      var m = null;
      try { m = typeof map !== 'undefined' && map ? map : window.map || null; } catch (e) { m = window.map || null; }
      if (m && m.addLayer && typeof L !== 'undefined' && L.canvas) { clearInterval(wait); attach(m, {}); }
      else if (tries > 60) clearInterval(wait);
    }, 500);
  } catch (e) {
    if (window.console) console.warn('Lightning auto-attach skipped:', e);
  }
})();
