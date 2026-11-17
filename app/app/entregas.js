/* SVC · Entregas: Logística (camiones, armar y guardar la ruta de cada camión por día y turno, estadísticas),
   Mis entregas (el chofer recorre su ruta, marca entregado y registra el cobro) y Avisos (para todos).
   Usa window.SVC (app.js) y SVC.geo (terreno.js). Servidor: server/entregas.js */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, $$ = S.$$, esc = S.esc, money = S.money, api = S.api, toast = S.toast, byId = S.byId;
  var db = function () { return S.db; };
  var G = function () { return S.geo; };
  var alive = function (el, v) { return el.isConnected && el.dataset.view === v; };
  var SH = function () { return S.SHIFT_NAMES; };
  var hasGeo = function (p) { return p && typeof p.lat === 'number' && typeof p.lng === 'number'; };
  var dist = function (a, b) { return G().distanceM(a, b); };
  var ROAD = 1.3; // las calles no son línea recta: estimación de km por calle
  var fmtKm = function (m) { return (m / 1000).toFixed(1).replace('.', ',') + ' km'; };
  var fmtMin = function (n) { return n >= 60 ? Math.floor(n / 60) + ' h ' + (n % 60) + ' min' : n + ' min'; };
  var dayLabel = function (d) { var x = new Date(d + 'T12:00:00'); return ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][x.getDay()] + ' ' + x.getDate() + '/' + (x.getMonth() + 1); };
  var mapsLink = function (st) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(hasGeo(st) ? st.lat + ',' + st.lng : (st.address || st.clientName)); };
  var telLink = function (p) { var d = String(p || '').split('/')[0].replace(/[^\d+]/g, ''); return d ? 'tel:' + d : ''; };
  var ROUTE_ST = { lista: ['lista: el chofer ya la tiene', 'pagada'], en_curso: ['en curso', 'pendiente'], terminada: ['terminada', ''] };

  // ======================================================================
  // RUTA ÓPTIMA: vecino más cercano desde el depósito + mejora 2-opt (distancia en línea recta)
  // ======================================================================
  function bestOrder(stops, depot) {
    var geo = stops.filter(hasGeo), sin = stops.filter(function (s) { return !hasGeo(s); });
    if (geo.length < 2) return geo.concat(sin);
    var start = hasGeo(depot) ? depot : null, left = geo.slice(), path = [];
    var cur = start || left.shift(); if (!start) path.push(cur);
    while (left.length) {
      var bi = 0, bd = Infinity;
      for (var i = 0; i < left.length; i++) { var d = dist(cur, left[i]); if (d < bd) { bd = d; bi = i; } }
      cur = left.splice(bi, 1)[0]; path.push(cur);
    }
    var pts = start ? [start].concat(path) : path, n = pts.length, improved = true, guard = 0;
    var D = function (a, b) { return dist(pts[a], pts[b]); };
    while (improved && guard++ < 60) {
      improved = false;
      for (var a = start ? 0 : 0; a < n - 2; a++) {
        for (var b = a + 2; b < n; b++) {
          var c = b + 1 < n ? b + 1 : -1;
          var before = D(a, a + 1) + (c >= 0 ? D(b, c) : 0), after = D(a, b) + (c >= 0 ? D(a + 1, c) : 0);
          if (after + 0.5 < before) { var seg = pts.slice(a + 1, b + 1).reverse(); Array.prototype.splice.apply(pts, [a + 1, seg.length].concat(seg)); improved = true; }
        }
      }
    }
    return (start ? pts.slice(1) : pts).concat(sin);
  }
  function routeMeters(stops, depot, back) {
    var pts = (hasGeo(depot) ? [depot] : []).concat(stops.filter(hasGeo)), m = 0;
    for (var i = 1; i < pts.length; i++) m += dist(pts[i - 1], pts[i]);
    if (back && hasGeo(depot) && pts.length > 1) m += dist(pts[pts.length - 1], depot);
    return m * ROAD;
  }

  // ======================================================================
  // LOGÍSTICA
  // ======================================================================
  var L = { tab: 'plan', day: '', shift: 'manana', data: null, order: {}, from: '', to: '' };
  S.views.logistica = function (el) {
    if (['admin', 'logistica'].indexOf(db().me.role) < 0) { el.innerHTML = '<div class="card empty">Solo logística o un administrador.</div>'; return; }
    if (!L.day) L.day = S.nextWorkDay();
    el.innerHTML = '<div class="head"><h1>Logística</h1><div class="actions tabs">' +
      [['plan', '🚚 Entregas del día'], ['trucks', 'Camiones'], ['stats', 'Kilómetros y tiempos']].map(function (t) { return '<button class="btn' + (L.tab === t[0] ? ' primary' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') +
      '</div></div><div id="lgBody"><div class="card empty">Cargando…</div></div>';
    $$('[data-tab]', el).forEach(function (b) { b.addEventListener('click', function () { L.tab = b.dataset.tab; S.views.logistica(el); }); });
    if (L.tab === 'trucks') return trucksTab(el, $('#lgBody', el));
    if (L.tab === 'stats') return statsTab(el, $('#lgBody', el));
    planTab(el, $('#lgBody', el));
  };

  // ---------- entregas del día: agrupar por camión y cliente, ordenar, guardar ----------
  function planTab(el, box) {
    box.innerHTML = '<div class="toolbar"><input type="date" id="lgDay" value="' + L.day + '" aria-label="Día">' +
      '<select id="lgShift">' + Object.keys(SH()).map(function (k) { return '<option value="' + k + '"' + (k === L.shift ? ' selected' : '') + '>Turno ' + SH()[k].toLowerCase() + '</option>'; }).join('') + '</select>' +
      '<button class="btn" id="lgDepot">📍 Depósito</button><button class="btn primary" id="lgShip">+ Nuevo envío</button></div><div id="lgUp" class="chips"></div><div id="lgPlan"><div class="card empty">Cargando…</div></div>';
    $('#lgDay', box).addEventListener('change', function () { if (this.value) { L.day = this.value; L.order = {}; load(); } });
    $('#lgShift', box).addEventListener('change', function () { L.shift = this.value; L.order = {}; load(); });
    $('#lgDepot', box).addEventListener('click', function () { depotModal(function () { load(); }); });
    $('#lgShip', box).addEventListener('click', function () { shipmentModal(null, load); });
    function load() {
      api('GET', '/deliveries?day=' + L.day + '&shift=' + L.shift).then(function (d) { L.data = d; if (alive(el, 'logistica')) draw(); },
        function (e) { $('#lgPlan', box).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    }
    function draw() {
      var d = L.data, trucks = d.trucks.filter(function (t) { return t.active !== false; });
      // próximos días con entregas pendientes
      var up = Object.keys(d.upcoming).sort();
      $('#lgUp', box).innerHTML = up.length ? '<span class="muted small">Pendientes:</span> ' + up.map(function (k) {
        var p = k.split('|'); return '<button class="chip' + (p[0] === L.day && p[1] === L.shift ? ' on' : '') + '" data-up="' + k + '">' + esc(dayLabel(p[0])) + ' · ' + esc(SH()[p[1]].toLowerCase()) + ' <b>' + d.upcoming[k] + '</b></button>';
      }).join('') : '';
      $$('[data-up]', box).forEach(function (b) { b.addEventListener('click', function () { var p = b.dataset.up.split('|'); L.day = p[0]; L.shift = p[1]; L.order = {}; planTab(el, box); }); });
      if (!$('#lgDepot', box).dataset.set) $('#lgDepot', box).textContent = d.depot ? '📍 Depósito ✓' : '📍 Fijar depósito';
      // paradas: una por cliente y camión
      var clients = {}; d.clients.forEach(function (c) { clients[c.id] = c; });
      var groups = {}; // truckId|'' -> {clientId -> stop}
      var done = [];
      d.sales.forEach(function (s) {
        var del = s.delivery;
        var tid = del.truckId && byId(d.trucks, del.truckId) ? del.truckId : '';
        if (del.status === 'entregada' || del.status === 'no_entregada') { done.push(s); return; }
        // una parada por cliente; las de Consumidor final, una por venta (cada una con su dirección)
        var key = s.clientId || 'v' + s.id;
        var g = groups[tid] = groups[tid] || {}, c = clients[s.clientId] || {};
        var st = g[key] = g[key] || { key: key, clientId: s.clientId, clientName: s.clientName, address: s.deliveryAddress || c.address || '', phone: s.deliveryPhone || c.phone || '', contact: s.deliveryContact || '', lat: c.lat, lng: c.lng, saleIds: [], docs: [], due: 0, items: 0, sellers: {}, status: del.status, day: del.day, shift: del.shift, truckId: tid };
        st.saleIds.push(s.id); st.docs.push(s); st.due += s.due || 0; st.items += s.items.reduce(function (a, it) { return a + it.qty; }, 0);
        if (s.kind !== 'envio') st.sellers[s.userName || ''] = 1;
        if (!st.contact && s.deliveryContact) st.contact = s.deliveryContact;
        if (del.status === 'en_ruta') st.status = 'en_ruta';
      });
      var routeOf = function (tid) { return d.routes.filter(function (r) { return r.truckId === tid; })[0]; };
      var ordered = function (tid) {
        var list = Object.keys(groups[tid] || {}).map(function (k) { return groups[tid][k]; });
        var ord = L.order[tid] || ((routeOf(tid) || {}).stops || []).map(function (s) { return s.clientId || 'v' + s.saleIds[0]; });
        list.sort(function (a, b) { var ia = ord.indexOf(a.key), ib = ord.indexOf(b.key); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.clientName.localeCompare(b.clientName); });
        return list;
      };
      var truckOpts = function (cur) { return '<option value="">Sin camión</option>' + trucks.map(function (t) { return '<option value="' + t.id + '"' + (t.id === cur ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join(''); };
      var stopRow = function (st, i, tid, locked) {
        var nv = st.docs.filter(function (x) { return x.kind !== 'envio'; }).length, ne = st.docs.length - nv, pk = packagesOf(st.docs);
        return '<div class="stop-row' + (hasGeo(st) ? '' : ' nogeo') + '"><span class="stop-n">' + (tid ? i + 1 : '•') + '</span><div class="stop-main"><b>' + esc(st.clientName) + '</b>' +
          '<div class="small muted">' + esc(st.address || 'Sin dirección') + (hasGeo(st) ? '' : ' · <span class="warn">sin ubicar en el mapa</span>') + '</div>' +
          '<div class="small">' + [nv ? nv + ' venta' + (nv > 1 ? 's' : '') + ' · ' + st.items + ' art.' : '', ne ? ne + ' envío' + (ne > 1 ? 's' : '') : ''].filter(Boolean).join(' · ') +
          (nv ? (st.due ? ' · cobrar <b>' + money(st.due) + '</b>' : ' · pago') : '') + (pk ? ' · <b>' + pk + ' bulto' + (pk > 1 ? 's' : '') + '</b>' : '') +
          (nv ? ' · <span class="muted">' + esc(Object.keys(st.sellers).filter(Boolean).join(', ')) + '</span>' : '') + '</div>' +
          st.docs.filter(function (x) { return x.kind === 'envio'; }).map(function (x) {
            return '<div class="small">📦 Envío E-' + x.number + (x.description ? ' · ' + esc(x.description) : '') + (locked ? '' : ' <button class="btn link" data-ship="' + x.id + '">Editar</button>') + '</div>';
          }).join('') + '</div>' +
          '<div class="stop-act"><button class="btn sm" data-lbl="' + tid + '|' + st.key + '" title="Etiquetas por bulto">🏷' + (pk ? ' ' + pk : '') + '</button>' +
          (locked ? '<span class="pill pendiente">' + (st.status === 'en_ruta' ? 'en camino' : '') + '</span></div>' :
            (tid ? '<button class="btn sm" data-up1="' + tid + '|' + i + '" title="Subir">↑</button><button class="btn sm" data-dn1="' + tid + '|' + i + '" title="Bajar">↓</button>' : '') + '</div>' +
            '<select data-mv="' + st.saleIds.join(',') + '" aria-label="Camión">' + truckOpts(tid) + '</select>') + '</div>';
      };
      var html = '';
      if (!trucks.length) html += '<div class="card empty">Todavía no hay camiones. Crealos en la pestaña <b>Camiones</b> (con su chofer).</div>';
      if (!d.depot) html += '<div class="card warn-card small">Fijá el <b>depósito</b> (de dónde salen los camiones) para que la mejor ruta empiece ahí.</div>';
      var free = ordered('');
      html += '<div class="lg-grid">';
      html += '<div class="card"><h2>Sin camión <span class="muted small">(' + free.length + ')</span></h2>' + (free.length ? free.map(function (st, i) { return stopRow(st, i, '', false); }).join('') : '<p class="muted small">Todas las entregas de este día y turno tienen camión.</p>') +
        '<div class="truck-act">' + (free.length && trucks.length ? '<button class="btn sm" id="lgAuto">Repartir entre camiones por cercanía</button>' : '') + (free.length ? '<button class="btn sm" data-lblt="">🏷 Etiquetas</button>' : '') + '</div></div>';
      trucks.forEach(function (t) {
        var rt = routeOf(t.id), list = ordered(t.id), locked = rt && rt.status !== 'lista';
        var drv = byId(db().users || [], t.driverId);
        var m = routeMeters(list, d.depot, true);
        html += '<div class="card truck-card"><div class="head" style="margin-bottom:6px"><h2 style="margin:0">' + esc(t.name) + (t.plate ? ' <span class="muted small">' + esc(t.plate) + '</span>' : '') + '</h2>' +
          (rt ? '<span class="pill ' + ROUTE_ST[rt.status][1] + '">' + ROUTE_ST[rt.status][0] + '</span>' : '<span class="pill">sin guardar</span>') + '</div>' +
          '<p class="small muted" style="margin:0 0 8px">Chofer: ' + (drv ? esc(drv.name) : '<span class="warn">sin chofer</span>') + ' · ' + list.length + ' parada' + (list.length === 1 ? '' : 's') + (m > 0 ? ' · ≈ ' + fmtKm(m) + ' (estimado, ida y vuelta)' : '') + '</p>' +
          (list.length ? list.map(function (st, i) { return stopRow(st, i, t.id, locked); }).join('') : '<p class="muted small">Sin entregas.</p>') +
          (list.length && !locked ? '<div class="truck-act"><button class="btn sm" data-opt="' + t.id + '">✨ Armar mejor ruta</button><button class="btn sm" data-map="' + t.id + '">🗺️ Mapa</button><button class="btn sm" data-lblt="' + t.id + '">🏷 Etiquetas</button>' +
            '<button class="btn sm primary" data-save="' + t.id + '">' + (rt ? 'Guardar cambios' : 'Guardar y enviar al chofer') + '</button></div>' : '') +
          (locked ? '<div class="truck-act"><button class="btn sm" data-map="' + t.id + '">🗺️ Mapa</button>' + (list.length ? '<button class="btn sm" data-lblt="' + t.id + '">🏷 Etiquetas</button>' : '') + '</div>' : '') +
          '<div class="map-box" id="lgMap-' + t.id + '" hidden></div></div>';
      });
      html += '</div>';
      if (done.length) html += '<div class="card"><h2>Ya cerradas <span class="muted small">(' + done.length + ')</span></h2>' + done.map(function (s) {
        return '<div class="small">' + (s.kind === 'envio' ? 'Envío E-' : 'N.º ') + s.number + ' · ' + esc(s.clientName) + ' ' + S.deliveryPill(s.delivery) + (s.delivery.failReason ? ' <span class="muted">' + esc(s.delivery.failReason) + '</span>' : '') + '</div>';
      }).join('') + '<p class="muted small">Las no entregadas se reprograman desde Ventas → Ver → Cambiar entrega.</p></div>';
      if (!d.sales.length) html = '<div class="card empty">No hay entregas para el ' + esc(dayLabel(L.day)) + ' (turno ' + esc(SH()[L.shift].toLowerCase()) + '). Se programan desde Ventas (columna Entrega) o con <b>+ Nuevo envío</b>.</div>' + html.replace(/<div class="lg-grid">[\s\S]*$/, '');
      $('#lgPlan', box).innerHTML = html;
      var P = $('#lgPlan', box);
      var truckName = function (tid) { var t = byId(d.trucks, tid); return t ? t.name : ''; };
      var toGroup = function (st) { return { clientName: st.clientName, address: st.address, contact: st.contact, phone: st.phone, day: L.day, shift: L.shift, truckName: truckName(st.truckId), docs: st.docs }; };
      $$('[data-lbl]', P).forEach(function (b) {
        b.addEventListener('click', function () { var p = b.dataset.lbl.split('|'); labelsModal([toGroup(groups[p[0]][p[1]])], draw); });
      });
      $$('[data-lblt]', P).forEach(function (b) {
        b.addEventListener('click', function () { labelsModal(ordered(b.dataset.lblt).map(toGroup), draw); });
      });
      $$('[data-ship]', P).forEach(function (b) { b.addEventListener('click', function () { shipmentModal(byId(d.sales, b.dataset.ship), load); }); });
      $$('[data-mv]', P).forEach(function (s) {
        s.addEventListener('change', function () {
          var ids = s.dataset.mv.split(','), tid = s.value; s.disabled = true;
          Promise.all(ids.map(function (id) { var sale = byId(d.sales, id); return api('PUT', '/sales/' + id + '/delivery', { day: sale.delivery.day, shift: sale.delivery.shift, truckId: tid }); }))
            .then(function () { toast(tid ? 'Pasada a ' + byId(trucks, tid).name : 'Quedó sin camión'); load(); }, function (e) { toast(e.message, true); load(); });
        });
      });
      var move = function (key, dir) {
        var p = key.split('|'), tid = p[0], i = +p[1], list = ordered(tid).map(function (s) { return s.key; }), j = i + dir;
        if (j < 0 || j >= list.length) return; var x = list[i]; list[i] = list[j]; list[j] = x; L.order[tid] = list; draw();
      };
      $$('[data-up1]', P).forEach(function (b) { b.addEventListener('click', function () { move(b.dataset.up1, -1); }); });
      $$('[data-dn1]', P).forEach(function (b) { b.addEventListener('click', function () { move(b.dataset.dn1, 1); }); });
      $$('[data-opt]', P).forEach(function (b) {
        b.addEventListener('click', function () {
          var tid = b.dataset.opt, before = routeMeters(ordered(tid), d.depot, true);
          L.order[tid] = bestOrder(ordered(tid), d.depot).map(function (s) { return s.key; });
          draw();
          var after = routeMeters(ordered(tid), d.depot, true), sin = ordered(tid).filter(function (s) { return !hasGeo(s); }).length;
          toast('Ruta ordenada: ≈ ' + fmtKm(after) + (before - after > 50 ? ' (antes ' + fmtKm(before) + ')' : '') + (sin ? ' · ' + sin + ' sin ubicar quedan al final' : ''));
          showMap(tid);
        });
      });
      $$('[data-map]', P).forEach(function (b) { b.addEventListener('click', function () { var mb = $('#lgMap-' + b.dataset.map, P); if (!mb.hidden) { mb.hidden = true; return; } showMap(b.dataset.map); }); });
      function showMap(tid) {
        var mb = $('#lgMap-' + tid, P); if (!mb) return; mb.hidden = false;
        var pts = ordered(tid).map(function (s, i) { return { lat: s.lat, lng: s.lng, n: i + 1, label: (i + 1) + '. ' + esc(s.clientName) + '<br>' + esc(s.address) }; });
        if (hasGeo(d.depot)) pts.unshift({ lat: d.depot.lat, lng: d.depot.lng, n: 'D', color: 'dark', label: 'Depósito' });
        G().drawMap(mb, pts, { line: true, empty: 'Ninguna de estas entregas tiene ubicación.' });
      }
      $$('[data-save]', P).forEach(function (b) {
        b.addEventListener('click', function () {
          var tid = b.dataset.save, t = byId(trucks, tid), list = ordered(tid);
          if (!t.driverId && !confirm(t.name + ' no tiene chofer asignado: la ruta se guarda pero nadie la recibe. ¿Seguir?')) return;
          b.disabled = true;
          api('POST', '/delivroutes', {
            truckId: tid, day: L.day, shift: L.shift, plannedKm: Math.round(routeMeters(list, d.depot, true) / 10) / 100,
            stops: list.map(function (s) { return { clientId: s.clientId, clientName: s.clientName, address: s.address, lat: s.lat, lng: s.lng, saleIds: s.saleIds }; })
          }).then(function () { toast('Ruta de ' + t.name + ' guardada' + (t.driverId ? ': el chofer ya la tiene' : '')); delete L.order[tid]; load(); }, function (e) { toast(e.message, true); b.disabled = false; });
        });
      });
      var auto = $('#lgAuto', P);
      if (auto) auto.addEventListener('click', function () {
        // cada entrega sin camión va al camión cuya ruta tenga la parada más cercana (o al que tenga menos paradas)
        var free2 = ordered(''); auto.disabled = true;
        var load2 = trucks.filter(function (t) { var rt = routeOf(t.id); return !rt || rt.status === 'lista'; }).map(function (t) { return { t: t, stops: ordered(t.id).slice() }; });
        if (!load2.length) { toast('No hay camiones con la ruta abierta.', true); return; }
        var jobs = [];
        free2.forEach(function (st) {
          var best = null, bd = Infinity;
          load2.forEach(function (x) {
            var near = x.stops.filter(hasGeo).concat(hasGeo(d.depot) ? [d.depot] : []);
            var dd = hasGeo(st) && near.length ? Math.min.apply(null, near.map(function (p) { return dist(st, p); })) : 0;
            dd += x.stops.length * 400; // equilibrar cantidad de paradas
            if (dd < bd) { bd = dd; best = x; }
          });
          best.stops.push(st);
          st.saleIds.forEach(function (id) { var sale = byId(d.sales, id); jobs.push(api('PUT', '/sales/' + id + '/delivery', { day: sale.delivery.day, shift: sale.delivery.shift, truckId: best.t.id })); });
        });
        Promise.all(jobs).then(function () { toast('Entregas repartidas. Revisá y tocá "Armar mejor ruta" en cada camión.'); load(); }, function (e) { toast(e.message, true); load(); });
      });
    }
    load();
  }
  function depotModal(after) {
    var dep = (L.data && L.data.depot) || db().settings.depot || null;
    S.openModal('Depósito', '<p class="muted small">Tocá en el mapa de dónde salen los camiones (o usá tu ubicación actual). La mejor ruta empieza y termina ahí.</p>' +
      '<div class="map-box" id="dpMap" style="height:340px"></div><p class="small" id="dpTxt">' + (dep ? 'Guardado: ' + dep.lat.toFixed(5) + ', ' + dep.lng.toFixed(5) : 'Sin depósito') + '</p>' +
      '<div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn" id="dpGps">Usar mi ubicación</button><button class="btn primary" id="dpSave" disabled>Guardar</button></div>', function (m) {
      var pick = null, mk = null;
      var set = function (lat, lng) { pick = { lat: lat, lng: lng }; $('#dpTxt', m).textContent = 'Nuevo: ' + lat.toFixed(5) + ', ' + lng.toFixed(5); $('#dpSave', m).disabled = false; if (mk) mk.setLatLng([lat, lng]); else if (map) mk = window.L.marker([lat, lng]).addTo(map); };
      var map = null;
      G().drawMap($('#dpMap', m), dep ? [{ lat: dep.lat, lng: dep.lng, n: 'D', color: 'dark', label: 'Depósito' }] : [], { empty: 'Tocá el mapa para marcar el depósito' }).then(function (mm) {
        map = mm; if (!map) return; map.scrollWheelZoom.enable();
        map.on('click', function (e) { set(e.latlng.lat, e.latlng.lng); });
      });
      $('#dpGps', m).addEventListener('click', function () {
        if (!navigator.geolocation) return toast('Este equipo no tiene GPS', true);
        navigator.geolocation.getCurrentPosition(function (p) { set(p.coords.latitude, p.coords.longitude); if (map) map.setView([p.coords.latitude, p.coords.longitude], 16); }, function () { toast('No se pudo leer la ubicación', true); }, { enableHighAccuracy: true, timeout: 15000 });
      });
      $('#dpSave', m).addEventListener('click', function () {
        api('PUT', '/deliveries/depot', pick).then(function (dp) { if (L.data) L.data.depot = dp; db().settings.depot = dp; S.closeModal(); toast('Depósito guardado'); after(); }, function (e) { toast(e.message, true); });
      });
    }, true);
  }

  // ---------- envío sin venta a un cliente registrado ----------
  var clientsCache = null;
  function shipmentModal(x, after) {
    var dl = (x && x.delivery) || {};
    (clientsCache ? Promise.resolve(clientsCache) : api('GET', '/shipments/clients')).then(function (cl) {
      clientsCache = cl;
      var trucks = ((L.data && L.data.trucks) || []).filter(function (t) { return t.active !== false; });
      var cur = x ? byId(cl, x.clientId) : null;
      S.openModal(x ? 'Envío E-' + x.number : 'Nuevo envío', '<form class="form" id="shF">' +
        '<label class="f full">Cliente registrado<input name="client" list="shCl" required autocomplete="off" placeholder="Escribí el nombre y elegilo de la lista" value="' + esc(cur ? cur.name : '') + '"></label>' +
        '<datalist id="shCl">' + cl.map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.address || '') + '</option>'; }).join('') + '</datalist>' +
        '<label class="f full">Dirección de entrega<input name="deliveryAddress" value="' + esc(x ? x.deliveryAddress : '') + '" placeholder="Se completa con la del cliente"></label>' +
        '<label class="f">Contacto (quién recibe)<input name="deliveryContact" value="' + esc(x ? x.deliveryContact : '') + '" placeholder="Nombre"></label>' +
        '<label class="f">Teléfono<input name="deliveryPhone" type="tel" value="' + esc(x ? x.deliveryPhone : '') + '"></label>' +
        '<label class="f full">Qué se envía<input name="description" value="' + esc(x ? x.description : '') + '" placeholder="Ej.: cambio de mercadería, muestras, devolución de envases"></label>' +
        '<label class="f">Bultos<input name="packages" type="number" min="0" max="999" value="' + (dl.packages || 1) + '"></label>' +
        '<label class="f">Día<input name="day" type="date" required value="' + (dl.day || L.day || S.nextWorkDay()) + '"></label>' +
        '<label class="f">Turno<select name="shift">' + Object.keys(SH()).map(function (k) { return '<option value="' + k + '"' + (k === (dl.shift || L.shift) ? ' selected' : '') + '>' + SH()[k] + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Camión<select name="truckId"><option value="">Sin camión todavía</option>' + trucks.map(function (t) { return '<option value="' + t.id + '"' + (t.id === dl.truckId ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select></label>' +
        '<label class="f full">Nota para el chofer (opcional)<input name="notes" value="' + esc(x ? x.notes : '') + '"></label>' +
        '<div class="foot full"><button type="button" class="btn" data-close>Cancelar</button>' + (x ? '<button type="button" class="btn danger" id="shDel">Borrar envío</button>' : '') + '<button class="btn primary">Guardar</button></div></form>', function (m) {
        var f = $('#shF', m), E = f.elements;
        var find = function () { var v = E.client.value.trim().toLowerCase(); return cl.filter(function (c) { return c.name.toLowerCase() === v; })[0]; };
        E.client.addEventListener('change', function () {
          var c = find(); if (!c) return;
          E.deliveryAddress.value = c.address || ''; E.deliveryPhone.value = c.phone || '';
        });
        var del = $('#shDel', m);
        if (del) del.addEventListener('click', function () {
          if (!confirm('¿Borrar el envío E-' + x.number + '?')) return;
          api('DELETE', '/shipments/' + x.id).then(function () { S.closeModal(); toast('Envío borrado'); after(); }, function (e) { toast(e.message, true); });
        });
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          var c = find(); if (!c) { toast('Elegí un cliente de la lista (tiene que estar registrado en Clientes).', true); E.client.focus(); return; }
          var o = { clientId: c.id, deliveryAddress: E.deliveryAddress.value.trim(), deliveryContact: E.deliveryContact.value.trim(), deliveryPhone: E.deliveryPhone.value.trim(), description: E.description.value.trim(), packages: E.packages.value, day: E.day.value, shift: E.shift.value, truckId: E.truckId.value, notes: E.notes.value.trim() };
          var btn = $('button.primary', f); btn.disabled = true;
          api(x ? 'PUT' : 'POST', '/shipments' + (x ? '/' + x.id : ''), o).then(function (r) {
            S.closeModal(); toast((x ? 'Envío actualizado' : 'Envío E-' + r.number + ' creado') + ' · ' + dayLabel(r.delivery.day));
            if (r.delivery.day !== L.day || r.delivery.shift !== L.shift) { L.day = r.delivery.day; L.shift = r.delivery.shift; }
            after(r);
          }, function (er) { toast(er.message, true); btn.disabled = false; });
        });
      });
    }, function (e) { toast(e.message, true); });
  }

  // ======================================================================
  // ETIQUETAS: una por bulto, con cliente, dirección, contacto, día y turno
  // ======================================================================
  var packagesOf = function (docs) { return docs.reduce(function (a, s) { return a + ((s.delivery && s.delivery.packages) || 0); }, 0); };
  var refOf = function (s) { return s.kind === 'envio' ? 'Envío E-' + s.number : 'Venta N.º ' + s.number; };
  var LBL_FMT = { rollo: 'Etiquetadora · 10 × 7 cm (una por hoja)', a4: 'Hoja A4 · 8 etiquetas por hoja' };
  var lblPref = function () { try { return localStorage.getItem('svc.lblfmt') || 'rollo'; } catch (e) { return 'rollo'; } };
  // groups: [{ clientName, address, contact, phone, day, shift, truckName, docs: [venta o envío] }]
  function labelsModal(groups, after) {
    var rows = [];
    groups.forEach(function (g, gi) { g.docs.forEach(function (s) { rows.push({ g: gi, s: s }); }); });
    S.openModal('🏷 Etiquetas de entrega', '<p class="muted small">Poné cuántos bultos lleva cada entrega: sale una etiqueta por bulto (ej.: "Bulto 2 de 3").</p>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Cliente</th><th>Entrega</th><th class="num">Bultos</th></tr></thead><tbody>' + rows.map(function (r, i) {
        var g = groups[r.g];
        return '<tr><td><b>' + esc(g.clientName) + '</b><div class="small muted">' + esc(g.address || 'Sin dirección') + '</div></td><td class="small">' + esc(refOf(r.s)) + (r.s.description ? '<div class="muted">' + esc(r.s.description) + '</div>' : '') + '</td>' +
          '<td class="num"><input type="number" min="0" max="999" data-pk="' + i + '" value="' + ((r.s.delivery && r.s.delivery.packages) || 1) + '" style="width:70px"></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="form"><label class="f full">Formato<select id="lbFmt">' + Object.keys(LBL_FMT).map(function (k) { return '<option value="' + k + '"' + (k === lblPref() ? ' selected' : '') + '>' + LBL_FMT[k] + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="lbGo">Imprimir</button></div>', function (m) {
      var count = function () { return $$('[data-pk]', m).reduce(function (a, inp) { return a + Math.max(0, Math.round(+inp.value || 0)); }, 0); };
      var upd = function () { var n = count(); $('#lbGo', m).textContent = 'Imprimir ' + n + ' etiqueta' + (n === 1 ? '' : 's'); };
      $$('[data-pk]', m).forEach(function (inp) { inp.addEventListener('input', upd); }); upd();
      $('#lbGo', m).addEventListener('click', function () {
        var n = count(); if (!n) return toast('Poné al menos un bulto.', true);
        var fmt = $('#lbFmt', m).value; try { localStorage.setItem('svc.lblfmt', fmt); } catch (e) { /* nada */ }
        var items = $$('[data-pk]', m).map(function (inp) { var r = rows[+inp.dataset.pk]; return { id: r.s.id, packages: Math.max(0, Math.round(+inp.value || 0)) }; });
        var b = this; b.disabled = true;
        api('PUT', '/deliveries/packages', { items: items }).then(function () {
          items.forEach(function (it, i) { var s = rows[i].s; if (s.delivery) s.delivery.packages = it.packages; var o = byId(db().sales || [], it.id); if (o && o !== s && o.delivery) o.delivery.packages = it.packages; });
          S.closeModal(); printLabels(groups, fmt); if (after) after();
        }, function (e) { toast(e.message, true); b.disabled = false; });
      });
    }, true);
  }
  function printLabels(groups, fmt) {
    var co = (db().settings && db().settings.company) || '', labels = [];
    groups.forEach(function (g) {
      var total = packagesOf(g.docs); if (!total) return;
      var refs = g.docs.filter(function (s) { return s.delivery && s.delivery.packages; }).map(refOf).join(' · ');
      var dayTxt = dayLabel(g.day) + ' · turno ' + (SH()[g.shift] || '').toLowerCase();
      for (var i = 1; i <= total; i++) {
        labels.push('<div class="lbl"><div class="l-top"><span>' + esc(co) + '</span><b>Bulto ' + i + ' de ' + total + '</b></div>' +
          '<div class="l-cli">' + esc(g.clientName) + '</div>' +
          '<div class="l-row"><small>Dirección</small>' + esc(g.address || '—') + '</div>' +
          '<div class="l-row"><small>Contacto</small>' + esc([g.contact, g.phone].filter(Boolean).join(' · ') || '—') + '</div>' +
          '<div class="l-day">' + esc(dayTxt.charAt(0).toUpperCase() + dayTxt.slice(1)) + '</div>' +
          '<div class="l-foot">' + esc([g.truckName, refs].filter(Boolean).join(' · ')) + '</div></div>');
      }
    });
    var a4 = fmt === 'a4';
    var css = '*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}' +
      '.lbl{width:100mm;height:70mm;padding:4mm 5mm;display:flex;flex-direction:column;gap:1.6mm;overflow:hidden;' + (a4 ? 'border:0.3mm dashed #999;' : 'page-break-after:always;') + '}' +
      '.l-top{display:flex;justify-content:space-between;align-items:center;font-size:9pt;border-bottom:0.5mm solid #000;padding-bottom:1.2mm}.l-top b{font-size:12pt}' +
      '.l-cli{font-size:17pt;font-weight:bold;line-height:1.1;max-height:13mm;overflow:hidden}' +
      '.l-row{font-size:10.5pt;line-height:1.2;max-height:10mm;overflow:hidden}.l-row small{display:block;font-size:7pt;text-transform:uppercase;color:#444;letter-spacing:.3px}' +
      '.l-day{margin-top:auto;font-size:13pt;font-weight:bold;border:0.5mm solid #000;border-radius:1.5mm;padding:1mm 2mm;text-align:center}' +
      '.l-foot{font-size:8pt;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      (a4 ? '@page{size:A4;margin:5mm}.grid{display:grid;grid-template-columns:100mm 100mm;justify-content:center}.lbl{break-inside:avoid}'
        : '@page{size:100mm 70mm;margin:0}');
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Etiquetas</title><style>' + css + '</style></head><body>' + (a4 ? '<div class="grid">' + labels.join('') + '</div>' : labels.join('')) + '</body></html>';
    var old = $('#print-frame'); if (old) old.remove();
    var fr = document.createElement('iframe');
    fr.id = 'print-frame'; fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(fr);
    var doc = fr.contentWindow.document; doc.open(); doc.write(html); doc.close();
    S.lastLabelsHtml = html; // para revisar
    setTimeout(function () { fr.contentWindow.focus(); fr.contentWindow.print(); }, 250);
  }
  // desde Ventas (administrador): etiquetas de una o varias ventas
  S.labelsForSales = function (sales) {
    var groups = sales.filter(function (s) { return s.delivery; }).map(function (s) {
      var c = s.clientId ? byId(db().clients || [], s.clientId) : null, t = byId(db().trucks || [], s.delivery.truckId);
      return { clientName: s.clientName, address: s.deliveryAddress || (c && c.address) || '', contact: s.deliveryContact || '', phone: s.deliveryPhone || (c && c.phone) || '', day: s.delivery.day, shift: s.delivery.shift, truckName: t ? t.name : '', docs: [s] };
    });
    if (!groups.length) return toast('Primero programá la entrega (día y turno).', true);
    labelsModal(groups, function () { S.render(); });
  };
  S.labelsModal = labelsModal;

  // ---------- camiones ----------
  function trucksTab(el, box) {
    var drivers = (db().users || []).filter(function (u) { return u.role === 'chofer'; });
    api('GET', '/deliveries?day=' + (L.day || S.nextWorkDay()) + '&shift=manana').then(function (d) {
      if (!alive(el, 'logistica')) return;
      var trucks = d.trucks.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      box.innerHTML = '<div class="card"><div class="head" style="margin-bottom:8px"><h2 style="margin:0">Camiones</h2><button class="btn primary" id="tkAdd">+ Nuevo camión</button></div>' +
        '<p class="muted small">Cada camión tiene su chofer: un usuario con rol <b>Chofer</b> (se crea en Configuración → Usuarios). El chofer recibe la ruta cuando la guardás.</p>' +
        (trucks.length ? '<div class="tbl-wrap"><table><thead><tr><th>Camión</th><th>Matrícula</th><th>Chofer</th><th>Capacidad</th><th>Estado</th><th></th></tr></thead><tbody>' + trucks.map(function (t) {
          var u = byId(drivers, t.driverId);
          return '<tr><td><b>' + esc(t.name) + '</b></td><td>' + esc(t.plate || '—') + '</td><td>' + (u ? esc(u.name) : '<span class="warn">sin chofer</span>') + '</td><td>' + esc(t.capacity || '—') + '</td>' +
            '<td>' + (t.active === false ? '<span class="pill">inactivo</span>' : '<span class="pill pagada">activo</span>') + '</td><td class="act"><button class="btn sm" data-ted="' + t.id + '">Editar</button><button class="btn sm danger" data-tdel="' + t.id + '">Borrar</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">Todavía no hay camiones.</p>') +
        (drivers.length ? '' : '<p class="warn small">No hay usuarios con rol Chofer. ' + (S.isAdmin() ? 'Crealos en Configuración → Usuarios.' : 'Pedile a un administrador que los cree.') + '</p>') + '</div>';
      var fields = [
        { name: 'name', label: 'Nombre', req: true, ph: 'Ej.: Camión 1, Furgón blanco' },
        { name: 'plate', label: 'Matrícula', ph: 'Ej.: SBA 1234' },
        { name: 'driverId', label: 'Chofer', type: 'select', options: [{ v: '', t: 'Sin chofer' }].concat(drivers.map(function (u) { return { v: u.id, t: u.name + (u.active ? '' : ' (inactivo)') }; })) },
        { name: 'capacity', label: 'Capacidad (opcional)', ph: 'Ej.: 1.500 kg, 40 cajones' },
        { name: 'active', label: 'Estado', type: 'select', options: [{ v: '1', t: 'Activo' }, { v: '0', t: 'Inactivo (no se usa)' }], def: '1' }
      ];
      $('#tkAdd', box).addEventListener('click', function () { S.formModal('Nuevo camión', fields, {}, function (o) { return api('POST', '/trucks', o).then(function () { toast('Camión creado'); trucksTab(el, box); }, function (e) { toast(e.message, true); throw e; }); }); });
      $$('[data-ted]', box).forEach(function (b) { b.addEventListener('click', function () { var t = byId(trucks, b.dataset.ted); S.formModal('Editar ' + t.name, fields, Object.assign({}, t, { active: t.active === false ? '0' : '1' }), function (o) { return api('PUT', '/trucks/' + t.id, o).then(function () { toast('Camión actualizado'); trucksTab(el, box); }, function (e) { toast(e.message, true); throw e; }); }); }); });
      $$('[data-tdel]', box).forEach(function (b) { b.addEventListener('click', function () { var t = byId(trucks, b.dataset.tdel); if (!confirm('¿Borrar ' + t.name + '? Sus entregas pendientes quedan sin camión.')) return; api('DELETE', '/trucks/' + t.id).then(function () { toast('Camión borrado'); trucksTab(el, box); }, function (e) { toast(e.message, true); }); }); });
    }, function (e) { box.innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  }

  // ---------- estadísticas: km y tiempos por camión ----------
  function statsTab(el, box) {
    if (!L.from) { var f = new Date(); f.setDate(f.getDate() - 30); L.from = S.dayKey(f); L.to = S.dayKey(new Date()); }
    box.innerHTML = '<div class="toolbar"><label class="small">Desde <input type="date" id="stF" value="' + L.from + '"></label><label class="small">Hasta <input type="date" id="stT" value="' + L.to + '"></label></div><div id="stBody"><div class="card empty">Cargando…</div></div>';
    var load = function () {
      api('GET', '/delivstats?from=' + L.from + '&to=' + L.to).then(function (d) {
        if (!alive(el, 'logistica')) return;
        var rows = d.rows.filter(function (r) { return r.routes; });
        $('#stBody', box).innerHTML = '<div class="card"><h2>Promedios por camión</h2>' + (rows.length ? '<div class="tbl-wrap"><table><thead><tr><th>Camión</th><th class="num">Rutas</th><th class="num">Entregas</th><th class="num">Km por ruta</th><th class="num">Km totales</th><th class="num">Tiempo por ruta</th><th class="num">Min. por entrega</th><th class="num">Km por entrega</th><th class="num">Cobrado</th></tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr><td><b>' + esc(r.name) + '</b>' + (r.plate ? '<div class="small muted">' + esc(r.plate) + '</div>' : '') + '</td><td class="num">' + r.routes + '</td><td class="num">' + r.delivered + ' de ' + r.stops + '</td>' +
              '<td class="num"><b>' + String(r.kmAvg).replace('.', ',') + ' km</b>' + (r.gpsRoutes < r.routes ? '<div class="small muted">' + (r.routes - r.gpsRoutes) + ' estimada' + (r.routes - r.gpsRoutes > 1 ? 's' : '') + '</div>' : '') + '</td><td class="num">' + String(r.kmTotal).replace('.', ',') + ' km</td>' +
              '<td class="num"><b>' + (r.minAvg ? fmtMin(r.minAvg) : '—') + '</b></td><td class="num">' + (r.minPerStop || '—') + '</td><td class="num">' + (r.kmPerStop ? String(r.kmPerStop).replace('.', ',') : '—') + '</td><td class="num">' + money(r.collected) + '</td></tr>';
          }).join('') + '</tbody></table></div>' : '<p class="muted">No hay rutas terminadas en esas fechas.</p>') +
          '<p class="muted small">Los km salen del GPS del celular del chofer mientras la ruta está en curso; si no hubo GPS se usa la estimación de la ruta armada. El tiempo va de "Empezar ruta" a la última entrega.</p></div>' +
          (d.routes.length ? '<div class="card"><h2>Últimas rutas</h2><div class="tbl-wrap"><table><thead><tr><th>Día</th><th>Camión</th><th class="num">Entregas</th><th class="num">Km</th><th class="num">Tiempo</th></tr></thead><tbody>' + d.routes.map(function (r) {
            return '<tr><td>' + esc(dayLabel(r.day)) + ' · ' + esc(SH()[r.shift].toLowerCase()) + '</td><td>' + esc(r.truckName) + '</td><td class="num">' + r.delivered + ' de ' + r.stops + '</td><td class="num">' + String(r.km || 0).replace('.', ',') + (r.gps ? '' : ' <span class="muted small">(est.)</span>') + '</td><td class="num">' + (r.minutes ? fmtMin(r.minutes) : '—') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>' : '');
      }, function (e) { $('#stBody', box).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    };
    $('#stF', box).addEventListener('change', function () { L.from = this.value; load(); });
    $('#stT', box).addEventListener('change', function () { L.to = this.value; load(); });
    load();
  }

  // ======================================================================
  // MIS ENTREGAS (chofer)
  // ======================================================================
  var C = { routeId: '', watch: null, buf: [], last: null, flushT: null };
  function stopTracking() {
    if (C.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(C.watch);
    C.watch = null; clearInterval(C.flushT); C.flushT = null; flush();
  }
  function flush() {
    if (!C.buf.length || !C.routeId) return;
    var pts = C.buf.splice(0, C.buf.length);
    api('POST', '/delivroutes/' + encodeURIComponent(C.routeId) + '/track', { points: pts }).catch(function () { C.buf = pts.concat(C.buf); });
  }
  function startTracking(routeId) {
    if (C.watch != null && C.routeId === routeId) return;
    stopTracking(); C.routeId = routeId;
    if (!navigator.geolocation) return;
    C.watch = navigator.geolocation.watchPosition(function (p) {
      var pt = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
      if (pt.acc > 60) return;
      if (C.last && dist(C.last, pt) < 30 && pt.t - C.last.t < 120000) return; // solo si se movió
      C.last = pt; C.buf.push(pt);
    }, function () { /* sin GPS: quedan los km estimados */ }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    C.flushT = setInterval(flush, 45000);
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  var getPos = function () {
    return new Promise(function (ok) {
      if (!navigator.geolocation) return ok(null);
      navigator.geolocation.getCurrentPosition(function (p) { ok({ lat: p.coords.latitude, lng: p.coords.longitude }); }, function () { ok(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    });
  };

  S.views.entregas = function (el) {
    el.innerHTML = '<div class="head"><h1>Mis entregas</h1></div><div id="chBody"><div class="card empty">Cargando…</div></div>';
    api('GET', '/delivroutes/mine').then(function (routes) {
      if (!alive(el, 'entregas')) return;
      draw(el, routes);
    }, function (e) { $('#chBody', el).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  };
  function draw(el, routes) {
    var box = $('#chBody', el);
    if (!routes.length) { stopTracking(); box.innerHTML = '<div class="card empty">No tenés rutas de entrega. Cuando Logística guarde una ruta para tu camión, aparece acá (y te llega un aviso 🔔).</div>'; return; }
    var cur = byId(routes, C.routeId) || routes.filter(function (r) { return r.status === 'en_curso'; })[0] || routes.filter(function (r) { return r.status === 'lista'; })[0] || routes[routes.length - 1];
    C.routeId = cur.id;
    if (cur.status === 'en_curso') startTracking(cur.id); else stopTracking();
    var sales = {}; cur.sales.forEach(function (s) { sales[s.id] = s; });
    var pending = cur.stops.filter(function (s) { return !s.result; }).length;
    box.innerHTML = (routes.length > 1 ? '<div class="chips">' + routes.map(function (r) {
      return '<button class="chip' + (r.id === cur.id ? ' on' : '') + '" data-rt="' + esc(r.id) + '">' + esc(dayLabel(r.day)) + ' · ' + esc(SH()[r.shift].toLowerCase()) + ' · ' + esc(r.truckName) + ' <b>' + r.stops.length + '</b></button>';
    }).join('') + '</div>' : '') +
      '<div class="card"><div class="head" style="margin-bottom:6px"><h2 style="margin:0">' + esc(cur.truckName) + ' · ' + esc(dayLabel(cur.day)) + ' (' + esc(SH()[cur.shift].toLowerCase()) + ')</h2><span class="pill ' + ROUTE_ST[cur.status][1] + '">' + (cur.status === 'lista' ? 'por empezar' : ROUTE_ST[cur.status][0]) + '</span></div>' +
      '<p class="small muted" style="margin:0 0 8px">' + cur.stops.length + ' parada' + (cur.stops.length > 1 ? 's' : '') + ' · faltan ' + pending + (cur.plannedKm ? ' · ≈ ' + String(cur.plannedKm).replace('.', ',') + ' km' : '') +
      (cur.startedAt ? ' · salió ' + esc(S.fmtDateTime(cur.startedAt)) : '') + (cur.status === 'terminada' && cur.minutes ? ' · ' + fmtMin(cur.minutes) + (cur.trackKm ? ' · ' + String(cur.trackKm).replace('.', ',') + ' km por GPS' : '') : '') + '</p>' +
      (cur.status === 'lista' ? '<button class="btn primary big" id="chStart">▶ Empezar ruta</button><p class="muted small">Al empezar, el vendedor y la administración reciben el aviso "en camino". Dejá esta pantalla abierta: el GPS cuenta los kilómetros.</p>' : '') +
      (cur.status === 'en_curso' ? '<p class="small ok-t">🛰️ Ruta en curso: dejá esta pantalla abierta para que el GPS cuente los km.</p>' : '') +
      '<div class="map-box" id="chMap"></div></div>' +
      cur.stops.map(function (st, i) {
        var ss = st.saleIds.map(function (id) { return sales[id]; }).filter(Boolean), dueAmt = ss.reduce(function (a, s) { return a + (s.due || 0); }, 0);
        var c = byId(cur.clients, st.clientId) || {}, phone = (ss[0] && ss[0].deliveryPhone) || c.phone;
        var res = st.result === 'entregada' ? '<span class="pill pagada">entregada' + (st.collected ? ' · cobró ' + money(st.collected) : '') + '</span>' : st.result === 'no_entregada' ? '<span class="pill anulada">no entregada · ' + esc(st.reason || '') + '</span>' : '';
        return '<div class="card stop-card' + (st.result ? ' done' : '') + '"><div class="stop-head"><span class="stop-n big">' + (i + 1) + '</span><div><b>' + esc(st.clientName) + '</b><div class="small muted">' + esc(st.address || c.address || 'Sin dirección') + '</div></div>' + res + '</div>' +
          ss.map(function (s) {
            if (s.kind === 'envio') return '<div class="small stop-sale"><b>📦 Envío E-' + s.number + '</b>' + (s.description ? ' · ' + esc(s.description) : '') + (s.notes ? '<div class="muted">Nota: ' + esc(s.notes) + '</div>' : '') + '</div>';
            return '<div class="small stop-sale"><b>N.º ' + s.number + '</b>' + (s.private ? ' · pedido interno' : ' · ' + s.items.map(function (it) { return it.qty + ' × ' + esc(it.name); }).join(', ')) + (s.notes ? '<div class="muted">Nota: ' + esc(s.notes) + '</div>' : '') + '</div>';
          }).join('') +
          '<div class="small" style="margin:6px 0">' + (packagesOf(ss) ? '<b>' + packagesOf(ss) + ' bulto' + (packagesOf(ss) > 1 ? 's' : '') + '</b> · ' : '') + (ss.some(function (s) { return s.deliveryContact; }) ? 'Recibe: ' + esc(ss.filter(function (s) { return s.deliveryContact; })[0].deliveryContact) + ' · ' : '') + (dueAmt ? 'A cobrar: <b>' + money(dueAmt) + '</b>' : '<span class="muted">Ya está paga</span>') + '</div>' +
          '<div class="stop-btns"><a class="btn sm" target="svc_mapa" rel="noopener" href="' + mapsLink({ lat: st.lat, lng: st.lng, address: st.address, clientName: st.clientName }) + '">🧭 Cómo llegar</a>' +
          (telLink(phone) ? '<a class="btn sm" href="' + telLink(phone) + '">📞 Llamar</a>' : '') +
          (!st.result && cur.status === 'en_curso' ? '<button class="btn sm primary" data-ok="' + i + '">✓ Entregado</button><button class="btn sm" data-no="' + i + '">✕ No se entregó</button>' : '') + '</div></div>';
      }).join('') +
      (cur.status === 'en_curso' ? '<button class="btn" id="chFinish">Terminar ruta</button><p class="muted small">Al terminar, lo que no visitaste vuelve a quedar pendiente para reprogramar.</p>' : '');
    $$('[data-rt]', box).forEach(function (b) { b.addEventListener('click', function () { C.routeId = b.dataset.rt; draw(el, routes); }); });
    var pts = cur.stops.map(function (st, i) { return { lat: st.lat, lng: st.lng, n: i + 1, color: st.result === 'entregada' ? 'green' : st.result ? 'red' : 'orange', label: (i + 1) + '. ' + esc(st.clientName) }; });
    if (hasGeo(cur.depot)) pts.unshift({ lat: cur.depot.lat, lng: cur.depot.lng, n: 'D', color: 'dark', label: 'Depósito' });
    G().drawMap($('#chMap', box), pts, { line: true, empty: 'Las entregas de esta ruta no tienen ubicación en el mapa: usá "Cómo llegar".' });
    var reload = function (rt) { var i = routes.map(function (r) { return r.id; }).indexOf(rt.id); routes[i] = rt; draw(el, routes); };
    var st0 = $('#chStart', box);
    if (st0) st0.addEventListener('click', function () {
      st0.disabled = true;
      getPos().then(function (pos) { return api('POST', '/delivroutes/' + encodeURIComponent(cur.id) + '/start', { pos: pos }); })
        .then(function (rt) { toast('¡Buen viaje! Se avisó que va en camino.'); reload(rt); }, function (e) { toast(e.message, true); st0.disabled = false; });
    });
    var fin = $('#chFinish', box);
    if (fin) fin.addEventListener('click', function () {
      var left = cur.stops.filter(function (s) { return !s.result; }).length;
      if (left && !confirm('Quedan ' + left + ' sin cerrar: vuelven a quedar pendientes. ¿Terminar la ruta?')) return;
      flush(); api('POST', '/delivroutes/' + encodeURIComponent(cur.id) + '/finish', {}).then(function (rt) { stopTracking(); toast('Ruta terminada'); reload(rt); }, function (e) { toast(e.message, true); });
    });
    $$('[data-ok]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.ok, st = cur.stops[i], ss = st.saleIds.map(function (id) { return sales[id]; }).filter(Boolean);
        var dueAmt = ss.reduce(function (a, s) { return a + (s.due || 0); }, 0);
        var fields = dueAmt ? [
          { name: 'amount', label: 'Cobrado ($U) · a cobrar ' + money(dueAmt), type: 'number', req: true },
          { name: 'method', label: 'Cómo pagó', type: 'select', options: S.PAYMENTS.map(function (p) { return { v: p, t: p === 'Cuenta corriente' ? 'No pagó: queda en cuenta corriente' : p }; }) },
          { name: 'note', label: 'Nota (opcional)', full: true }
        ] : [{ name: 'note', label: 'Nota (opcional): quién recibió, etc.', full: true }];
        S.formModal('Entregado · ' + st.clientName, fields, { amount: dueAmt ? Math.round(dueAmt * 100) / 100 : '', method: 'Efectivo' }, function (o) {
          return getPos().then(function (pos) {
            return api('POST', '/delivroutes/' + encodeURIComponent(cur.id) + '/stops/' + i, { result: 'entregada', amount: o.method === 'Cuenta corriente' ? 0 : o.amount, method: o.method, note: o.note, pos: pos });
          }).then(function (rt) { toast('Entrega registrada · se avisó al vendedor'); reload(rt); }, function (e) { toast(e.message, true); throw e; });
        });
      });
    });
    $$('[data-no]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.no, st = cur.stops[i];
        S.formModal('No se entregó · ' + st.clientName, [
          { name: 'reason', label: 'Motivo', type: 'select', options: ['Cerrado', 'No estaba quien recibe', 'Rechazó el pedido', 'Dirección incorrecta', 'No llegamos', 'Otro'].map(function (x) { return { v: x, t: x }; }) },
          { name: 'note', label: 'Detalle (opcional)', full: true }
        ], { reason: 'Cerrado' }, function (o) {
          return getPos().then(function (pos) { return api('POST', '/delivroutes/' + encodeURIComponent(cur.id) + '/stops/' + i, { result: 'no_entregada', reason: o.reason, note: o.note, pos: pos }); })
            .then(function (rt) { toast('Registrado · se avisó al vendedor'); reload(rt); }, function (e) { toast(e.message, true); throw e; });
        });
      });
    });
  }

  // ======================================================================
  // AVISOS (todos los usuarios)
  // ======================================================================
  var N = { unread: null, timer: null };
  function badge(n) { var b = $('#avisosN'); if (!b) return; b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
  function poll() {
    if (!db().me) return;
    api('GET', '/notices').then(function (r) {
      badge(r.unread);
      if (N.unread !== null && r.unread > N.unread) {
        var fresh = r.items.filter(function (x) { return !x.read; })[0];
        if (fresh) {
          toast(fresh.text);
          if (document.hidden && window.Notification && Notification.permission === 'granted') { try { new Notification('SVC', { body: fresh.text }); } catch (e) { /* nada */ } }
        }
      }
      N.unread = r.unread;
    }).catch(function () { /* sin conexión: lo intenta de nuevo */ });
  }
  S.onStart = function () { N.unread = null; poll(); clearInterval(N.timer); N.timer = setInterval(poll, 60000); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  S.views.avisos = function (el) {
    el.innerHTML = '<div class="head"><h1>Avisos</h1><div class="actions">' +
      (window.Notification && Notification.permission === 'default' ? '<button class="btn" id="nfOn">Avisarme aunque no esté en esta pantalla</button>' : '') + '</div></div><div id="nfBody"><div class="card empty">Cargando…</div></div>';
    var on = $('#nfOn', el);
    if (on) on.addEventListener('click', function () { Notification.requestPermission().then(function (p) { toast(p === 'granted' ? 'Listo: te avisa este equipo' : 'No se activaron los avisos'); on.remove(); }); });
    api('GET', '/notices').then(function (r) {
      if (!alive(el, 'avisos')) return;
      $('#nfBody', el).innerHTML = r.items.length ? '<div class="card notices">' + r.items.map(function (n) {
        var s = n.saleId ? byId(db().sales || [], n.saleId) : null;
        return '<div class="notice' + (n.read ? '' : ' unread') + '"><div>' + esc(n.text) + '<div class="small muted">' + esc(S.fmtDateTime(n.createdAt)) + '</div></div>' +
          (s ? '<button class="btn sm" data-sale="' + s.id + '">Ver venta</button>' : n.kind === 'ruta' && db().me.role === 'chofer' ? '<a class="btn sm" href="#/entregas">Ver ruta</a>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="card empty">No tenés avisos.</div>';
      $$('[data-sale]', el).forEach(function (b) { b.addEventListener('click', function () { S.showReceipt(byId(db().sales, b.dataset.sale)); }); });
      if (r.unread) api('POST', '/notices/read', {}).then(function () { N.unread = 0; badge(0); });
    }, function (e) { $('#nfBody', el).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  };
})();
