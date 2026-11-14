/* SVC · Ventas en terreno: Hoy (ruta y visitas del vendedor), Rutas, Jornada y Comisiones (supervisión),
   y en Configuración: zonas y ubicación de clientes. Usa las funciones de app.js (window.SVC). */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, $$ = S.$$, esc = S.esc, money = S.money, api = S.api, toast = S.toast, byId = S.byId, pad = S.pad;
  var db = function () { return S.db; };

  var RESULTS = [
    { v: 'venta', t: 'Venta realizada', c: 'pagada' },
    { v: 'pedido_pendiente', t: 'Pedido pendiente', c: 'pendiente' },
    { v: 'cobro', t: 'Cobro', c: 'pagada' },
    { v: 'no_compra', t: 'No compra', c: 'anulada' },
    { v: 'cerrado', t: 'Cerrado', c: '' },
    { v: 'no_estaba', t: 'No estaba el encargado', c: '' }
  ];
  var RESULT_NAME = { sin_cierre: 'Sin cerrar' };
  RESULTS.forEach(function (r) { RESULT_NAME[r.v] = r.t; });
  var REASONS = ['Precio', 'Tiene stock', 'Compra a la competencia', 'No estaba el dueño', 'Sin plata', 'Otro'];
  var GPS = {
    ok: ['GPS ok', 'pagada'], lejos: ['Lejos del comercio', 'anulada'], baja_precision: ['GPS impreciso', 'pendiente'],
    sin_gps: ['Sin GPS', 'anulada'], sin_referencia: ['Comercio sin ubicar', 'pendiente']
  };
  var DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  var today = function () { return S.dayKey(new Date()); };
  var hhmm = function (iso) { var d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var longDay = function (k) { var d = new Date(k + 'T12:00:00'); return DAYS[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth() + 1); };
  var addDays = function (k, n) { var d = new Date(k + 'T12:00:00'); d.setDate(d.getDate() + n); return S.dayKey(d); };
  var hasGeo = function (c) { return c && typeof c.lat === 'number' && typeof c.lng === 'number'; };
  var gpsPill = function (v) { var g = GPS[v.gpsStatus] || ['—', '']; return '<span class="pill ' + g[1] + '">' + g[0] + (v.distanceM != null && v.gpsStatus !== 'ok' ? ' · ' + fmtDist(v.distanceM) : '') + '</span>'; };
  var resultPill = function (r) { var x = RESULTS.filter(function (y) { return y.v === r; })[0]; return '<span class="pill ' + (x ? x.c : '') + '">' + esc(RESULT_NAME[r] || r || '—') + '</span>'; };
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m'; }
  function distanceM(a, b) {
    var R = 6371000, rad = function (x) { return x * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLng / 2), 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function isBoss() { return S.isBoss(); }
  function teamUsers() { // usuarios que puede supervisar (incluido él mismo: el supervisor también vende)
    var me = db().me, list = db().users.filter(function (u) { return u.active; });
    if (!list.some(function (u) { return u.id === me.id; })) list.unshift(me);
    return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function mapsLink(c) {
    var dest = hasGeo(c) ? c.lat + ',' + c.lng : (c.address || c.name);
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest);
  }
  function waLink(phone) {
    var d = String(phone || '').split('/')[0].replace(/\D/g, '');
    if (!d) return '';
    if (d.charAt(0) === '0') d = d.slice(1);
    if (d.indexOf('598') !== 0) d = '598' + d;
    return 'https://wa.me/' + d;
  }
  // Mientras el usuario esté en la misma pantalla.
  function alive(el, view) { return el.isConnected && el.dataset.view === view; }

  // ---------- GPS ----------
  var lastPos = null;
  function getPos() {
    return new Promise(function (ok) {
      if (!navigator.geolocation) return ok(null);
      navigator.geolocation.getCurrentPosition(function (p) {
        lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: Date.now() };
        ok(lastPos);
      }, function () { ok(null); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
  }

  // ---------- mapa (Leaflet + OpenStreetMap, se carga solo cuando hace falta) ----------
  var leafletP = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise(function (ok, bad) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      s.onload = function () { ok(); }; s.onerror = function () { leafletP = null; bad(new Error('No se pudo cargar el mapa. Revisá internet.')); };
      document.head.appendChild(s);
    });
    return leafletP;
  }
  var COLORS = { orange: '#ff7a1a', green: '#1f9d55', red: '#d64545', gray: '#8a8a8a', blue: '#2b6cb0', dark: '#1c1c1c' };
  // points: [{lat, lng, label, color, n}]  · line: true une los puntos en orden
  function drawMap(box, points, opts) {
    opts = opts || {};
    var pts = points.filter(function (p) { return typeof p.lat === 'number' && typeof p.lng === 'number'; });
    if (!pts.length) { box.innerHTML = '<div class="map-empty muted small">No hay puntos con ubicación para mostrar.</div>'; return Promise.resolve(); }
    box.innerHTML = '<div class="map-empty muted small">Cargando mapa…</div>';
    return loadLeaflet().then(function () {
      box.innerHTML = '';
      var m = window.L.map(box, { scrollWheelZoom: false });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
      var latlngs = [];
      pts.forEach(function (p) {
        var col = COLORS[p.color] || COLORS.orange;
        var icon = window.L.divIcon({ className: 'mk', html: '<span style="background:' + col + '">' + (p.n != null ? p.n : '') + '</span>', iconSize: [26, 26], iconAnchor: [13, 13] });
        window.L.marker([p.lat, p.lng], { icon: icon }).addTo(m).bindPopup(p.label || '');
        if (p.radius) window.L.circle([p.lat, p.lng], { radius: p.radius, color: col, weight: 1, fillOpacity: 0.08 }).addTo(m);
        latlngs.push([p.lat, p.lng]);
      });
      if (opts.line && latlngs.length > 1) window.L.polyline(latlngs, { color: COLORS.dark, weight: 2, opacity: 0.5, dashArray: '4 6' }).addTo(m);
      if (latlngs.length === 1) m.setView(latlngs[0], 16); else m.fitBounds(latlngs, { padding: [30, 30], maxZoom: 17 });
      setTimeout(function () { m.invalidateSize(); }, 50);
    }, function (e) { box.innerHTML = '<div class="map-empty muted small">' + esc(e.message) + '</div>'; });
  }

  // ---------- historial de un cliente (para la ficha) ----------
  function clientCard(c, opts) {
    opts = opts || {};
    var sales = db().sales.filter(function (s) { return s.clientId === c.id && s.status !== 'anulada'; }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    var debt = sales.filter(function (s) { return s.status === 'pendiente'; }).reduce(function (a, s) { return a + s.total; }, 0);
    var wa = waLink(c.phone);
    return '<div class="ficha">' +
      '<h2>' + esc(c.name) + '</h2>' +
      '<p class="muted">' + (esc(c.address) || 'Sin dirección') + (c.doc ? ' · RUT/CI ' + esc(c.doc) : '') + '</p>' +
      '<div class="ficha-actions">' + (c.phone ? '<a class="btn sm" href="tel:' + esc(String(c.phone).split('/')[0].replace(/[^\d+]/g, '')) + '">📞 Llamar</a>' : '') +
      (wa ? '<a class="btn sm" href="' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') +
      '<a class="btn sm" href="' + mapsLink(c) + '" target="_blank" rel="noopener">🧭 Cómo llegar</a></div>' +
      (debt ? '<p><span class="pill pendiente">Saldo pendiente ' + money(debt) + '</span></p>' : '') +
      (c.notes ? '<p class="small"><b>Notas:</b> ' + esc(c.notes) + '</p>' : '') +
      '<h3>Últimas compras</h3>' + (sales.length ? '<ul class="hist">' + sales.slice(0, 5).map(function (s) {
        return '<li><span>' + S.fmtDate(s.date) + ' · N.º ' + s.number + '</span><b>' + money(s.total) + '</b><span class="muted small">' + esc(s.items.map(function (i) { return i.qty + '× ' + i.name; }).join(', ').slice(0, 120)) + '</span></li>';
      }).join('') + '</ul>' : '<p class="muted small">Todavía no le compró nada' + (isBoss() ? '' : ' a vos') + '.</p>') +
      '<h3>Visitas anteriores</h3><div class="prev-visits" data-client="' + c.id + '"><p class="muted small">Cargando…</p></div>' +
      '</div>';
  }
  function loadPrevVisits(box, c, skipId) {
    api('GET', '/visits?clientId=' + encodeURIComponent(c.id)).then(function (list) {
      list = list.filter(function (v) { return v.id !== skipId; });
      box.innerHTML = list.length ? '<ul class="hist">' + list.slice(0, 6).map(function (v) {
        return '<li><span>' + S.fmtDate(v.checkIn.ts) + ' · ' + esc(v.sellerName) + '</span>' + resultPill(v.result) +
          (v.reason || v.note ? '<span class="small">' + esc([v.reason, v.note].filter(Boolean).join(' — ')) + '</span>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted small">Sin visitas registradas.</p>';
    }, function () { box.innerHTML = '<p class="muted small">No se pudieron cargar.</p>'; });
  }

  // ======================================================================
  // HOY: la ruta del día del vendedor, check-in / check-out
  // ======================================================================
  var hoyState = { routes: [], visits: [], loadedFor: '' };
  S.views.hoy = function (el) {
    var me = db().me, day = today();
    el.innerHTML = '<div class="head"><h1>Hoy</h1><span class="muted">' + longDay(day) + '</span></div><div class="loading">Cargando tu ruta…</div>';
    Promise.all([api('GET', '/routes?date=' + day), api('GET', '/visits?from=' + day + '&sellerId=' + me.id)]).then(function (r) {
      hoyState.routes = r[0].filter(function (x) { return x.sellerId === me.id; });
      hoyState.visits = r[1];
      if (alive(el, 'hoy')) drawHoy(el, day);
    }, function (e) { el.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    if (!lastPos || Date.now() - lastPos.at > 120000) getPos().then(function (p) { if (p && alive(el, 'hoy') && !$('.visit-open', el)) drawHoy(el, day); });
  };

  function drawHoy(el, day) {
    var route = hoyState.routes[0], visits = hoyState.visits;
    var stops = route ? route.stops.map(function (s) { return byId(db().clients, s.clientId); }).filter(Boolean) : [];
    var open = visits.filter(function (v) { return !v.checkOut; })[0];
    var visitOf = function (cid) { return visits.filter(function (v) { return v.clientId === cid; }).sort(function (a, b) { return b.checkIn.ts.localeCompare(a.checkIn.ts); })[0]; };
    var done = stops.filter(function (c) { var v = visitOf(c.id); return v && v.checkOut; }).length;
    var offRoute = visits.filter(function (v) { return !stops.some(function (c) { return c.id === v.clientId; }); });
    var salesToday = db().sales.filter(function (s) { return s.userId === db().me.id && s.status !== 'anulada' && S.dayKey(s.date) === day; });
    var pct = stops.length ? Math.round(done / stops.length * 100) : 0;

    var nextIdx = -1;
    stops.forEach(function (c, i) { if (nextIdx < 0 && !visitOf(c.id)) nextIdx = i; });

    el.innerHTML = '<div class="head"><div><h1>Hoy</h1><span class="muted">' + longDay(day) + (route ? ' · ruta armada por ' + esc(route.updatedBy) : '') + '</span></div>' +
      '<div class="actions"><button class="btn" id="offRoute">+ Visita fuera de ruta</button><button class="btn" id="showMap">🗺️ Mapa</button></div></div>' +
      '<div class="grid kpis hoy-kpis">' +
      '<div class="card kpi accent"><span>Visitas de la ruta</span><b>' + done + ' de ' + stops.length + '</b><div class="bar"><i style="width:' + pct + '%"></i></div></div>' +
      '<div class="card kpi"><span>Fuera de ruta</span><b>' + offRoute.length + '</b></div>' +
      '<div class="card kpi"><span>Ventas de hoy</span><b>' + money(salesToday.reduce(function (a, s) { return a + s.total; }, 0)) + '</b><span class="muted small">' + salesToday.length + ' ventas</span></div>' +
      '<div class="card kpi"><span>Tu ubicación</span><b class="small-b">' + (lastPos ? '±' + lastPos.accuracy + ' m' : '—') + '</b><button class="btn sm" id="locate">Actualizar</button></div>' +
      '</div>' +
      '<div class="map-box" id="hoyMap" hidden></div>' +
      '<div class="hoy">' +
      '<div class="card"><h2>' + (route ? 'Tu ruta' : 'No tenés ruta para hoy') + '</h2>' +
      (route ? '' : '<p class="muted">Tu supervisor todavía no te armó la ruta. Igual podés registrar visitas con “+ Visita fuera de ruta”.</p>') +
      '<ol class="stops">' + stops.map(function (c, i) {
        var v = visitOf(c.id), state = v ? (v.checkOut ? 'done' : 'now') : (i === nextIdx ? 'next' : '');
        var d = lastPos && hasGeo(c) ? fmtDist(distanceM(lastPos, c)) : '';
        return '<li class="stop ' + state + '"><span class="n">' + (i + 1) + '</span><div class="stop-main"><b>' + esc(c.name) + '</b>' +
          '<span class="muted small">' + (esc(c.address) || 'Sin dirección') + (d ? ' · a ' + d : '') + (hasGeo(c) ? '' : ' · sin ubicar') + '</span>' +
          (v ? '<span class="small">' + hhmm(v.checkIn.ts) + (v.checkOut ? '–' + hhmm(v.checkOut.ts) + ' ' + resultPill(v.result) : ' · <b>en visita</b>') + ' ' + gpsPill(v) + '</span>' : '') + '</div>' +
          '<div class="stop-act">' + (v ? '' : '<a class="btn sm" href="' + mapsLink(c) + '" target="_blank" rel="noopener">🧭</a><button class="btn sm' + (state === 'next' ? ' primary' : '') + '" data-in="' + c.id + '"' + (open ? ' disabled' : '') + '>Check-in</button>') + '</div></li>';
      }).join('') + '</ol>' +
      (offRoute.length ? '<h3>Fuera de ruta</h3><ul class="stops">' + offRoute.map(function (v) {
        return '<li class="stop ' + (v.checkOut ? 'done' : 'now') + '"><span class="n">+</span><div class="stop-main"><b>' + esc(v.clientName) + '</b><span class="small">' + hhmm(v.checkIn.ts) +
          (v.checkOut ? '–' + hhmm(v.checkOut.ts) + ' ' + resultPill(v.result) : ' · <b>en visita</b>') + ' ' + gpsPill(v) + '</span></div></li>';
      }).join('') + '</ul>' : '') + '</div>' +
      '<div class="visit-col">' + (open ? openVisitHtml(open) : nextHtml(stops[nextIdx])) + '</div>' +
      '</div>';

    $('#offRoute', el).addEventListener('click', function () { pickClient(function (c) { checkIn(el, day, c); }); });
    $('#locate', el).addEventListener('click', function () { var b = this; b.disabled = true; getPos().then(function (p) { if (!p) toast('No se pudo obtener la ubicación. Revisá que el GPS esté activado y que el navegador tenga permiso.', true); drawHoy(el, day); }); });
    $('#showMap', el).addEventListener('click', function () {
      var box = $('#hoyMap', el); box.hidden = !box.hidden; if (box.hidden) return;
      var pts = stops.map(function (c, i) { var v = visitOf(c.id); return { lat: c.lat, lng: c.lng, n: i + 1, label: '<b>' + esc(c.name) + '</b><br>' + esc(c.address || ''), color: v ? (v.checkOut ? 'green' : 'orange') : 'gray' }; });
      if (lastPos) pts.push({ lat: lastPos.lat, lng: lastPos.lng, label: 'Vos (±' + lastPos.accuracy + ' m)', color: 'blue', n: '●' });
      drawMap(box, pts, { line: true });
    });
    $$('[data-in]', el).forEach(function (b) { b.addEventListener('click', function () { checkIn(el, day, byId(db().clients, b.dataset.in), b); }); });
    var nb = $('#nextIn', el); if (nb) nb.addEventListener('click', function () { checkIn(el, day, byId(db().clients, nb.dataset.c), nb); });
    if (open) bindOpenVisit(el, day, open);
  }

  function nextHtml(c) {
    if (!c) return '<div class="card empty">' + (hoyState.routes[0] ? '¡Terminaste la ruta de hoy! 🎉' : 'Elegí un comercio para hacer check-in.') + '</div>';
    var d = lastPos && hasGeo(c) ? fmtDist(distanceM(lastPos, c)) : '';
    return '<div class="card next-card"><span class="tag">PRÓXIMA VISITA</span><h2>' + esc(c.name) + '</h2>' +
      '<p class="muted">' + (esc(c.address) || 'Sin dirección') + (d ? ' · a ' + d : '') + '</p>' +
      '<div class="two-btn"><a class="btn" href="' + mapsLink(c) + '" target="_blank" rel="noopener">🧭 Cómo llegar</a><button class="btn primary" id="nextIn" data-c="' + c.id + '">📍 Check-in</button></div></div>';
  }

  function openVisitHtml(v) {
    var c = byId(db().clients, v.clientId) || { id: v.clientId, name: v.clientName };
    var sales = db().sales.filter(function (s) { return s.userId === db().me.id && s.clientId === v.clientId && s.status !== 'anulada' && s.date >= v.checkIn.ts; });
    return '<div class="card visit-open"><span class="tag">EN VISITA DESDE LAS ' + hhmm(v.checkIn.ts) + '</span> ' + gpsPill(v) +
      (v.gpsStatus === 'lejos' ? '<p class="small warn">Estás a ' + fmtDist(v.distanceM) + ' del comercio según el mapa. Quedó registrado; tu supervisor lo puede revisar.</p>' : '') +
      (v.located ? '<p class="small ok-t">Ubicación del comercio guardada con tu GPS.</p>' : '') +
      clientCard(c) +
      (sales.length ? '<p><b>Ventas en esta visita:</b> ' + sales.map(function (s) { return 'N.º ' + s.number + ' (' + money(s.total) + ')'; }).join(', ') + '</p>' : '') +
      '<div class="two-btn sticky-act"><button class="btn dark" id="sell">🛒 Vender</button><button class="btn primary" id="checkout">✓ Terminar visita</button></div></div>';
  }
  function bindOpenVisit(el, day, v) {
    var c = byId(db().clients, v.clientId);
    var pv = $('.prev-visits', el); if (pv && c) loadPrevVisits(pv, c, v.id);
    $('#sell', el).addEventListener('click', function () {
      if (!c) return toast('Este cliente ya no está asignado a vos.', true);
      if (S.startSale(c)) location.hash = '#/venta';
    });
    $('#checkout', el).addEventListener('click', function () { checkoutModal(el, day, v); });
  }

  function checkIn(el, day, c, btn) {
    if (!c) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Buscando GPS…'; }
    getPos().then(function (p) {
      if (!p && !confirm('No se pudo obtener tu ubicación (GPS apagado o sin permiso). ¿Registrar la visita igual? Va a quedar marcada “Sin GPS”.')) {
        if (btn) { btn.disabled = false; btn.textContent = 'Check-in'; }
        return;
      }
      var body = { clientId: c.id, date: day, deviceTs: new Date().toISOString() };
      if (p) { body.lat = p.lat; body.lng = p.lng; body.accuracy = p.accuracy; }
      return api('POST', '/visits/checkin', body).then(function (r) {
        var v = r.visit;
        toast(v.gpsStatus === 'ok' ? 'Check-in en ' + c.name + (v.distanceM != null ? ' (a ' + fmtDist(v.distanceM) + ')' : '') : 'Check-in registrado · ' + (GPS[v.gpsStatus] || [''])[0], v.gpsStatus !== 'ok');
        return S.refresh().then(function () { S.render(); });
      });
    }).catch(function (e) { toast(e.message, true); if (btn) { btn.disabled = false; btn.textContent = 'Check-in'; } });
  }

  function checkoutModal(el, day, v) {
    var sold = db().sales.some(function (s) { return s.userId === db().me.id && s.clientId === v.clientId && s.status !== 'anulada' && s.date >= v.checkIn.ts; });
    var sel = sold ? 'venta' : '', reason = '';
    var html = '<div class="checkout"><p class="muted">¿Cómo terminó la visita a <b>' + esc(v.clientName) + '</b>?</p>' +
      '<div class="res-grid">' + RESULTS.map(function (r) { return '<button type="button" class="res' + (r.v === sel ? ' on' : '') + '" data-r="' + r.v + '">' + esc(r.t) + '</button>'; }).join('') + '</div>' +
      '<div id="whyBox" hidden><p class="small"><b>¿Por qué no compró?</b></p><div class="chips">' + REASONS.map(function (x) { return '<button type="button" class="chip" data-why="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div></div>' +
      '<label class="f full">Nota de la visita (opcional)<textarea id="vNote" rows="3" placeholder="Qué se habló, qué pidió, cuándo volver…"></textarea></label>' +
      '<div class="foot"><button class="btn" data-close>Volver</button><button class="btn primary" id="vSave"' + (sel ? '' : ' disabled') + '>Cerrar visita</button></div></div>';
    S.openModal('Terminar visita', html, function (m) {
      function upd() {
        $$('.res', m).forEach(function (b) { b.classList.toggle('on', b.dataset.r === sel); });
        $$('.chip', m).forEach(function (b) { b.classList.toggle('on', b.dataset.why === reason); });
        $('#whyBox', m).hidden = sel !== 'no_compra';
        $('#vSave', m).disabled = !sel;
      }
      m.addEventListener('click', function (e) {
        var r = e.target.closest('[data-r]'), w = e.target.closest('[data-why]');
        if (r) { sel = r.dataset.r; if (sel !== 'no_compra') reason = ''; upd(); }
        if (w) { reason = reason === w.dataset.why ? '' : w.dataset.why; upd(); }
      });
      upd();
      $('#vSave', m).addEventListener('click', function () {
        var b = this; b.disabled = true; b.textContent = 'Guardando…';
        var note = $('#vNote', m).value;
        // la posición de salida es informativa: si tarda, se cierra sin ella
        Promise.race([getPos(), new Promise(function (r) { setTimeout(function () { r(null); }, 6000); })]).then(function (p) {
          var body = { result: sel, reason: reason, note: note, deviceTs: new Date().toISOString() };
          if (p) { body.lat = p.lat; body.lng = p.lng; body.accuracy = p.accuracy; }
          return api('POST', '/visits/' + v.id + '/checkout', body);
        }).then(function () {
          S.closeModal(); toast('Visita cerrada: ' + RESULT_NAME[sel]);
          return S.refresh().then(function () { S.render(); });
        }).catch(function (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Cerrar visita'; });
      });
    });
  }

  function pickClient(onPick) {
    var list = db().clients.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    S.openModal('Visita fuera de ruta', '<input type="search" id="pcq" class="full-input" placeholder="Buscar comercio por nombre, RUT o dirección…" autocomplete="off"><div id="pcl" class="pick-list"></div>', function (m) {
      function draw() {
        var q = $('#pcq', m).value.toLowerCase();
        var f = list.filter(function (c) { return !q || (c.name + ' ' + c.doc + ' ' + c.address).toLowerCase().indexOf(q) >= 0; }).slice(0, 60);
        $('#pcl', m).innerHTML = f.length ? f.map(function (c) {
          var d = lastPos && hasGeo(c) ? ' · a ' + fmtDist(distanceM(lastPos, c)) : '';
          return '<button type="button" class="pick" data-c="' + c.id + '"><b>' + esc(c.name) + '</b><span class="muted small">' + esc(c.address || '') + d + '</span></button>';
        }).join('') : '<p class="muted">No hay clientes con ese nombre' + (isBoss() ? '' : ' asignados a vos') + '.</p>';
      }
      $('#pcq', m).addEventListener('input', draw);
      $('#pcl', m).addEventListener('click', function (e) { var b = e.target.closest('[data-c]'); if (b) { S.closeModal(); onPick(byId(db().clients, b.dataset.c)); } });
      draw(); $('#pcq', m).focus();
    });
  }

  // Después de vender durante una visita, volver a la visita para cerrarla.
  S.afterSale = function (sale, withReceipt) {
    var open = hoyState.visits.filter(function (v) { return !v.checkOut && v.clientId === sale.clientId && v.sellerId === db().me.id; })[0];
    if (!open || withReceipt) return;
    setTimeout(function () { location.hash = '#/hoy'; }, 600);
  };

  // ======================================================================
  // RUTAS: el supervisor arma la ruta de cada vendedor por día
  // ======================================================================
  var rutaSel = { sellerId: '', date: '' };
  S.views.rutas = function (el) {
    if (!isBoss()) { el.innerHTML = '<div class="card empty">Solo supervisores y administradores.</div>'; return; }
    var users = teamUsers();
    if (!rutaSel.sellerId || !byId(users, rutaSel.sellerId)) rutaSel.sellerId = (users.filter(function (u) { return u.role === 'vendedor'; })[0] || users[0]).id;
    if (!rutaSel.date) rutaSel.date = today();
    var stops = [], dirty = false, scopeAll = false, weekRoutes = [];

    el.innerHTML = '<div class="head"><h1>Rutas</h1><div class="actions">' +
      '<select id="rSeller">' + users.map(function (u) { return '<option value="' + u.id + '"' + (u.id === rutaSel.sellerId ? ' selected' : '') + '>' + esc(u.name) + ' (' + S.ROLE_NAMES[u.role] + ')</option>'; }).join('') + '</select>' +
      '<input type="date" id="rDate" value="' + rutaSel.date + '"></div></div>' +
      '<div class="week" id="week"></div>' +
      '<div class="rutas">' +
      '<div class="card"><h2>Clientes</h2><div class="toolbar"><input type="search" id="cq" placeholder="Buscar cliente o dirección…">' +
      '<select id="cscope"><option value="">Asignados a este vendedor</option><option value="all">Todos los de mi equipo</option></select>' +
      '<select id="csort"><option value="name">Por nombre</option><option value="last">Sin comprar hace más tiempo</option><option value="debt">Con saldo pendiente</option></select></div>' +
      '<div id="clist" class="pick-list tall"></div></div>' +
      '<div class="card"><div class="head" style="margin-bottom:8px"><h2 style="margin:0" id="rTitle"></h2>' +
      '<div class="actions"><button class="btn sm" id="rNear">Ordenar por cercanía</button><button class="btn sm" id="rMap">🗺️ Mapa</button></div></div>' +
      '<div class="map-box" id="rMapBox" hidden></div>' +
      '<ol id="rstops" class="stops edit"></ol>' +
      '<div class="rfoot"><label class="small">Repetir<select id="rRepeat"><option value="0">solo este día</option>' +
      [1, 2, 3, 4, 8, 12].map(function (n) { return '<option value="' + n + '">y los próximos ' + n + ' ' + DAYS[new Date(rutaSel.date + 'T12:00:00').getDay()] + (n > 1 ? 's' : '') + '</option>'; }).join('') + '</select></label>' +
      '<label class="small">Copiar de<input type="date" id="rFrom"></label><button class="btn sm" id="rCopy">Copiar</button>' +
      '<span class="grow"></span><button class="btn" id="rClear">Vaciar</button><button class="btn primary" id="rSave">Guardar ruta</button></div></div>' +
      '</div>';

    function lastBuy(c) { var d = ''; db().sales.forEach(function (s) { if (s.clientId === c.id && s.status !== 'anulada' && s.date > d) d = s.date; }); return d; }
    function debtOf(c) { return db().sales.filter(function (s) { return s.clientId === c.id && s.status === 'pendiente'; }).reduce(function (a, s) { return a + s.total; }, 0); }
    function drawClients() {
      var q = $('#cq', el).value.toLowerCase(), sort = $('#csort', el).value;
      var list = db().clients.filter(function (c) {
        return (scopeAll || c.sellerId === rutaSel.sellerId) && stops.indexOf(c.id) < 0 && (!q || (c.name + ' ' + c.address + ' ' + c.doc).toLowerCase().indexOf(q) >= 0) && (sort !== 'debt' || debtOf(c) > 0);
      }).map(function (c) { return { c: c, last: lastBuy(c) }; });
      list.sort(sort === 'last' ? function (a, b) { return a.last.localeCompare(b.last) || a.c.name.localeCompare(b.c.name); } : function (a, b) { return a.c.name.localeCompare(b.c.name); });
      var mine = db().clients.filter(function (c) { return c.sellerId === rutaSel.sellerId; }).length;
      $('#clist', el).innerHTML = (list.length ? list.slice(0, 150).map(function (x) {
        var days = x.last ? Math.floor((Date.now() - Date.parse(x.last)) / 864e5) : null;
        return '<button type="button" class="pick" data-add="' + x.c.id + '"><b>' + esc(x.c.name) + '</b><span class="muted small">' + esc(x.c.address || 'Sin dirección') +
          ' · ' + (days == null ? 'nunca compró' : 'última compra hace ' + days + ' d') + (hasGeo(x.c) ? '' : ' · sin ubicar') + '</span><span class="add">+</span></button>';
      }).join('') + (list.length > 150 ? '<p class="muted small">Mostrando 150 de ' + list.length + '. Buscá para afinar.</p>' : '')
        : '<p class="muted small">' + (!scopeAll && !mine ? 'Este vendedor no tiene clientes asignados. Asignáselos en Clientes o elegí “Todos los de mi equipo”.' : 'No hay más clientes con ese filtro.') + '</p>');
    }
    function drawStops() {
      var u = byId(users, rutaSel.sellerId);
      $('#rTitle', el).textContent = 'Ruta de ' + (u ? u.name : '') + ' · ' + longDay(rutaSel.date) + ' (' + stops.length + ')' + (dirty ? ' · sin guardar' : '');
      $('#rstops', el).innerHTML = stops.length ? stops.map(function (id, i) {
        var c = byId(db().clients, id) || { name: '(cliente no disponible)' };
        return '<li class="stop"><span class="n">' + (i + 1) + '</span><div class="stop-main"><b>' + esc(c.name) + '</b><span class="muted small">' + esc(c.address || '') + (hasGeo(c) ? '' : ' · sin ubicar') + '</span></div>' +
          '<div class="stop-act"><button class="btn sm" data-up="' + i + '" aria-label="Subir"' + (i ? '' : ' disabled') + '>↑</button><button class="btn sm" data-down="' + i + '" aria-label="Bajar"' + (i < stops.length - 1 ? '' : ' disabled') + '>↓</button><button class="btn sm danger" data-rm="' + i + '" aria-label="Quitar">✕</button></div></li>';
      }).join('') : '<li class="muted small" style="list-style:none">Tocá un cliente de la izquierda para agregarlo a la ruta.</li>';
      $('#rSave', el).disabled = !dirty;
    }
    function drawWeek() {
      var d0 = new Date(rutaSel.date + 'T12:00:00'), monday = addDays(rutaSel.date, -((d0.getDay() + 6) % 7));
      var cells = [];
      for (var i = 0; i < 7; i++) {
        var k = addDays(monday, i), r = weekRoutes.filter(function (x) { return x.date === k && x.sellerId === rutaSel.sellerId; })[0];
        cells.push('<button type="button" class="wday' + (k === rutaSel.date ? ' on' : '') + (k === today() ? ' today' : '') + '" data-day="' + k + '"><span>' + DAYS[new Date(k + 'T12:00:00').getDay()].slice(0, 3) + ' ' + k.slice(8) + '</span><b>' + (r ? r.stops.length : '—') + '</b></button>');
      }
      $('#week', el).innerHTML = '<button type="button" class="wnav" data-day="' + addDays(monday, -7) + '">‹</button>' + cells.join('') + '<button type="button" class="wnav" data-day="' + addDays(monday, 7) + '">›</button>';
    }
    function load() {
      var d0 = new Date(rutaSel.date + 'T12:00:00'), monday = addDays(rutaSel.date, -((d0.getDay() + 6) % 7));
      api('GET', '/routes?from=' + monday + '&to=' + addDays(monday, 6)).then(function (list) {
        weekRoutes = list;
        var r = list.filter(function (x) { return x.date === rutaSel.date && x.sellerId === rutaSel.sellerId; })[0];
        stops = r ? r.stops.map(function (s) { return s.clientId; }) : [];
        dirty = false; drawStops(); drawClients(); drawWeek();
      }, function (e) { toast(e.message, true); });
    }
    function leaveOk() { return !dirty || confirm('La ruta tiene cambios sin guardar. ¿Descartarlos?'); }
    function go(sellerId, date) {
      if (!leaveOk()) { $('#rSeller', el).value = rutaSel.sellerId; $('#rDate', el).value = rutaSel.date; return; }
      var repaint = date !== rutaSel.date;
      rutaSel.sellerId = sellerId; rutaSel.date = date;
      if (repaint) { S.views.rutas(el); return; } // los textos de “repetir” dependen del día
      $('#rMapBox', el).hidden = true; load();
    }

    $('#rSeller', el).addEventListener('change', function () { go(this.value, rutaSel.date); });
    $('#rDate', el).addEventListener('change', function () { if (this.value) go(rutaSel.sellerId, this.value); });
    $('#week', el).addEventListener('click', function (e) { var b = e.target.closest('[data-day]'); if (b) go(rutaSel.sellerId, b.dataset.day); });
    $('#cq', el).addEventListener('input', drawClients);
    $('#csort', el).addEventListener('change', drawClients);
    $('#cscope', el).addEventListener('change', function () { scopeAll = this.value === 'all'; drawClients(); });
    $('#clist', el).addEventListener('click', function (e) { var b = e.target.closest('[data-add]'); if (!b) return; stops.push(b.dataset.add); dirty = true; drawStops(); drawClients(); });
    $('#rstops', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var i;
      if (b.dataset.rm != null) { stops.splice(+b.dataset.rm, 1); }
      else if (b.dataset.up != null) { i = +b.dataset.up; stops.splice(i - 1, 0, stops.splice(i, 1)[0]); }
      else if (b.dataset.down != null) { i = +b.dataset.down; stops.splice(i + 1, 0, stops.splice(i, 1)[0]); }
      else return;
      dirty = true; drawStops(); drawClients();
    });
    $('#rNear', el).addEventListener('click', function () {
      // vecino más cercano desde la primera parada con ubicación; las que no tienen ubicación quedan al final
      var withG = stops.filter(function (id) { return hasGeo(byId(db().clients, id)); }), without = stops.filter(function (id) { return withG.indexOf(id) < 0; });
      if (withG.length < 2) return toast('Hacen falta al menos 2 clientes ubicados en el mapa.', true);
      var out = [withG.shift()];
      while (withG.length) {
        var cur = byId(db().clients, out[out.length - 1]), best = 0, bd = Infinity;
        withG.forEach(function (id, j) { var d = distanceM(cur, byId(db().clients, id)); if (d < bd) { bd = d; best = j; } });
        out.push(withG.splice(best, 1)[0]);
      }
      stops = out.concat(without); dirty = true; drawStops();
      if (without.length) toast(without.length + ' sin ubicar quedaron al final');
    });
    $('#rMap', el).addEventListener('click', function () {
      var box = $('#rMapBox', el); box.hidden = !box.hidden; if (box.hidden) return;
      drawMap(box, stops.map(function (id, i) { var c = byId(db().clients, id) || {}; return { lat: c.lat, lng: c.lng, n: i + 1, label: '<b>' + esc(c.name) + '</b><br>' + esc(c.address || '') }; }), { line: true });
    });
    $('#rCopy', el).addEventListener('click', function () {
      var from = $('#rFrom', el).value; if (!from) return toast('Elegí de qué día copiar', true);
      api('GET', '/routes?date=' + from).then(function (list) {
        var r = list.filter(function (x) { return x.sellerId === rutaSel.sellerId; })[0];
        if (!r) return toast('Ese día no tiene ruta para este vendedor', true);
        stops = r.stops.map(function (s) { return s.clientId; }); dirty = true; drawStops(); drawClients();
        toast('Copiadas ' + stops.length + ' visitas: revisá y guardá');
      }, function (e) { toast(e.message, true); });
    });
    $('#rClear', el).addEventListener('click', function () { if (stops.length && confirm('¿Quitar todas las visitas de este día?')) { stops = []; dirty = true; drawStops(); drawClients(); } });
    $('#rSave', el).addEventListener('click', function () {
      var b = this, weeks = +$('#rRepeat', el).value; b.disabled = true;
      api('PUT', '/routes', { sellerId: rutaSel.sellerId, date: rutaSel.date, stops: stops, repeatWeeks: weeks }).then(function (r) {
        toast(stops.length ? 'Ruta guardada' + (r.dates.length > 1 ? ' para ' + r.dates.length + ' días' : '') : 'Ruta borrada');
        dirty = false; load();
      }, function (e) { toast(e.message, true); b.disabled = false; });
    });
    load();
  };

  // ======================================================================
  // JORNADA: resumen del día por vendedor (programadas vs. realizadas, GPS, resultados, ventas)
  // ======================================================================
  var jorSel = { date: '', sellerId: '' }, jorTimer = null;
  S.views.jornada = function (el) {
    if (!isBoss()) { el.innerHTML = '<div class="card empty">Solo supervisores y administradores.</div>'; return; }
    if (!jorSel.date) jorSel.date = today();
    el.innerHTML = '<div class="head"><h1>Jornada</h1><div class="actions"><input type="date" id="jDate" value="' + jorSel.date + '"><button class="btn" id="jRef">Actualizar</button></div></div><div id="jBody"><div class="loading">Cargando…</div></div>';
    $('#jDate', el).addEventListener('change', function () { if (this.value) { jorSel.date = this.value; jorSel.sellerId = ''; load(); } });
    $('#jRef', el).addEventListener('click', function () { S.refresh().then(load); });
    function load() {
      var d = jorSel.date;
      Promise.all([api('GET', '/routes?date=' + d), api('GET', '/visits?from=' + d)]).then(function (r) { if (alive(el, 'jornada')) drawJornada($('#jBody', el), d, r[0], r[1], load); },
        function (e) { $('#jBody', el).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    }
    load();
    clearInterval(jorTimer);
    jorTimer = setInterval(function () {
      if (!alive(el, 'jornada')) return clearInterval(jorTimer);
      if (jorSel.date === today() && !document.hidden && !$('#modal-root').innerHTML) S.refresh().then(load);
    }, 60000);
  };

  function drawJornada(box, day, routes, visits, reload) {
    var sales = db().sales.filter(function (s) { return s.status !== 'anulada' && S.dayKey(s.date) === day; });
    var ids = {};
    teamUsers().forEach(function (u) { ids[u.id] = u.name; });
    routes.forEach(function (r) { ids[r.sellerId] = ids[r.sellerId] || r.sellerName; });
    visits.forEach(function (v) { ids[v.sellerId] = ids[v.sellerId] || v.sellerName; });
    var rows = Object.keys(ids).map(function (uid) {
      var r = routes.filter(function (x) { return x.sellerId === uid; })[0], vs = visits.filter(function (v) { return v.sellerId === uid; });
      var plan = r ? r.stops.map(function (s) { return s.clientId; }) : [];
      var done = plan.filter(function (cid) { return vs.some(function (v) { return v.clientId === cid; }); }).length;
      var my = sales.filter(function (s) { return s.userId === uid; });
      var alerts = vs.filter(function (v) { return v.gpsStatus !== 'ok'; }).length;
      var sold = vs.filter(function (v) { return v.result === 'venta'; }).length;
      var times = vs.map(function (v) { return v.checkIn.ts; }).sort();
      return {
        id: uid, name: ids[uid], plan: plan, planned: plan.length, done: done, off: vs.filter(function (v) { return plan.indexOf(v.clientId) < 0; }).length, visits: vs,
        gpsOk: vs.filter(function (v) { return v.gpsStatus === 'ok'; }).length, alerts: alerts, notes: vs.filter(function (v) { return v.note; }).length,
        sold: sold, eff: vs.length ? Math.round(sold / vs.length * 100) : null, total: my.reduce(function (a, s) { return a + s.total; }, 0), nSales: my.length,
        first: times[0], last: times[times.length - 1], open: vs.some(function (v) { return !v.checkOut; })
      };
    }).filter(function (x) { return x.planned || x.visits.length || x.nSales; }).sort(function (a, b) { return a.name.localeCompare(b.name); });

    var sum = function (k) { return rows.reduce(function (a, x) { return a + x[k]; }, 0); };
    box.innerHTML = '<div class="grid kpis">' +
      '<div class="card kpi accent"><span>Visitas programadas realizadas</span><b>' + sum('done') + ' de ' + sum('planned') + '</b></div>' +
      '<div class="card kpi"><span>Visitas con GPS validado</span><b>' + sum('gpsOk') + ' de ' + rows.reduce(function (a, x) { return a + x.visits.length; }, 0) + '</b><span class="muted small">' + sum('alerts') + ' con alerta</span></div>' +
      '<div class="card kpi"><span>Ventas del día</span><b>' + money(sum('total')) + '</b><span class="muted small">' + sum('nSales') + ' ventas</span></div>' +
      '<div class="card kpi"><span>Notas de visita</span><b>' + sum('notes') + '</b></div></div>' +
      (rows.length ? '<div class="tbl-wrap" style="margin-top:16px"><table class="jor"><thead><tr><th>Vendedor</th><th class="num">Programadas</th><th class="num">Realizadas</th><th class="num">Fuera de ruta</th><th class="num">GPS ok</th><th class="num">Alertas GPS</th><th class="num">Efectividad</th><th class="num">Ventas</th><th>Horario</th><th></th></tr></thead><tbody>' +
        rows.map(function (x) {
          var pct = x.planned ? Math.round(x.done / x.planned * 100) : null;
          return '<tr class="' + (x.id === jorSel.sellerId ? 'sel' : '') + '"><td><b>' + esc(x.name) + '</b>' + (x.open ? ' <span class="pill pendiente">en visita</span>' : '') + '</td><td class="num">' + x.planned + '</td>' +
            '<td class="num">' + x.done + (pct != null ? ' <span class="muted small">(' + pct + '%)</span>' : '') + '</td><td class="num">' + x.off + '</td><td class="num">' + x.gpsOk + '</td>' +
            '<td class="num">' + (x.alerts ? '<span class="pill anulada">' + x.alerts + '</span>' : '0') + '</td><td class="num">' + (x.eff == null ? '—' : x.eff + '%') + '</td>' +
            '<td class="num">' + money(x.total) + ' <span class="muted small">(' + x.nSales + ')</span></td><td class="small">' + (x.first ? hhmm(x.first) + '–' + hhmm(x.last) : '—') + '</td>' +
            '<td><button class="btn sm" data-det="' + x.id + '">Ver detalle</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty" style="margin-top:16px">No hay rutas, visitas ni ventas para ' + longDay(day) + '.</div>') +
      '<div id="jDet"></div>';

    function detail(uid) {
      jorSel.sellerId = uid;
      $$('tr.sel', box).forEach(function (t) { t.classList.remove('sel'); });
      var btn = $('[data-det="' + uid + '"]', box); if (btn) btn.closest('tr').classList.add('sel');
      var x = rows.filter(function (r) { return r.id === uid; })[0]; if (!x) return;
      var vs = x.visits.slice().sort(function (a, b) { return a.checkIn.ts.localeCompare(b.checkIn.ts); });
      var missing = x.plan.filter(function (cid) { return !vs.some(function (v) { return v.clientId === cid; }); });
      var det = $('#jDet', box);
      det.innerHTML = '<div class="card" style="margin-top:16px"><h2>' + esc(x.name) + ' · ' + longDay(day) + '</h2>' +
        '<div class="map-box" id="jMap"></div>' +
        '<p class="small muted"><span class="dot green"></span> GPS ok <span class="dot red"></span> alerta GPS <span class="dot gray"></span> programada sin visitar · El número es el orden de la visita.</p>' +
        (vs.length ? '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Hora</th><th>Comercio</th><th>Resultado</th><th>Nota</th><th>GPS</th><th></th></tr></thead><tbody>' + vs.map(function (v, i) {
          var mins = v.checkOut ? Math.max(1, Math.round((Date.parse(v.checkOut.ts) - Date.parse(v.checkIn.ts)) / 60000)) : null;
          var canFix = (v.gpsStatus === 'lejos' || v.gpsStatus === 'sin_referencia' || v.gpsStatus === 'baja_precision') && typeof v.checkIn.lat === 'number';
          return '<tr><td>' + (i + 1) + '</td><td class="small">' + hhmm(v.checkIn.ts) + (v.checkOut ? '–' + hhmm(v.checkOut.ts) + '<br><span class="muted">' + mins + ' min</span>' : '<br><b>en visita</b>') + '</td>' +
            '<td><b>' + esc(v.clientName) + '</b>' + (v.routeId ? '' : ' <span class="pill">fuera de ruta</span>') + '</td>' +
            '<td>' + (v.checkOut ? resultPill(v.result) : '—') + (v.reason ? '<div class="small muted">' + esc(v.reason) + '</div>' : '') + (v.saleIds && v.saleIds.length ? '<div class="small">' + v.saleIds.length + ' venta(s)</div>' : '') + '</td>' +
            '<td class="small note-cell">' + esc(v.note || '') + '</td><td>' + gpsPill(v) + (v.checkIn.accuracy != null ? '<div class="small muted">±' + v.checkIn.accuracy + ' m</div>' : '') + (v.located ? '<div class="small ok-t">ubicó el comercio</div>' : '') + '</td>' +
            '<td>' + (canFix ? '<button class="btn sm" data-fix="' + v.id + '" title="Si el comercio realmente está donde hizo check-in">Usar como ubicación del comercio</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No registró visitas.</p>') +
        (missing.length ? '<h3>Programadas sin visitar (' + missing.length + ')</h3><ul class="plain">' + missing.map(function (cid) { var c = byId(db().clients, cid); return '<li>' + esc(c ? c.name : cid) + (c && c.address ? ' <span class="muted small">' + esc(c.address) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
        '</div>';
      var pts = [];
      vs.forEach(function (v, i) { if (typeof v.checkIn.lat === 'number') pts.push({ lat: v.checkIn.lat, lng: v.checkIn.lng, n: i + 1, color: v.gpsStatus === 'ok' ? 'green' : 'red', label: '<b>' + (i + 1) + '. ' + esc(v.clientName) + '</b><br>' + hhmm(v.checkIn.ts) + ' · ' + esc((GPS[v.gpsStatus] || [''])[0]) }); });
      missing.forEach(function (cid) { var c = byId(db().clients, cid); if (hasGeo(c)) pts.push({ lat: c.lat, lng: c.lng, n: '', color: 'gray', label: '<b>' + esc(c.name) + '</b><br>sin visitar' }); });
      drawMap($('#jMap', det), pts, {});
      $$('[data-fix]', det).forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('¿Guardar la ubicación de este check-in como la ubicación del comercio? Las próximas visitas se validan contra este punto.')) return;
          b.disabled = true;
          api('POST', '/visits/' + b.dataset.fix + '/use-location', {}).then(function () { toast('Ubicación del comercio actualizada'); return S.refresh(); }).then(reload, function (e) { toast(e.message, true); b.disabled = false; });
        });
      });
      det.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $$('[data-det]', box).forEach(function (b) { b.addEventListener('click', function () { detail(b.dataset.det); }); });
    if (jorSel.sellerId && rows.some(function (r) { return r.id === jorSel.sellerId; })) {
      var keep = window.scrollY; detail(jorSel.sellerId); window.scrollTo(0, keep);
    }
  }

  // ======================================================================
  // COMISIONES
  // ======================================================================
  var comMonth = '';
  S.views.comisiones = function (el) {
    if (!comMonth) comMonth = today().slice(0, 7);
    el.innerHTML = '<div class="head"><h1>Comisiones</h1><div class="actions"><input type="month" id="cm" value="' + comMonth + '">' + (isBoss() ? '<button class="btn" id="cExp">Exportar CSV</button>' : '') + '</div></div>' +
      '<p class="muted small">Se calculan sobre el <b>neto</b> (sin IVA y con el descuento aplicado) de las ventas <b>cobradas</b> en el mes: estado pagada o entregada, según la fecha de cobro. Las ventas pendientes de cobro todavía no suman.' +
      (isBoss() ? ' El supervisor cobra además un % sobre lo cobrado por los vendedores de sus zonas. Cada vendedor ve su comisión cuando la aprobás.' : ' Ves tu comisión cuando tu supervisor la aprueba.') + '</p><div id="cBody"><div class="loading">Cargando…</div></div>';
    var rows = [];
    function load() {
      api('GET', '/commissions?month=' + comMonth).then(function (r) { rows = r; if (alive(el, 'comisiones')) draw(); }, function (e) { $('#cBody', el).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    }
    function draw() {
      var b = $('#cBody', el);
      if (!isBoss()) {
        var x = rows[0], a = x && x.approval;
        b.innerHTML = a ? '<div class="grid kpis"><div class="card kpi accent"><span>Tu comisión de ' + monthName(comMonth) + '</span><b>' + money(a.total) + '</b></div>' +
          '<div class="card kpi"><span>Ventas cobradas (neto)</span><b>' + money(a.net) + '</b></div><div class="card kpi"><span>Porcentaje</span><b>' + a.pct + '%</b></div>' +
          '<div class="card kpi"><span>Aprobada por</span><b class="small-b">' + esc(a.approvedBy) + '</b><span class="muted small">' + S.fmtDateTime(a.approvedAt) + '</span></div></div>'
          : '<div class="card empty">Tu comisión de ' + monthName(comMonth) + ' todavía no fue aprobada por tu supervisor.</div>';
        return;
      }
      var tot = rows.reduce(function (a, x) { return a + x.total; }, 0), appr = rows.filter(function (x) { return x.approval; }).length;
      b.innerHTML = '<div class="grid kpis"><div class="card kpi accent"><span>Comisiones de ' + monthName(comMonth) + '</span><b>' + money(tot) + '</b></div>' +
        '<div class="card kpi"><span>Ventas cobradas (neto)</span><b>' + money(rows.reduce(function (a, x) { return a + x.net; }, 0)) + '</b></div>' +
        '<div class="card kpi"><span>Pendiente de cobro (neto)</span><b>' + money(rows.reduce(function (a, x) { return a + x.pendingNet; }, 0)) + '</b><span class="muted small">suma cuando se cobre</span></div>' +
        '<div class="card kpi"><span>Aprobadas</span><b>' + appr + ' de ' + rows.length + '</b></div></div>' +
        '<div class="tbl-wrap" style="margin-top:16px"><table><thead><tr><th>Usuario</th><th class="num">Sus ventas cobradas</th><th class="num">De su equipo</th><th class="num">Total</th><th>Estado</th><th></th></tr></thead><tbody>' +
        rows.sort(function (a, b2) { return b2.total - a.total || a.name.localeCompare(b2.name); }).map(function (x) {
          var sup = x.role === 'supervisor';
          return '<tr><td><b>' + esc(x.name) + '</b><div class="small muted">' + S.ROLE_NAMES[x.role] + (sup ? ' · ' + x.teamSize + ' en su equipo' : '') + '</div></td>' +
            '<td class="num">' + money(x.commission) + '<div class="small muted">' + x.pct + '% de ' + money(x.net) + '</div>' + (x.pendingNet ? '<div class="small muted">+ ' + money(x.pendingNet) + ' sin cobrar</div>' : '') + '</td>' +
            '<td class="num">' + (sup ? money(x.teamCommission) + '<div class="small muted">' + x.teamPct + '% de ' + money(x.teamNet) + '</div>' : '—') + '</td>' +
            '<td class="num"><b>' + money(x.total) + '</b></td>' +
            '<td class="small">' + (x.approval ? '<span class="pill pagada">aprobada</span><div class="muted">' + esc(x.approval.approvedBy) + ' · ' + S.fmtDate(x.approval.approvedAt) + '</div>' +
              (x.changed ? '<div class="warn">Cambió desde la aprobación (era ' + money(x.approval.total) + ')</div>' : '') : '<span class="pill pendiente">sin aprobar</span>') + '</td>' +
            '<td>' + (x.canApprove ? (x.approval ? (x.changed ? '<button class="btn sm primary" data-ap="' + x.userId + '">Aprobar de nuevo</button>' : '') + '<button class="btn sm" data-unap="' + x.userId + '">Quitar</button>' : '<button class="btn sm primary" data-ap="' + x.userId + '">Aprobar</button>') : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (rows.some(function (x) { return !x.pct && !x.teamPct; }) ? '<p class="muted small">Los porcentajes se cargan en Configuración → Usuarios → Editar.</p>' : '');
      $$('[data-ap]', b).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var x = rows.filter(function (r) { return r.userId === btn.dataset.ap; })[0];
          if (!confirm('¿Aprobar la comisión de ' + x.name + ' de ' + monthName(comMonth) + ' por ' + money(x.total) + '? ' + (x.role === 'vendedor' ? 'La va a poder ver.' : ''))) return;
          btn.disabled = true;
          api('POST', '/commissions/approve', { userId: x.userId, month: comMonth }).then(function () { toast('Comisión aprobada'); load(); }, function (e) { toast(e.message, true); btn.disabled = false; });
        });
      });
      $$('[data-unap]', b).forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          api('DELETE', '/commissions/approve?month=' + comMonth + '&userId=' + encodeURIComponent(btn.dataset.unap)).then(function () { toast('Aprobación quitada'); load(); }, function (e) { toast(e.message, true); btn.disabled = false; });
        });
      });
    }
    $('#cm', el).addEventListener('change', function () { if (this.value) { comMonth = this.value; load(); } });
    var ex = $('#cExp', el);
    if (ex) ex.addEventListener('click', function () {
      S.csv('comisiones-' + comMonth + '.csv', [['Mes', 'Usuario', 'Rol', 'NetoCobrado', 'Pct', 'Comision', 'NetoEquipo', 'PctEquipo', 'ComisionEquipo', 'Total', 'Aprobada', 'AprobadaPor']].concat(rows.map(function (x) {
        return [comMonth, x.name, S.ROLE_NAMES[x.role], x.net, x.pct, x.commission, x.teamNet, x.teamPct, x.teamCommission, x.total, x.approval ? 'si' : 'no', x.approval ? x.approval.approvedBy : ''];
      })));
    });
    load();
  };
  function monthName(m) {
    var n = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
    return n[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
  }

  // ======================================================================
  // CONFIGURACIÓN (admin): zonas y ubicación de clientes
  // ======================================================================
  S.configExtra = function (box) {
    if (!box || !S.isAdmin()) return;
    var zones = db().zones || [], users = db().users;
    var cl = db().clients;
    var geo = { dir: 0, seller: 0, none: 0, noAddr: 0, failed: 0 };
    cl.forEach(function (c) {
      if (hasGeo(c)) { if (c.geoSource === 'direccion') geo.dir++; else geo.seller++; }
      else if (!c.address) geo.noAddr++; else if (c.geoFailed) geo.failed++; else geo.none++;
    });
    box.innerHTML = '<div class="grid half" style="margin-bottom:16px">' +
      '<div class="card"><div class="head" style="margin-bottom:10px"><h2 style="margin:0">Zonas</h2><button class="btn primary sm" id="zAdd">+ Nueva zona</button></div>' +
      '<p class="muted small">Cada zona tiene un supervisor. El supervisor ve, arma rutas y aprueba comisiones de los usuarios de sus zonas (la zona de cada vendedor se elige en Usuarios → Editar).</p>' +
      (zones.length ? '<div class="tbl-wrap"><table><thead><tr><th>Zona</th><th>Supervisor</th><th class="num">Usuarios</th><th></th></tr></thead><tbody>' + zones.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (z) {
        var s = byId(users, z.supervisorId);
        return '<tr><td><b>' + esc(z.name) + '</b></td><td>' + (s ? esc(s.name) : '<span class="muted">Sin supervisor</span>') + '</td><td class="num">' + users.filter(function (u) { return u.zoneId === z.id; }).length + '</td>' +
          '<td class="act"><button class="btn sm" data-zed="' + z.id + '">Editar</button><button class="btn sm danger" data-zdel="' + z.id + '">Borrar</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted">Todavía no hay zonas.</p>') + '</div>' +
      '<div class="card"><h2>Ubicación de clientes en el mapa</h2>' +
      '<p class="muted small">Se ubican de forma aproximada a partir de la dirección (OpenStreetMap). En la primera visita con buen GPS, la ubicación se corrige con la posición del vendedor.</p>' +
      '<ul class="plain small"><li><b>' + geo.seller + '</b> ubicados por GPS en una visita</li><li><b>' + geo.dir + '</b> ubicados por dirección (aproximado)</li>' +
      '<li><b>' + geo.none + '</b> con dirección, sin ubicar todavía</li><li><b>' + geo.failed + '</b> con dirección que no se encontró</li><li><b>' + geo.noAddr + '</b> sin dirección</li></ul>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn dark wrap" id="geoGo"' + (geo.none ? '' : ' disabled') + '>Ubicar ' + geo.none + ' clientes desde su dirección</button>' +
      (geo.failed ? '<button class="btn" id="geoRetry">Reintentar los no encontrados</button>' : '') + '</div><p class="small" id="geoSt"></p></div></div>';

    var zf = function () { return [{ name: 'name', label: 'Nombre de la zona', req: true, full: true }, { name: 'supervisorId', label: 'Supervisor', type: 'select', full: true, options: [{ v: '', t: 'Sin supervisor' }].concat(users.filter(function (u) { return u.role !== 'vendedor'; }).map(function (u) { return { v: u.id, t: u.name + ' (' + S.ROLE_NAMES[u.role] + ')' }; })) }]; };
    $('#zAdd', box).addEventListener('click', function () { S.formModal('Nueva zona', zf(), {}, function (o) { return S.act(api('POST', '/zones', o), 'Zona creada'); }); });
    $$('[data-zed]', box).forEach(function (b) { b.addEventListener('click', function () { var z = byId(zones, b.dataset.zed); S.formModal('Editar zona', zf(), z, function (o) { return S.act(api('PUT', '/zones/' + z.id, o), 'Zona actualizada'); }); }); });
    $$('[data-zdel]', box).forEach(function (b) { b.addEventListener('click', function () { var z = byId(zones, b.dataset.zdel); if (confirm('¿Borrar la zona ' + z.name + '? Sus usuarios quedan sin zona.')) S.act(api('DELETE', '/zones/' + z.id), 'Zona borrada'); }); });

    function poll() {
      api('GET', '/geocode').then(function (st) {
        var p = $('#geoSt', box); if (!p || !p.isConnected) return;
        if (st.running) { p.textContent = 'Ubicando… ' + st.done + ' de ' + st.total + ' (' + st.ok + ' encontrados). Tarda ~1 segundo por cliente; podés seguir usando la app.'; setTimeout(poll, 3000); }
        else if (st.finishedAt) { p.textContent = 'Listo: ' + st.ok + ' ubicados, ' + st.failed + ' no encontrados.' + (st.error ? ' ' + st.error : ''); S.refresh(); }
      }, function () {});
    }
    function go(retry) {
      api('POST', '/geocode', { retryFailed: retry }).then(function () { $('#geoGo', box).disabled = true; poll(); }, function (e) { toast(e.message, true); });
    }
    $('#geoGo', box).addEventListener('click', function () { go(false); });
    var rt = $('#geoRetry', box); if (rt) rt.addEventListener('click', function () { go(true); });
    poll();
  };
})();
