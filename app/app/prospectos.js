/* SVC · Comercios nuevos por zona: busca en OpenStreetMap los comercios del área del mapa, marca los que ya
   son clientes y agrega los elegidos como "prospecto" en la zona (después se suman a un recorrido).
   Se abre desde Recorridos → "Buscar comercios nuevos". Usa window.SVC (app.js) y SVC.geo (terreno.js). */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, esc = S.esc, api = S.api, toast = S.toast;
  var db = function () { return S.db; };
  var G = function () { return S.geo; };
  var MVD = [-34.8941, -56.1653];
  var DEFAULT = ['almacen', 'kiosco', 'panaderia', 'carniceria', 'verduleria', 'bebidas'];
  var COL = { nuevo: '#ff7a1a', posible: '#d69e2e', cliente: '#1f9d55', prospecto: '#2b6cb0', oculto: '#8a8a8a' };
  var TXT = { nuevo: 'Nuevo', posible: 'Posible duplicado', cliente: 'Ya es cliente', prospecto: 'Ya agregado', oculto: 'Oculto' };
  var ORDER = { nuevo: 0, posible: 1, oculto: 2, prospecto: 3, cliente: 4 };
  var cats = null, catSel = DEFAULT.slice();

  S.prospector = function (el, z) {
    if (!z) return;
    var map = null, layer = null, marks = {}, places = [], picked = {}, showHidden = false, last = null;
    el.innerHTML = '<div class="head"><h1>Comercios nuevos · ' + esc(z.name) + '</h1><div class="actions"><button class="btn" id="psBack">← Volver a Recorridos</button></div></div>' +
      '<p class="muted small" style="margin-top:-6px">Busca los comercios cargados en OpenStreetMap dentro del área que se ve en el mapa. No están todos (los almacenes chicos suelen faltar) ' +
      'y casi nunca tienen teléfono: los que agregues entran como <b>prospecto</b> y el vendedor confirma los datos en la visita. Con la primera venta pasan a cliente.</p>' +
      '<div class="card"><div class="chips" id="psCats"><span class="muted small">Cargando rubros…</span></div>' +
      '<div class="map-box ps-map" id="psMap"></div>' +
      '<div class="rfoot"><span class="muted small grow" id="psHint">Mové y acercá el mapa hasta la zona y tocá Buscar (área máx. unos 6 km de lado).</span>' +
      '<button class="btn primary" id="psGo">🔎 Buscar en esta área</button></div></div>' +
      '<div class="card" id="psRes" hidden></div>';
    $('#psBack', el).addEventListener('click', function () { S.views.recorridos(el); });

    (cats ? Promise.resolve(cats) : api('GET', '/prospects/categories')).then(function (list) {
      cats = list;
      $('#psCats', el).innerHTML = list.map(function (c) { return '<button type="button" class="chip' + (catSel.indexOf(c.id) >= 0 ? ' on' : '') + '" data-c="' + c.id + '">' + esc(c.label) + '</button>'; }).join('');
    }, function (e) { $('#psCats', el).innerHTML = '<span class="small">' + esc(e.message) + '</span>'; });
    $('#psCats', el).addEventListener('click', function (e) {
      var b = e.target.closest('[data-c]'); if (!b) return;
      b.classList.toggle('on');
      catSel = Array.prototype.map.call(el.querySelectorAll('#psCats .chip.on'), function (x) { return x.dataset.c; });
    });

    // mapa con los comercios de la zona que ya están ubicados (puntos grises)
    var box = $('#psMap', el);
    box.innerHTML = '<div class="map-empty muted small">Cargando mapa…</div>';
    G().loadLeaflet().then(function () {
      var L = window.L; box.innerHTML = '';
      map = L.map(box, { scrollWheelZoom: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; colaboradores de OpenStreetMap' }).addTo(map);
      var pts = db().clients.filter(function (c) { return c.zoneId === z.id && G().hasGeo(c); }).map(function (c) {
        L.circleMarker([c.lat, c.lng], { radius: 5, color: '#555', weight: 1, fillColor: '#999', fillOpacity: 0.8 }).addTo(map).bindPopup('<b>' + esc(c.name) + '</b><br>Cliente de la zona');
        return [c.lat, c.lng];
      });
      if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
      else map.setView(pts[0] || MVD, pts.length ? 16 : 15);
      if (!pts.length) $('#psHint', el).textContent = 'La zona no tiene comercios ubicados todavía: mové el mapa hasta la zona y tocá Buscar.';
      layer = L.layerGroup().addTo(map);
      setTimeout(function () { map.invalidateSize(); }, 50);
    }, function (e) { box.innerHTML = '<div class="map-empty muted small">' + esc(e.message) + '</div>'; });

    function search(q) {
      var btn = $('#psGo', el); btn.disabled = true; btn.textContent = 'Buscando… (puede tardar hasta 1 min)';
      return api('GET', '/prospects/search?' + q).then(function (r) {
        last = q; places = r.places; picked = {}; draw();
        if (!places.length) toast('No hay comercios de esos rubros cargados en esa área.');
      }, function (e) { toast(e.message, true); }).then(function () { btn.disabled = false; btn.textContent = '🔎 Buscar en esta área'; });
    }
    $('#psGo', el).addEventListener('click', function () {
      if (!map) return;
      if (!catSel.length) return toast('Elegí al menos un rubro', true);
      var b = map.getBounds();
      search('s=' + b.getSouth().toFixed(5) + '&w=' + b.getWest().toFixed(5) + '&n=' + b.getNorth().toFixed(5) + '&e=' + b.getEast().toFixed(5) + '&cats=' + catSel.join(','));
    });

    function visible() {
      return places.filter(function (p) { return showHidden || p.status !== 'oculto'; })
        .sort(function (a, b) { return (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name); });
    }
    function pickable(p) { return p.status === 'nuevo' || p.status === 'posible' || p.status === 'oculto'; }
    function count(st) { return places.filter(function (p) { return p.status === st; }).length; }
    function draw() {
      var L = window.L, list = visible(), res = $('#psRes', el);
      res.hidden = false;
      layer.clearLayers(); marks = {};
      list.forEach(function (p) {
        marks[p.osmId] = L.circleMarker([p.lat, p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: COL[p.status], fillOpacity: 0.95 }).addTo(layer)
          .bindPopup('<b>' + esc(p.name) + '</b><br>' + esc(p.catLabel) + (p.address ? '<br>' + esc(p.address) : '') + '<br><i>' + TXT[p.status] + (p.clientName ? ': ' + esc(p.clientName) : '') + '</i>');
      });
      res.innerHTML = '<div class="head" style="margin-bottom:6px"><h2 style="margin:0">Resultados (' + places.length + ')</h2><div class="actions">' +
        (count('oculto') ? '<label class="small"><input type="checkbox" id="psHid"' + (showHidden ? ' checked' : '') + '> Ver ocultos (' + count('oculto') + ')</label>' : '') +
        '<button class="btn sm" id="psAll">Tildar todos los nuevos</button></div></div>' +
        '<div class="ps-legend">' + ['nuevo', 'posible', 'prospecto', 'cliente'].map(function (st) {
          return '<span><i class="ps-dot" style="background:' + COL[st] + '"></i>' + TXT[st] + ' (' + count(st) + ')</span>';
        }).join('') + '<span class="muted">· Gris: clientes de la zona</span></div>' +
        (count('posible') ? '<p class="small muted">“Posible duplicado”: hay un cliente sin ubicar con un nombre parecido. Revisalo antes de agregarlo.</p>' : '') +
        '<div class="ps-list">' + (list.length ? list.map(function (p) {
          var can = pickable(p);
          return '<div class="ps-row st-' + p.status + '"><label><input type="checkbox" data-pick="' + esc(p.osmId) + '"' + (can ? '' : ' disabled') + (picked[p.osmId] ? ' checked' : '') + '>' +
            '<span class="t"><b>' + esc(p.name) + '</b><span class="small muted">' + esc(p.catLabel) + (p.address ? ' · ' + esc(p.address) : ' · sin dirección') + (p.phone ? ' · ' + esc(p.phone) : '') + '</span>' +
            '<span class="small"><i class="ps-dot" style="background:' + COL[p.status] + '"></i>' + TXT[p.status] + (p.clientName ? ': ' + esc(p.clientName) : '') + '</span></span></label>' +
            '<button class="btn sm" data-fly="' + esc(p.osmId) + '" aria-label="Ver en el mapa">📍</button>' +
            (p.status === 'nuevo' ? '<button class="btn sm" data-hide="' + esc(p.osmId) + '" title="No volver a mostrarlo (cerró, no es para nosotros…)">Ocultar</button>' : '') +
            (p.status === 'oculto' ? '<button class="btn sm" data-unhide="' + esc(p.osmId) + '">Mostrar</button>' : '') + '</div>';
        }).join('') : '<p class="muted small" style="padding:10px">Nada para mostrar.</p>') + '</div>' +
        '<div class="rfoot"><span class="grow small" id="psN"></span><button class="btn primary" id="psAdd" disabled>Agregar como prospectos</button></div>' +
        '<p class="small muted">Datos © colaboradores de OpenStreetMap (licencia ODbL).</p>';
      updN();
    }
    function updN() {
      var n = Object.keys(picked).length;
      $('#psN', el).textContent = n ? n + ' elegido' + (n > 1 ? 's' : '') + ' → entran en la zona ' + z.name + ', sin vendedor hasta que los pongas en un recorrido' : '';
      $('#psAdd', el).disabled = !n;
    }
    function setStatus(ids, st) { places.forEach(function (p) { if (ids.indexOf(p.osmId) >= 0) p.status = st; }); }

    $('#psRes', el).addEventListener('change', function (e) {
      if (e.target.id === 'psHid') { showHidden = e.target.checked; draw(); return; }
      var id = e.target.dataset.pick; if (!id) return;
      if (e.target.checked) picked[id] = 1; else delete picked[id];
      updN();
    });
    $('#psRes', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.id === 'psAll') {
        places.forEach(function (p) { if (p.status === 'nuevo') picked[p.osmId] = 1; });
        draw(); return;
      }
      if (b.dataset.fly) { var m = marks[b.dataset.fly]; if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 17)); m.openPopup(); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
      if (b.dataset.hide || b.dataset.unhide) {
        var id = b.dataset.hide || b.dataset.unhide, undo = !!b.dataset.unhide;
        api('POST', '/prospects/hide', { ids: [id], undo: undo }).then(function () { delete picked[id]; setStatus([id], undo ? 'nuevo' : 'oculto'); draw(); }, function (e2) { toast(e2.message, true); });
        return;
      }
      if (b.id === 'psAdd') {
        var ids = Object.keys(picked); b.disabled = true;
        api('POST', '/prospects/import', { zoneId: z.id, ids: ids }).then(function (r) {
          toast(r.created + ' prospecto' + (r.created === 1 ? '' : 's') + ' agregado' + (r.created === 1 ? '' : 's') + ' a ' + z.name);
          setStatus(ids, 'prospecto'); picked = {}; draw();
          return S.refresh();
        }, function (e2) { toast(e2.message, true); b.disabled = false; if (e2.message.indexOf('venció') >= 0 && last) search(last); });
      }
    });
  };
})();
