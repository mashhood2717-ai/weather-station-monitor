/*
 * WeatherWalay Lightning Layer  (additive, dependency-free)
 * -------------------------------------------------------------
 * Live lightning overlay for an existing Leaflet map. Self-contained: own panes
 * above the tiles, own renderers; never modifies page code. Remove this file +
 * its <script> tag and the dashboard is exactly as before.
 *
 *  - Strikes filtered server-side to IN/PK/AF/IR/NP/BD; each shows 2 min, fading.
 *  - Strikes drawn as lightning-bolt icons, coloured/sized by local density:
 *    severe(red) / moderate(amber) / low(cyan).
 *  - NEW strikes pulse (CSS-animated bolt) for their first ~30s, then settle to
 *    static/faded — so new vs old is obvious.
 *  - Soft glow underneath each bolt builds into "heat" zones.
 *  - Click a bolt -> popup with distance from Islamabad.
 *  - 4 distance rings (100/200/300/400 km) around Islamabad.
 *  - Non-blocking banner when a strike lands within 50 km of Islamabad.
 *
 * Usage (vanilla): load this file; it auto-attaches to the global `map`.
 * Usage (modules): window.attachWWLightning(mapInstance, { auto:false, L });
 */
(function () {
  'use strict';

  var API_BASE = 'https://station-history-api.wwfigma-dashboard.workers.dev/api/lightning';
  var WINDOW_MS = 12000; // worker read window for the polling fallback
  var POLL_GAP_MS = 8000; // idle gap for the polling fallback
  var STRIKE_TTL_MS = 15 * 60 * 1000; // total time a strike stays on the map
  var SOLID_MS = 2 * 60 * 1000; // full colour for the first 2 min
  var COLOR_END_MS = 5 * 60 * 1000; // colour fades out by 5 min, then turns grey
  var GREY_COLOR = '#9ca3af'; // grey bolts for 5-15 min (old strikes)
  var NEW_MS = 30 * 1000; // pulsing "just struck" highlight
  var MAX_MARKERS = 4000;
  var CELL_DEG = 0.25;
  var SEVERE_AT = 10;
  var MODERATE_AT = 4;
  var ISLAMABAD = [33.6844, 73.0479];
  var RING_KM = [100, 200, 300, 400];
  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  // Initial bearing from Islamabad to (lat,lon) -> { deg, dir } (16-point compass).
  function bearingFromIslamabad(lat, lon) {
    var rad = Math.PI / 180;
    var p1 = ISLAMABAD[0] * rad, p2 = lat * rad;
    var dl = (lon - ISLAMABAD[1]) * rad;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return { deg: Math.round(deg), dir: COMPASS[Math.round(deg / 22.5) % 16] };
  }
  var DEFAULT_ALERT_KM = 50;
  var ALERT_COOLDOWN_MS = 30 * 1000;
  var ALERT_SHOW_MS = 9000;
  var BOLT_PATH = 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'; // lightning bolt

  var STYLE = {
    low: { c: '#22d3ee', size: 16, g: 9, go: 0.1 },
    moderate: { c: '#f59e0b', size: 22, g: 15, go: 0.14 },
    severe: { c: '#ef4444', size: 28, g: 22, go: 0.18 },
  };

  function sevOf(n) {
    return n >= SEVERE_AT ? 'severe' : n >= MODERATE_AT ? 'moderate' : 'low';
  }
  function cellOf(lat, lon) {
    return Math.floor(lat / CELL_DEG) + '_' + Math.floor(lon / CELL_DEG);
  }

  // Inject the bolt styles + pulse keyframes once.
  function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById('ww-ltg-style')) return;
    var st = document.createElement('style');
    st.id = 'ww-ltg-style';
    st.textContent =
      '.ww-bolt svg{display:block;filter:drop-shadow(0 0 2px rgba(0,0,0,.5));}' +
      '.ww-bolt-new svg{animation:wwBoltPulse 1.1s ease-in-out infinite;transform-origin:50% 50%;}' +
      '@keyframes wwBoltPulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.45);opacity:.7;}}';
    (document.head || document.documentElement).appendChild(st);
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
    ensureStyle();

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
    var dotsPane = pane('ww-ltg-dots', 425, true);

    var glowR = L.canvas({ pane: 'ww-ltg-glow', padding: 0.5 });

    function boltIcon(sev, isNew, grey) {
      var s = STYLE[sev];
      var px = s.size;
      var fill = grey ? GREY_COLOR : s.c;
      return L.divIcon({
        className: 'ww-bolt' + (isNew && !grey ? ' ww-bolt-new' : ''),
        html:
          '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="' + BOLT_PATH + '" fill="' + fill + '" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
        iconSize: [px, px],
        iconAnchor: [px / 2, px / 2],
      });
    }

    function distanceKm(lat, lon) {
      try { return Math.round(map.distance([lat, lon], ISLAMABAD) / 1000); } catch (e) { return null; }
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

    var active = new Map();
    var counts = new Map();
    var fadeTimer = null;
    var es = null;            // EventSource (live stream, primary)
    var pollTimer = null;     // polling-fallback timer
    var reconnectTimer = null;
    var streamFails = 0;
    var gotStreamMsg = false;
    var usingPoll = false;
    var backoff = 5000;
    var cancelled = false;
    var visible = opts.visible !== false;
    var waitingForVisible = false;
    var hasDoc = typeof document !== 'undefined' && document.addEventListener;
    var stationsVisible = true;
    var soundOn = opts.sound === true; // soft click on new strikes (default OFF)
    var audioCtx = null;
    var lastTick = 0;
    var TICK_GAP_MS = 60 * 1000; // one click at most per minute (not per strike, not realtime)

    function unlockAudio() {
      try {
        if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      } catch (e) {}
    }
    function playTick() {
      if (!soundOn || !audioCtx) return;
      try {
        // Dry "click": a very short high-passed noise burst with a fast decay.
        var sr = audioCtx.sampleRate;
        var len = Math.max(1, Math.floor(sr * 0.025)); // ~25 ms
        var buf = audioCtx.createBuffer(1, len, sr);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) {
          var env = Math.pow(1 - i / len, 3); // fast decay
          d[i] = (Math.random() * 2 - 1) * env;
        }
        var src = audioCtx.createBufferSource(); src.buffer = buf;
        var hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
        var g = audioCtx.createGain(); g.gain.value = 0.55;
        src.connect(hp); hp.connect(g); g.connect(audioCtx.destination);
        src.start();
      } catch (e) {}
    }
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
        'border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none;cursor:pointer;max-width:90%;text-align:center;';
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

    function removeEntry(key, e) {
      if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
      if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
      active.delete(key);
      var ll = e.dot.getLatLng();
      var cc = cellOf(ll.lat, ll.lng);
      var left = (counts.get(cc) || 1) - 1;
      if (left <= 0) counts.delete(cc); else counts.set(cc, left);
    }

    function addStrike(lat, lon, key, sev, t) {
      if (active.has(key)) return null;
      // Evict the oldest strike when full so new strikes are never blocked.
      if (active.size >= MAX_MARKERS) {
        var oldestKey = active.keys().next().value; // Map keeps chronological order
        if (oldestKey) removeEntry(oldestKey, active.get(oldestKey));
      }
      var s = STYLE[sev];
      var now = Date.now();
      var km = distanceKm(lat, lon);
      var timeStr = '';
      try { if (t) timeStr = new Date(Number(t)).toLocaleTimeString(); } catch (e) {}

      var glow = L.circleMarker([lat, lon], {
        renderer: glowR, radius: s.g, stroke: false,
        fillColor: s.c, fillOpacity: visible ? s.go : 0, interactive: false,
      }).addTo(map);

      var dot = L.marker([lat, lon], {
        pane: 'ww-ltg-dots', icon: boltIcon(sev, true), interactive: true,
        keyboard: false, opacity: visible ? 1 : 0,
      }).addTo(map);
      var brg = bearingFromIslamabad(lat, lon);
      dot.bindPopup(
        '<div style="font:12px system-ui,sans-serif;">' +
          '<b>⚡ Lightning strike</b><br>' +
          (km !== null ? '<b>' + km + ' km ' + brg.dir + '</b> of Islamabad<br>' : '') +
          'Direction: ' + brg.dir + ' (' + brg.deg + '°)<br>' +
          (timeStr ? 'Time: ' + timeStr + '<br>' : '') +
          'Severity: ' + sev +
        '</div>'
      );

      active.set(key, { dot: dot, glow: glow, sev: sev, born: now, expireAt: now + STRIKE_TTL_MS, isNew: true, greyed: false });
      var c = cellOf(lat, lon);
      counts.set(c, (counts.get(c) || 0) + 1);
      return km;
    }

    function ingest(data) {
      var fresh = [];
      for (var i = 0; i < data.strikes.length; i++) {
        var st = data.strikes[i];
        var key = st[0] + ',' + st[1] + ',' + st[2];
        if (!active.has(key)) fresh.push({ lat: st[0], lon: st[1], key: key, t: st[2] });
      }
      var batch = new Map(counts);
      fresh.forEach(function (f) {
        var c = cellOf(f.lat, f.lon);
        batch.set(c, (batch.get(c) || 0) + 1);
      });
      var closest = Infinity;
      var bounds = map.getBounds();
      var visibleFresh = false;
      fresh.forEach(function (f) {
        var km = addStrike(f.lat, f.lon, f.key, sevOf(batch.get(cellOf(f.lat, f.lon)) || 1), f.t);
        if (km !== null && km < closest) closest = km;
        if (!visibleFresh && bounds.contains(L.latLng(f.lat, f.lon))) visibleFresh = true;
      });
      if (closest <= alertKm) showAlert(closest);
      // Sound only for NEW strikes currently visible on the map, tab active, throttled.
      if (soundOn && visibleFresh && !(hasDoc && document.hidden)) {
        var tnow = Date.now();
        if (tnow - lastTick > TICK_GAP_MS) { playTick(); lastTick = tnow; }
      }
    }

    // Primary: live SSE stream. Falls back to polling if streaming is
    // unavailable (e.g. worker not yet updated) or unsupported.
    function connect() {
      if (cancelled) return;
      if (usingPoll) { poll(); return; }
      startStream();
    }

    function startStream() {
      if (cancelled || typeof EventSource === 'undefined') { usingPoll = true; return poll(); }
      try { es = new EventSource(API_BASE + '/stream'); } catch (e) { usingPoll = true; return poll(); }
      es.onmessage = function (ev) {
        gotStreamMsg = true; streamFails = 0;
        try { var d = JSON.parse(ev.data); if (d && Array.isArray(d.strikes)) ingest(d); } catch (e) {}
      };
      es.onerror = function () {
        if (!es || es.readyState !== 2 /* CLOSED */) return; // CONNECTING => auto-retrying
        try { es.close(); } catch (e) {} es = null;
        streamFails++;
        if (!gotStreamMsg && streamFails >= 2) { usingPoll = true; poll(); } // stream unavailable -> poll
        else { reconnectTimer = setTimeout(startStream, 2000); }
      };
    }

    function poll() {
      if (cancelled) return;
      fetch(API_BASE + '/recent?windowMs=' + WINDOW_MS, { headers: { Accept: 'application/json' } })
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
        if (remaining <= 0) { removeEntry(key, e); return; }
        if (!visible) return;
        var s = STYLE[e.sev];
        var age = now - e.born;
        // Stop the "just struck" pulse after NEW_MS.
        if (age >= NEW_MS && e.isNew) {
          if (e.dot._icon) e.dot._icon.classList.remove('ww-bolt-new');
          e.isNew = false;
        }
        // Phase 1 (0-2m): solid colour. Phase 2 (2-5m): colour fades to dim.
        // Phase 3 (5-15m): grey bolt, fading further, then removed at 15m.
        var op;
        if (age < SOLID_MS) {
          op = 1;
        } else if (age < COLOR_END_MS) {
          op = 1 - 0.55 * ((age - SOLID_MS) / (COLOR_END_MS - SOLID_MS)); // 1 -> 0.45
        } else {
          if (!e.greyed) {
            e.dot.setIcon(boltIcon(e.sev, false, true)); // swap to grey bolt
            e.glow.setStyle({ fillColor: GREY_COLOR });
            e.greyed = true;
          }
          op = 0.45 - 0.33 * ((age - COLOR_END_MS) / (STRIKE_TTL_MS - COLOR_END_MS)); // 0.45 -> 0.12
          if (op < 0.05) op = 0.05;
        }
        e.dot.setOpacity(op);
        e.glow.setStyle({ fillOpacity: op * s.go });
      });
    }, 1000);

    // ---- stations toggle ----
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
        e.dot.setOpacity(v ? 1 : 0);
        e.glow.setStyle({ fillOpacity: v ? s.go : 0 });
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
          staBtn.style.cssText = btnStyle + 'border-bottom:1px solid #eee;';
          var sndBtn = L.DomUtil.create('div', '', wrap);
          sndBtn.style.cssText = btnStyle;
          function renderLtg() { ltgBtn.innerHTML = '<span style="font-size:14px;">⚡</span> Lightning: ' + (visible ? 'On' : 'Off'); ltgBtn.style.opacity = visible ? '1' : '0.55'; }
          function renderSta() { staBtn.innerHTML = '<span style="font-size:14px;">📍</span> Stations: ' + (stationsVisible ? 'On' : 'Off'); staBtn.style.opacity = stationsVisible ? '1' : '0.55'; }
          function renderSnd() { sndBtn.innerHTML = '<span style="font-size:14px;">' + (soundOn ? '🔊' : '🔇') + '</span> Sound: ' + (soundOn ? 'On' : 'Off'); sndBtn.style.opacity = soundOn ? '1' : '0.55'; }
          renderLtg(); renderSta(); renderSnd();
          L.DomEvent.on(ltgBtn, 'click', function (ev) { L.DomEvent.stop(ev); setVisible(!visible); renderLtg(); });
          L.DomEvent.on(staBtn, 'click', function (ev) { L.DomEvent.stop(ev); setStations(!stationsVisible); renderSta(); });
          L.DomEvent.on(sndBtn, 'click', function (ev) { L.DomEvent.stop(ev); soundOn = !soundOn; if (soundOn) { unlockAudio(); playTick(); } renderSnd(); });
          if (opts.stations === false || !getStationsLayer()) staBtn.style.display = 'none';
          return wrap;
        },
      });
      control = new Ctl();
      control.addTo(map);
    }

    function stopConnections() {
      if (es) { try { es.close(); } catch (e) {} es = null; }
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }
    // Stream 24/7 even when the tab is hidden (monitoring display). On returning
    // to the foreground, re-establish the connection only if it was dropped.
    function onVisibility() {
      if (cancelled || document.hidden) return;
      if (!es && !pollTimer) connect();
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);

    // Unlock audio on the first user interaction (browsers block autoplay).
    if (hasDoc) {
      var audioUnlock = function () {
        unlockAudio();
        document.removeEventListener('pointerdown', audioUnlock);
        document.removeEventListener('keydown', audioUnlock);
        document.removeEventListener('touchstart', audioUnlock);
      };
      document.addEventListener('pointerdown', audioUnlock);
      document.addEventListener('keydown', audioUnlock);
      document.addEventListener('touchstart', audioUnlock);
    }

    connect();

    var detach = function () {
      cancelled = true;
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
      stopConnections();
      if (fadeTimer) clearInterval(fadeTimer);
      if (bannerTimer) clearTimeout(bannerTimer);
      active.forEach(function (e) {
        if (map.hasLayer(e.dot)) map.removeLayer(e.dot);
        if (map.hasLayer(e.glow)) map.removeLayer(e.glow);
      });
      ringLayers.forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
      if (control) map.removeControl(control);
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      active.clear();
      counts.clear();
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
