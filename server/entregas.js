// Entregas: camiones, rutas de reparto por día y turno, entrega y cobro del chofer, avisos y estadísticas.
//  - Cada venta puede llevar delivery: { day: 'AAAA-MM-DD', shift: 'manana'|'tarde', truckId, status, routeId, ... }.
//  - Logística (o un administrador) arma la ruta de cada camión para un día y turno: una parada por cliente
//    (se juntan las ventas del mismo cliente), ordenada para recorrer menos. Al guardarla, el chofer la recibe.
//  - El chofer empieza la ruta (avisa "en camino"), marca cada parada entregada o no entregada y registra el cobro
//    (avisa al vendedor y a los administradores). El GPS del chofer durante la ruta da los km recorridos.
const store = require('./store');
const { round2 } = require('../app/app/calc.js');

const SHIFTS = { manana: 'mañana', tarde: 'tarde' };
const PAY_METHODS = ['Efectivo', 'Transferencia', 'Débito', 'Crédito', 'Cuenta corriente'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const localDay = iso => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
const today = () => localDay(new Date().toISOString());
const isLog = u => u && (u.role === 'admin' || u.role === 'logistica');
const distM = (a, b) => {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtDay = d => { const x = new Date(d + 'T12:00:00'); return ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][x.getDay()] + ' ' + x.getDate() + '/' + (x.getMonth() + 1); };
const due = s => (s.status === 'pendiente' ? s.total : 0); // lo que falta cobrar

// Lo que ven logística y choferes de una venta (las de la lista privada REMAR van sin detalle ni importes)
function saleForDelivery(s) {
  const base = { id: s.id, number: s.number, date: s.date, clientId: s.clientId, clientName: s.clientName, deliveryAddress: s.deliveryAddress || '', deliveryPhone: s.deliveryPhone || '', notes: s.notes || '', delivery: s.delivery, userId: s.userId, userName: s.userName, status: s.status };
  if (s.list === 'remar') return Object.assign(base, { private: true, items: [], total: 0, due: 0, payment: '' });
  return Object.assign(base, { items: s.items.map(it => ({ name: it.name, qty: it.qty })), total: s.total, due: due(s), payment: s.payment });
}

module.exports = function entregas(r, h) {
  const { wrap, needUser, fail, str, uid } = h;
  const needLog = (req, _res, next) => (isLog(req.user) ? next() : wrap(async () => fail(403, 'Solo logística o un administrador puede hacer esto.'))(req, _res, next));

  // ---------- avisos ----------
  async function notify(userIds, text, extra) {
    const at = new Date().toISOString();
    for (const id of new Set(userIds.filter(Boolean))) {
      await store.put('notices', Object.assign({ id: uid('n'), userId: id, text, createdAt: at, read: false }, extra || {}));
    }
  }
  async function adminIds() { return (await store.all('users')).filter(u => u.role === 'admin' && u.active !== false).map(u => u.id); }
  r.get('/notices', needUser, wrap(async (req, res) => {
    const mine = (await store.all('notices')).filter(n => n.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ unread: mine.filter(n => !n.read).length, items: mine.slice(0, 60) });
  }));
  r.post('/notices/read', needUser, wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => str(x, 90)) : null;
    for (const n of await store.all('notices')) if (n.userId === req.user.id && !n.read && (!ids || ids.includes(n.id))) { n.read = true; await store.put('notices', n); }
    res.json({ ok: true });
  }));
  // borra avisos de más de 60 días
  (async () => { try { const lim = new Date(Date.now() - 60 * 864e5).toISOString(); for (const n of await store.all('notices')) if (n.createdAt < lim) await store.del('notices', n.id); } catch (e) { /* nada */ } })();

  // ---------- camiones ----------
  async function cleanTruck(b, old) {
    const t = Object.assign({}, old);
    t.name = str(b.name, 60); if (!t.name) fail(400, 'El camión necesita un nombre (ej.: Camión 1).');
    t.plate = str(b.plate, 20).toUpperCase();
    t.driverId = str(b.driverId, 90);
    if (t.driverId) { const u = await store.get('users', t.driverId); if (!u || u.role !== 'chofer') fail(400, 'El chofer elegido no es un usuario con rol Chofer.'); }
    t.capacity = str(b.capacity, 60);
    t.active = b.active !== false && b.active !== '0';
    return t;
  }
  r.post('/trucks', needLog, wrap(async (req, res) => { const t = await cleanTruck(req.body); t.id = uid('t'); res.json(await store.put('trucks', t)); }));
  r.put('/trucks/:id', needLog, wrap(async (req, res) => {
    const old = await store.get('trucks', req.params.id); if (!old) fail(404, 'Camión no encontrado.');
    res.json(await store.put('trucks', await cleanTruck(req.body, old)));
  }));
  r.delete('/trucks/:id', needLog, wrap(async (req, res) => {
    const busy = (await store.all('delivroutes')).some(x => x.truckId === req.params.id && ['lista', 'en_curso'].includes(x.status));
    if (busy) fail(400, 'El camión tiene una ruta guardada o en curso. Terminala o pasá las entregas a otro camión.');
    await store.del('trucks', req.params.id);
    for (const s of await store.all('sales')) if (s.delivery && s.delivery.truckId === req.params.id && s.delivery.status === 'pendiente') { s.delivery.truckId = ''; await store.put('sales', s); }
    res.json({ ok: true });
  }));

  // ---------- datos de entrega de una venta ----------
  async function cleanDelivery(b, old) {
    if (!b || b.day === '' || b.day == null) return null; // sin entrega
    const d = Object.assign({ status: 'pendiente' }, old);
    d.day = str(b.day, 10); if (!DAY.test(d.day)) fail(400, 'Elegí el día de entrega.');
    d.shift = SHIFTS[b.shift] ? b.shift : 'manana';
    d.truckId = str(b.truckId, 90);
    if (d.truckId && !(await store.get('trucks', d.truckId))) fail(400, 'El camión elegido no existe.');
    d.note = str(b.note, 200);
    return d;
  }
  h.cleanDelivery = cleanDelivery;
  // cambiar día, turno o camión de una venta (logística, o quien hizo la venta mientras no salió)
  r.put('/sales/:id/delivery', needUser, wrap(async (req, res) => {
    const s = await store.get('sales', req.params.id); if (!s) fail(404, 'Venta no encontrada.');
    const sc = await h.scopeOf(req.user);
    if (!isLog(req.user) && !h.canSeeSale(sc, s)) fail(404, 'Venta no encontrada.');
    if (s.status === 'anulada') fail(400, 'La venta está anulada.');
    if (s.delivery && ['en_ruta', 'entregada'].includes(s.delivery.status)) fail(400, 'La entrega ya salió o ya se hizo.');
    const prev = s.delivery || {};
    const d = await cleanDelivery(req.body, prev);
    // dirección y teléfono de entrega (sirve también para ventas a Consumidor final)
    if (req.body.deliveryAddress !== undefined) s.deliveryAddress = str(req.body.deliveryAddress, 200);
    if (req.body.deliveryPhone !== undefined) s.deliveryPhone = str(req.body.deliveryPhone, 40);
    if (d && !s.clientId && !s.deliveryAddress) fail(400, 'Poné la dirección de entrega.');
    // si cambia de día, turno o camión, sale de la ruta guardada
    if (prev.routeId && (!d || d.day !== prev.day || d.shift !== prev.shift || d.truckId !== prev.truckId)) {
      const rt = await store.get('delivroutes', prev.routeId);
      if (rt && rt.status !== 'terminada') { rt.stops.forEach(st => { st.saleIds = st.saleIds.filter(x => x !== s.id); }); rt.stops = rt.stops.filter(st => st.saleIds.length); await store.put('delivroutes', rt); }
      if (d) delete d.routeId;
    }
    // reprogramar una que no se entregó: vuelve a quedar por entregar (el motivo queda como historial)
    if (d && d.status === 'no_entregada') { d.status = 'pendiente'; d.lastFail = d.failReason; delete d.failReason; delete d.failedAt; }
    if (d) s.delivery = d; else delete s.delivery;
    res.json(await store.put('sales', s));
  }));

  // ---------- planificación (logística) ----------
  r.get('/deliveries', needLog, wrap(async (req, res) => {
    const day = str(req.query.day, 10), shift = req.query.shift;
    if (!DAY.test(day) || !SHIFTS[shift]) fail(400, 'Elegí día y turno.');
    const [sales, clients, routes, trucks, settings] = await Promise.all([store.all('sales'), store.all('clients'), store.all('delivroutes'), store.all('trucks'), store.get('settings', 'main')]);
    const list = sales.filter(s => s.delivery && s.delivery.day === day && s.delivery.shift === shift && s.status !== 'anulada');
    const cids = new Set(list.map(s => s.clientId).filter(Boolean));
    // ventas sin entrega asignada (para sumarlas) y cuántas entregas hay por día en los próximos días
    const upcoming = {};
    for (const s of sales) if (s.delivery && s.status !== 'anulada' && s.delivery.status === 'pendiente' && s.delivery.day >= today()) { const k = s.delivery.day + '|' + s.delivery.shift; upcoming[k] = (upcoming[k] || 0) + 1; }
    res.json({
      day, shift, depot: (settings && settings.depot) || null, trucks,
      sales: list.map(saleForDelivery),
      clients: clients.filter(c => cids.has(c.id)).map(c => ({ id: c.id, name: c.name, address: c.address, phone: c.phone, lat: c.lat, lng: c.lng })),
      routes: routes.filter(x => x.day === day && x.shift === shift),
      upcoming
    });
  }));
  r.put('/deliveries/depot', needLog, wrap(async (req, res) => {
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Ubicación inválida.');
    const s = Object.assign({ id: 'main' }, await store.get('settings', 'main'));
    s.depot = { lat, lng, address: str(req.body.address, 200) };
    await store.put('settings', s);
    res.json(s.depot);
  }));
  // guardar la ruta de un camión (día + turno): queda "lista" y el chofer la recibe
  r.post('/delivroutes', needLog, wrap(async (req, res) => {
    const b = req.body, day = str(b.day, 10), shift = b.shift;
    if (!DAY.test(day) || !SHIFTS[shift]) fail(400, 'Elegí día y turno.');
    const truck = await store.get('trucks', str(b.truckId, 90)); if (!truck) fail(400, 'Elegí el camión.');
    const id = truck.id + '|' + day + '|' + shift;
    const old = await store.get('delivroutes', id);
    if (old && old.status !== 'lista' && old.status !== 'borrador') fail(400, 'Esa ruta ya empezó: no se puede cambiar.');
    const stopsIn = Array.isArray(b.stops) ? b.stops : [];
    if (!stopsIn.length) fail(400, 'La ruta no tiene entregas.');
    const stops = [], saleIds = new Set();
    for (const st of stopsIn) {
      const ids = (Array.isArray(st.saleIds) ? st.saleIds : []).map(x => str(x, 90));
      const ok = [];
      for (const sid of ids) {
        const s = await store.get('sales', sid);
        if (!s || !s.delivery || s.status === 'anulada' || s.delivery.day !== day || s.delivery.shift !== shift) continue;
        if (s.delivery.status === 'entregada') continue;
        ok.push(sid); saleIds.add(sid);
      }
      if (ok.length) stops.push({ clientId: str(st.clientId, 90), clientName: str(st.clientName, 150), address: str(st.address, 200), lat: typeof st.lat === 'number' ? st.lat : null, lng: typeof st.lng === 'number' ? st.lng : null, saleIds: ok, result: '' });
    }
    if (!stops.length) fail(400, 'Ninguna de esas ventas es de ese día y turno.');
    const settings = await store.get('settings', 'main');
    const rt = Object.assign(old || {}, {
      id, truckId: truck.id, truckName: truck.name, driverId: truck.driverId || '', day, shift, stops,
      plannedKm: round2(Number(b.plannedKm) || 0), depot: (settings && settings.depot) || null,
      status: 'lista', savedAt: new Date().toISOString(), savedBy: req.user.name
    });
    await store.put('delivroutes', rt);
    // las ventas quedan en este camión y esta ruta; las que estaban en esta ruta y se sacaron, sin ruta
    for (const s of await store.all('sales')) {
      if (!s.delivery) continue;
      if (saleIds.has(s.id)) { s.delivery.truckId = truck.id; s.delivery.routeId = id; await store.put('sales', s); }
      else if (s.delivery.routeId === id) { delete s.delivery.routeId; await store.put('sales', s); }
    }
    if (truck.driverId) await notify([truck.driverId], '🚚 Tenés una ruta para el ' + fmtDay(day) + ' (' + SHIFTS[shift] + ') en ' + truck.name + ': ' + stops.length + ' entrega' + (stops.length > 1 ? 's' : '') + '.', { routeId: id, kind: 'ruta' });
    res.json(rt);
  }));
  r.delete('/delivroutes/:id', needLog, wrap(async (req, res) => {
    const rt = await store.get('delivroutes', req.params.id); if (!rt) fail(404, 'Ruta no encontrada.');
    if (rt.status === 'en_curso') fail(400, 'La ruta está en curso.');
    if (rt.status === 'terminada') fail(400, 'La ruta ya terminó: queda para las estadísticas.');
    await store.del('delivroutes', rt.id);
    for (const s of await store.all('sales')) if (s.delivery && s.delivery.routeId === rt.id) { delete s.delivery.routeId; await store.put('sales', s); }
    res.json({ ok: true });
  }));

  // ---------- chofer ----------
  async function routeForUser(req, id) {
    const rt = await store.get('delivroutes', id); if (!rt) fail(404, 'Ruta no encontrada.');
    if (!isLog(req.user) && rt.driverId !== req.user.id) fail(404, 'Ruta no encontrada.');
    return rt;
  }
  async function routeDetail(rt) {
    const ids = new Set(rt.stops.flatMap(st => st.saleIds));
    const sales = (await store.all('sales')).filter(s => ids.has(s.id)).map(saleForDelivery);
    const cids = new Set(rt.stops.map(st => st.clientId).filter(Boolean));
    const clients = (await store.all('clients')).filter(c => cids.has(c.id)).map(c => ({ id: c.id, name: c.name, address: c.address, phone: c.phone, lat: c.lat, lng: c.lng }));
    return Object.assign({}, rt, { track: undefined, trackCount: (rt.track || []).length, sales, clients });
  }
  r.get('/delivroutes/mine', needUser, wrap(async (req, res) => {
    const from = localDay(new Date(Date.now() - 2 * 864e5).toISOString());
    const list = (await store.all('delivroutes')).filter(x => x.driverId === req.user.id && x.day >= from && x.status !== 'borrador')
      .sort((a, b) => (a.day + a.shift).localeCompare(b.day + b.shift));
    res.json(await Promise.all(list.map(routeDetail)));
  }));
  r.get('/delivroutes/:id', needUser, wrap(async (req, res) => { res.json(await routeDetail(await routeForUser(req, req.params.id))); }));

  async function noticeSales(saleIds, textFor) {
    const admins = await adminIds();
    for (const sid of saleIds) {
      const s = await store.get('sales', sid); if (!s) continue;
      await notify([s.userId].concat(admins), textFor(s), { saleId: s.id, kind: 'entrega' });
    }
  }
  r.post('/delivroutes/:id/start', needUser, wrap(async (req, res) => {
    const rt = await routeForUser(req, req.params.id);
    if (rt.status !== 'lista') fail(400, rt.status === 'en_curso' ? 'La ruta ya está en curso.' : 'La ruta ya terminó.');
    rt.status = 'en_curso'; rt.startedAt = new Date().toISOString(); rt.startedBy = req.user.name; rt.track = [];
    const p = req.body.pos; if (p && isFinite(p.lat) && isFinite(p.lng)) rt.track.push({ lat: +p.lat, lng: +p.lng, t: Date.now() });
    await store.put('delivroutes', rt);
    const ids = rt.stops.filter(st => !st.result).flatMap(st => st.saleIds);
    for (const sid of ids) { const s = await store.get('sales', sid); if (s && s.delivery) { s.delivery.status = 'en_ruta'; await store.put('sales', s); } }
    await noticeSales(ids, s => '🚚 En camino: venta N.º ' + s.number + ' a ' + s.clientName + ' (' + rt.truckName + ').');
    res.json(await routeDetail(rt));
  }));
  // puntos de GPS mientras la ruta está en curso (para los km recorridos)
  r.post('/delivroutes/:id/track', needUser, wrap(async (req, res) => {
    const rt = await routeForUser(req, req.params.id);
    if (rt.status !== 'en_curso') return res.json({ ok: false });
    const pts = (Array.isArray(req.body.points) ? req.body.points : []).slice(0, 500)
      .filter(p => p && isFinite(p.lat) && isFinite(p.lng) && (!p.acc || p.acc <= 60))
      .map(p => ({ lat: +p.lat, lng: +p.lng, t: +p.t || Date.now() }));
    rt.track = (rt.track || []).concat(pts).slice(-5000);
    await store.put('delivroutes', rt);
    res.json({ ok: true, n: rt.track.length });
  }));
  // entregar (o no) una parada y registrar el cobro
  r.post('/delivroutes/:id/stops/:i', needUser, wrap(async (req, res) => {
    const rt = await routeForUser(req, req.params.id);
    if (rt.status !== 'en_curso') fail(400, 'Primero tocá "Empezar ruta".');
    const st = rt.stops[Number(req.params.i)]; if (!st) fail(404, 'Parada no encontrada.');
    if (st.result) fail(400, 'Esa parada ya está cerrada.');
    const result = req.body.result === 'no_entregada' ? 'no_entregada' : 'entregada';
    const now = new Date().toISOString(), note = str(req.body.note, 300);
    let collected = 0;
    if (result === 'entregada') {
      const method = PAY_METHODS.includes(req.body.method) ? req.body.method : 'Efectivo';
      const amount = Math.max(0, round2(Number(String(req.body.amount || 0).replace(',', '.')) || 0));
      let left = amount;
      for (const sid of st.saleIds) {
        const s = await store.get('sales', sid); if (!s || !s.delivery) continue;
        s.delivery.status = 'entregada'; s.delivery.deliveredAt = now; s.delivery.deliveredBy = req.user.name;
        if (note) s.delivery.deliveryNote = note;
        if (s.status === 'pendiente' && s.list !== 'remar' && method !== 'Cuenta corriente' && left > 0) {
          const pay = Math.min(left, s.total); left = round2(left - pay); collected = round2(collected + pay);
          s.delivery.collected = { amount: pay, method, at: now, by: req.user.name };
          if (pay >= s.total - 0.009) { s.status = 'entregada'; s.paidAt = now; s.payment = method; } // cobrada: cuenta para la comisión
        } else if (s.status !== 'pendiente') s.status = 'entregada';
        await store.put('sales', s);
      }
      st.collected = collected; st.method = method;
    } else {
      st.reason = str(req.body.reason, 80) || 'No se pudo entregar';
      for (const sid of st.saleIds) {
        const s = await store.get('sales', sid); if (!s || !s.delivery) continue;
        s.delivery.status = 'no_entregada'; s.delivery.failedAt = now; s.delivery.failReason = st.reason + (note ? ': ' + note : '');
        delete s.delivery.routeId;
        await store.put('sales', s);
      }
    }
    st.result = result; st.at = now; st.note = note;
    const p = req.body.pos; if (p && isFinite(p.lat) && isFinite(p.lng)) { st.pos = { lat: +p.lat, lng: +p.lng }; rt.track = (rt.track || []).concat([{ lat: +p.lat, lng: +p.lng, t: Date.now() }]); }
    if (rt.stops.every(x => x.result)) finish(rt, req.user.name);
    await store.put('delivroutes', rt);
    await noticeSales(st.saleIds, s => result === 'entregada'
      ? '✅ Entregada: venta N.º ' + s.number + ' a ' + s.clientName + (s.delivery && s.delivery.collected ? ' · cobró $' + s.delivery.collected.amount.toLocaleString('es-UY') + ' (' + s.delivery.collected.method + ')' : s.status === 'pendiente' ? ' · quedó pendiente de cobro' : '') + '.'
      : '⚠️ No se entregó: venta N.º ' + s.number + ' a ' + s.clientName + ' · ' + st.reason + (note ? ' (' + note + ')' : '') + '. Hay que reprogramarla.');
    res.json(await routeDetail(rt));
  }));
  function trackKm(track) {
    let m = 0;
    for (let i = 1; i < (track || []).length; i++) { const d = distM(track[i - 1], track[i]); if (d < 5000) m += d; } // saltos raros fuera
    return round2(m / 1000);
  }
  function finish(rt, by) {
    rt.status = 'terminada'; rt.finishedAt = new Date().toISOString(); rt.finishedBy = by;
    rt.trackKm = trackKm(rt.track);
    rt.minutes = rt.startedAt ? Math.round((Date.parse(rt.finishedAt) - Date.parse(rt.startedAt)) / 60000) : 0;
  }
  r.post('/delivroutes/:id/finish', needUser, wrap(async (req, res) => {
    const rt = await routeForUser(req, req.params.id);
    if (rt.status !== 'en_curso') fail(400, 'La ruta no está en curso.');
    // lo que quedó sin cerrar vuelve a pendiente para reprogramar
    for (const st of rt.stops) if (!st.result) {
      st.result = 'no_entregada'; st.reason = 'Sin visitar';
      for (const sid of st.saleIds) { const s = await store.get('sales', sid); if (s && s.delivery) { s.delivery.status = 'pendiente'; delete s.delivery.routeId; await store.put('sales', s); } }
    }
    finish(rt, req.user.name);
    await store.put('delivroutes', rt);
    res.json(await routeDetail(rt));
  }));

  // ---------- estadísticas por camión ----------
  r.get('/delivstats', needLog, wrap(async (req, res) => {
    const from = str(req.query.from, 10), to = str(req.query.to, 10);
    const routes = (await store.all('delivroutes')).filter(x => x.status === 'terminada' && (!DAY.test(from) || x.day >= from) && (!DAY.test(to) || x.day <= to));
    const trucks = await store.all('trucks');
    const rows = trucks.map(t => {
      const rs = routes.filter(x => x.truckId === t.id);
      const stops = rs.reduce((a, x) => a + x.stops.length, 0), ok = rs.reduce((a, x) => a + x.stops.filter(s => s.result === 'entregada').length, 0);
      const km = rs.map(x => x.trackKm > 0.2 ? x.trackKm : x.plannedKm || 0), mins = rs.map(x => x.minutes || 0).filter(Boolean);
      const sum = a => a.reduce((s, x) => s + x, 0);
      return {
        truckId: t.id, name: t.name, plate: t.plate, routes: rs.length, stops, delivered: ok,
        kmTotal: round2(sum(km)), kmAvg: rs.length ? round2(sum(km) / rs.length) : 0,
        minAvg: mins.length ? Math.round(sum(mins) / mins.length) : 0,
        minPerStop: ok ? Math.round(sum(mins) / Math.max(1, ok)) : 0,
        kmPerStop: ok ? round2(sum(km) / ok) : 0,
        gpsRoutes: rs.filter(x => x.trackKm > 0.2).length,
        collected: round2(rs.reduce((a, x) => a + x.stops.reduce((b, s) => b + (s.collected || 0), 0), 0))
      };
    });
    res.json({ rows, routes: routes.sort((a, b) => b.day.localeCompare(a.day)).slice(0, 100).map(x => ({ id: x.id, day: x.day, shift: x.shift, truckName: x.truckName, stops: x.stops.length, delivered: x.stops.filter(s => s.result === 'entregada').length, km: x.trackKm > 0.2 ? x.trackKm : x.plannedKm, gps: x.trackKm > 0.2, minutes: x.minutes, startedAt: x.startedAt, finishedAt: x.finishedAt })) });
  }));
};
module.exports.saleForDelivery = saleForDelivery;
module.exports.SHIFTS = SHIFTS;
