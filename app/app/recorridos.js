/* SVC · Recorridos: el supervisor arma recorridos fijos por zona (lista ordenada de comercios)
   y los asigna a un vendedor en ciertos días de la semana. Cada día, la ruta del vendedor sale sola
   de sus recorridos (en Rutas se puede cambiar un día puntual). Usa window.SVC (app.js) y SVC.geo (terreno.js). */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, $$ = S.$$, esc = S.esc, api = S.api, toast = S.toast, byId = S.byId;
  var db = function () { return S.db; };
  var G = function () { return S.geo; };
  var WEEK = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
  var dayNames = function (days) { return WEEK.filter(function (d) { return (days || []).indexOf(d[0]) >= 0; }).map(function (d) { return d[1]; }).join(' · ') || '—'; };

  function myZones() {
    var me = db().me, zs = db().zones || [];
    return (me.role === 'admin' ? zs : zs.filter(function (z) { return z.supervisorId === me.id; }))
      .slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  var userName = function (id) { var u = byId(db().users, id) || (db().me.id === id ? db().me : null); return u ? u.name : ''; };
  var zoneName = function (id) { var z = byId(db().zones || [], id); return z ? z.name : ''; };

  var sel = { zoneId: '' }, recs = [];
  S.views.recorridos = function (el) {
    if (!S.isBoss()) { el.innerHTML = '<div class="card empty">Solo supervisores y administradores.</div>'; return; }
    var zones = myZones();
    if (!zones.length) {
      el.innerHTML = '<div class="head"><h1>Recorridos</h1></div><div class="card empty">' +
        (S.isAdmin() ? 'Primero creá las zonas en <a href="#/config">Configuración → Zonas</a>.' : 'No tenés zonas a tu cargo. Pedile a un administrador que te asigne una.') + '</div>';
      return;
    }
    if (sel.zoneId && !byId(zones, sel.zoneId)) sel.zoneId = '';
    el.innerHTML = '<div class="head"><h1>Recorridos</h1><div class="actions">' +
      '<select id="rzF"><option value="">Todas las zonas</option>' + zones.map(function (z) { return '<option value="' + z.id + '"' + (z.id === sel.zoneId ? ' selected' : '') + '>' + esc(z.name) + '</option>'; }).join('') + '</select>' +
      '<button class="btn primary" id="recAdd">+ Nuevo recorrido</button></div></div>' +
      '<p class="muted small" style="margin-top:-6px">Cada recorrido es una lista de comercios de una zona. Asignado a un vendedor y a días de la semana, arma solo la ruta de esos días (en Rutas se puede cambiar un día puntual).</p>' +
      '<div id="recBody"><div class="card empty">Cargando…</div></div>';
    $('#rzF', el).addEventListener('change', function () { sel.zoneId = this.value; drawList(el); });
    $('#recAdd', el).addEventListener('click', function () { editor(el, { name: '', zoneId: sel.zoneId || zones[0].id, sellerId: '', days: [], stops: [] }); });
    api('GET', '/recorridos').then(function (list) { recs = list; if (el.isConnected) drawList(el); }, function (e) { $('#recBody', el).innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  };

  function drawList(el) {
    var zones = myZones().filter(function (z) { return !sel.zoneId || z.id === sel.zoneId; });
    var clients = db().clients, inRec = {};
    recs.forEach(function (r) { r.stops.forEach(function (id) { inRec[id] = 1; }); });
    $('#recBody', el).innerHTML = zones.map(function (z) {
      var list = recs.filter(function (r) { return r.zoneId === z.id; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var zc = clients.filter(function (c) { return c.zoneId === z.id; }), free = zc.filter(function (c) { return !inRec[c.id]; }).length;
      return '<div class="card rec-zone"><div class="head" style="margin-bottom:8px"><h2 style="margin:0">' + esc(z.name) + '</h2>' +
        '<span class="muted small">' + zc.length + ' comercios' + (free ? ' · <b>' + free + ' sin recorrido</b>' : '') + '</span></div>' +
        (list.length ? '<div class="tbl-wrap"><table><thead><tr><th>Recorrido</th><th>Vendedor</th><th>Días</th><th class="num">Comercios</th><th></th></tr></thead><tbody>' +
          list.map(function (r) {
            var sinGeo = r.stops.filter(function (id) { return !G().hasGeo(byId(clients, id)); }).length;
            return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + (r.sellerId ? esc(userName(r.sellerId)) : '<span class="pill pendiente">sin asignar</span>') + '</td>' +
              '<td>' + (r.days.length ? dayNames(r.days) : '<span class="pill pendiente">sin días</span>') + '</td>' +
              '<td class="num">' + r.stops.length + (sinGeo ? '<div class="small muted">' + sinGeo + ' sin ubicar</div>' : '') + '</td>' +
              '<td class="act"><button class="btn sm" data-redit="' + r.id + '">Editar</button><button class="btn sm danger" data-rdel="' + r.id + '">Borrar</button></td></tr>';
          }).join('') + '</tbody></table></div>' : '<p class="muted">Todavía no hay recorridos en esta zona.</p>') + '</div>';
    }).join('');
    $('#recBody', el).onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.redit) editor(el, JSON.parse(JSON.stringify(byId(recs, b.dataset.redit))));
      if (b.dataset.rdel) {
        var r = byId(recs, b.dataset.rdel);
        if (!confirm('¿Borrar el recorrido "' + r.name + '"? Las rutas ya cambiadas a mano en Rutas se mantienen; los comercios siguen asignados a su vendedor.')) return;
        api('DELETE', '/recorridos/' + r.id).then(function () { toast('Recorrido borrado'); S.views.recorridos(el); }, function (e2) { toast(e2.message, true); });
      }
    };
  }

  // ---------- editor de un recorrido ----------
  function editor(el, rec) {
    var zones = myZones(), users = G().teamUsers(), dirty = false, show = 'zone';
    var stops = rec.stops.slice();
    var otherRec = {}; recs.forEach(function (r) { if (r.id !== rec.id) r.stops.forEach(function (id) { (otherRec[id] = otherRec[id] || []).push(r.name); }); });
    el.innerHTML = '<div class="head"><h1>' + (rec.id ? 'Editar recorrido' : 'Nuevo recorrido') + '</h1><div class="actions"><button class="btn" id="reBack">← Volver</button></div></div>' +
      '<div class="card rec-form">' +
      '<label class="f">Nombre<input id="reName" maxlength="80" placeholder="Ej.: Centro mañana, Av. Italia…" value="' + esc(rec.name) + '"></label>' +
      '<label class="f">Zona<select id="reZone">' + zones.map(function (z) { return '<option value="' + z.id + '"' + (z.id === rec.zoneId ? ' selected' : '') + '>' + esc(z.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f">Vendedor<select id="reSeller"><option value="">Sin asignar todavía</option>' + users.map(function (u) { return '<option value="' + u.id + '"' + (u.id === rec.sellerId ? ' selected' : '') + '>' + esc(u.name) + ' (' + S.ROLE_NAMES[u.role] + ')</option>'; }).join('') + '</select></label>' +
      '<div class="f"><span>Días de la semana</span><div class="chips" id="reDays" style="margin:6px 0 0">' + WEEK.map(function (d) { return '<button type="button" class="chip' + (rec.days.indexOf(d[0]) >= 0 ? ' on' : '') + '" data-d="' + d[0] + '">' + d[1] + '</button>'; }).join('') + '</div></div>' +
      '</div>' +
      '<div class="rutas">' +
      '<div class="card"><h2>Comercios</h2><div class="toolbar"><input type="search" id="reQ" placeholder="Buscar comercio o dirección…">' +
      '<select id="reShow"><option value="zone">De esta zona</option><option value="none">Sin zona</option><option value="all">Todos</option></select></div>' +
      '<div id="reList" class="pick-list tall"></div></div>' +
      '<div class="card"><div class="head" style="margin-bottom:8px"><h2 style="margin:0" id="reTitle"></h2>' +
      '<div class="actions"><button class="btn sm" id="reNear">Ordenar por cercanía</button><button class="btn sm" id="reMap">🗺️ Mapa</button></div></div>' +
      '<div class="map-box" id="reMapBox" hidden></div><ol id="reStops" class="stops edit"></ol>' +
      '<div class="rfoot"><span class="grow"></span>' + (rec.id ? '' : '') + '<button class="btn" id="reCancel">Cancelar</button><button class="btn primary" id="reSave">Guardar recorrido</button></div></div>' +
      '</div>';

    function zoneId() { return $('#reZone', el).value; }
    function drawClients() {
      var q = $('#reQ', el).value.toLowerCase(), z = zoneId();
      var list = db().clients.filter(function (c) {
        return stops.indexOf(c.id) < 0 && (show === 'all' || (show === 'none' ? !c.zoneId : c.zoneId === z)) &&
          (!q || (c.name + ' ' + (c.address || '') + ' ' + (c.doc || '')).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('#reList', el).innerHTML = list.length ? list.slice(0, 150).map(function (c) {
        var who = c.sellerId ? userName(c.sellerId) : '';
        return '<button type="button" class="pick" data-add="' + c.id + '"><b>' + esc(c.name) + '</b><span class="muted small">' + esc(c.address || 'Sin dirección') +
          (show !== 'zone' && c.zoneId ? ' · zona ' + esc(zoneName(c.zoneId)) : '') + (who ? ' · ' + esc(who) : ' · sin vendedor') +
          (otherRec[c.id] ? ' · en ' + esc(otherRec[c.id].join(', ')) : '') + (G().hasGeo(c) ? '' : ' · sin ubicar') + '</span><span class="add">+</span></button>';
      }).join('') + (list.length > 150 ? '<p class="muted small">Mostrando 150 de ' + list.length + '. Buscá para afinar.</p>' : '')
        : '<p class="muted small">' + (show === 'zone' ? 'No hay más comercios en esta zona. Pasá a “Sin zona” o “Todos”, o asigná la zona en Clientes.' : 'No hay más comercios con ese filtro.') + '</p>';
    }
    function drawStops() {
      $('#reTitle', el).textContent = 'Orden de visita (' + stops.length + ')' + (dirty ? ' · sin guardar' : '');
      $('#reStops', el).innerHTML = stops.length ? stops.map(function (id, i) {
        var c = byId(db().clients, id) || { name: '(comercio no disponible)' };
        return '<li class="stop"><span class="n">' + (i + 1) + '</span><div class="stop-main"><b>' + esc(c.name) + '</b><span class="muted small">' + esc(c.address || '') + (G().hasGeo(c) ? '' : ' · sin ubicar') + '</span></div>' +
          '<div class="stop-act"><button class="btn sm" data-up="' + i + '" aria-label="Subir"' + (i ? '' : ' disabled') + '>↑</button><button class="btn sm" data-down="' + i + '" aria-label="Bajar"' + (i < stops.length - 1 ? '' : ' disabled') + '>↓</button>' +
          '<button class="btn sm danger" data-rm="' + i + '" aria-label="Quitar">✕</button></div></li>';
      }).join('') : '<li class="muted small" style="list-style:none">Tocá un comercio de la izquierda para agregarlo al recorrido.</li>';
    }
    function change() { dirty = true; drawStops(); drawClients(); }
    function leave() { if (!dirty || confirm('El recorrido tiene cambios sin guardar. ¿Descartarlos?')) S.views.recorridos(el); }

    $('#reBack', el).addEventListener('click', leave);
    $('#reCancel', el).addEventListener('click', leave);
    ['reName', 'reSeller'].forEach(function (id) { $('#' + id, el).addEventListener('input', function () { dirty = true; drawStops(); }); });
    $('#reZone', el).addEventListener('change', function () { dirty = true; drawStops(); drawClients(); });
    $('#reShow', el).addEventListener('change', function () { show = this.value; drawClients(); });
    $('#reQ', el).addEventListener('input', drawClients);
    $('#reDays', el).addEventListener('click', function (e) { var b = e.target.closest('[data-d]'); if (b) { b.classList.toggle('on'); dirty = true; drawStops(); } });
    $('#reList', el).addEventListener('click', function (e) { var b = e.target.closest('[data-add]'); if (b) { stops.push(b.dataset.add); change(); } });
    $('#reStops', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var i;
      if (b.dataset.rm != null) stops.splice(+b.dataset.rm, 1);
      else if (b.dataset.up != null) { i = +b.dataset.up; stops.splice(i - 1, 0, stops.splice(i, 1)[0]); }
      else if (b.dataset.down != null) { i = +b.dataset.down; stops.splice(i + 1, 0, stops.splice(i, 1)[0]); }
      else return;
      change();
    });
    $('#reNear', el).addEventListener('click', function () {
      var cl = db().clients, hasGeo = G().hasGeo;
      var withG = stops.filter(function (id) { return hasGeo(byId(cl, id)); }), without = stops.filter(function (id) { return withG.indexOf(id) < 0; });
      if (withG.length < 2) return toast('Hacen falta al menos 2 comercios ubicados en el mapa.', true);
      var out = [withG.shift()];
      while (withG.length) {
        var cur = byId(cl, out[out.length - 1]), best = 0, bd = Infinity;
        withG.forEach(function (id, j) { var d = G().distanceM(cur, byId(cl, id)); if (d < bd) { bd = d; best = j; } });
        out.push(withG.splice(best, 1)[0]);
      }
      stops = out.concat(without); change();
      if (without.length) toast(without.length + ' sin ubicar quedaron al final');
    });
    $('#reMap', el).addEventListener('click', function () {
      var box = $('#reMapBox', el); box.hidden = !box.hidden; if (box.hidden) return;
      G().drawMap(box, stops.map(function (id, i) { var c = byId(db().clients, id) || {}; return { lat: c.lat, lng: c.lng, n: i + 1, label: '<b>' + esc(c.name) + '</b><br>' + esc(c.address || '') }; }), { line: true });
    });
    $('#reSave', el).addEventListener('click', function () {
      var body = {
        name: $('#reName', el).value.trim(), zoneId: zoneId(), sellerId: $('#reSeller', el).value, stops: stops,
        days: $$('#reDays .chip.on', el).map(function (b) { return +b.dataset.d; })
      };
      if (!body.name) { toast('Poné un nombre al recorrido', true); $('#reName', el).focus(); return; }
      if (body.sellerId) {
        var others = stops.map(function (id) { return byId(db().clients, id); }).filter(function (c) { return c && c.sellerId && c.sellerId !== body.sellerId; });
        if (others.length && !confirm(others.length + (others.length === 1 ? ' comercio está asignado' : ' comercios están asignados') + ' a otro vendedor (' +
          others.slice(0, 3).map(function (c) { return c.name + ' → ' + userName(c.sellerId); }).join(', ') + (others.length > 3 ? '…' : '') +
          '). Al guardar pasan a ' + userName(body.sellerId) + '. ¿Seguir?')) return;
      } else if (body.days.length) toast('Sin vendedor, el recorrido no arma rutas todavía.');
      var b = this; b.disabled = true;
      api(rec.id ? 'PUT' : 'POST', '/recorridos' + (rec.id ? '/' + rec.id : ''), body).then(function (r) {
        toast('Recorrido guardado' + (r.assigned ? ' · ' + r.assigned + ' comercios asignados a ' + userName(body.sellerId) : ''));
        dirty = false; sel.zoneId = body.zoneId;
        return S.refresh();
      }).then(function () { S.views.recorridos(el); }, function (e) { toast(e.message, true); b.disabled = false; });
    });
    drawStops(); drawClients();
  }
})();
