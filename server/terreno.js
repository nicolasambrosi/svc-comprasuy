// Ventas en terreno: zonas, rutas, visitas con GPS, comisiones y ubicación de clientes.
const store = require('./store');
const geocode = require('./geocode');
const { scopeOf, inScope, canSeeClient } = require('./scope');
const { round2 } = require('../app/app/calc.js');

const RESULTS = ['venta', 'pedido_pendiente', 'no_compra', 'cobro', 'cerrado', 'no_estaba', 'sin_cierre'];
const GOOD_ACCURACY = 50;      // m: con esta precisión una posición sirve para ubicar el comercio
const ADDRESS_TRUST = 1000;    // m: una ubicación sacada de la dirección se corrige si el vendedor está a menos de esto
const DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-\d{2}$/;

// Uruguay es UTC-3 todo el año.
const localDay = iso => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
const today = () => localDay(new Date().toISOString());

function distanceM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function position(b) {
  const lat = Number(b && b.lat), lng = Number(b && b.lng), acc = Number(b && b.accuracy);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat: round6(lat), lng: round6(lng), accuracy: isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}
const round6 = n => Math.round(n * 1e6) / 1e6;
const hasGeo = c => isFinite(c.lat) && isFinite(c.lng) && c.lat !== null && c.lng !== null;

module.exports = function terreno(r, h) {
  const { wrap, needUser, needAdmin, fail, str, int, uid, getSettings, PAID } = h;
  const needBoss = (req, _res, next) => (req.user && ['admin', 'supervisor'].includes(req.user.role) ? next() : wrap(async () => fail(403, 'Solo un supervisor o administrador puede hacer esto.'))(req, _res, next));

  // ---------- zonas (admin) ----------
  async function cleanZone(b, old) {
    const z = Object.assign({}, old);
    z.name = str(b.name, 80); if (!z.name) fail(400, 'La zona necesita un nombre.');
    z.supervisorId = str(b.supervisorId, 90);
    if (z.supervisorId) {
      const u = await store.get('users', z.supervisorId);
      if (!u) fail(400, 'El supervisor elegido no existe.');
      if (u.role === 'vendedor') fail(400, u.name + ' es vendedor: cambiale el rol a Supervisor para poder asignarle una zona.');
    }
    return z;
  }
  r.post('/zones', needAdmin, wrap(async (req, res) => { const z = await cleanZone(req.body); z.id = uid('z'); res.json(await store.put('zones', z)); }));
  r.put('/zones/:id', needAdmin, wrap(async (req, res) => {
    const old = await store.get('zones', req.params.id); if (!old) fail(404, 'Zona no encontrada.');
    res.json(await store.put('zones', await cleanZone(req.body, old)));
  }));
  r.delete('/zones/:id', needAdmin, wrap(async (req, res) => {
    await store.del('zones', req.params.id);
    for (const u of await store.all('users')) if (u.zoneId === req.params.id) { u.zoneId = ''; await store.put('users', u); }
    res.json({ ok: true });
  }));

  // ---------- rutas ----------
  // Una ruta = las visitas planificadas de un vendedor para un día (id fijo vendedor+día).
  r.get('/routes', needUser, wrap(async (req, res) => {
    const from = str(req.query.from || req.query.date, 10), to = str(req.query.to || from, 10);
    if (!DAY.test(from) || !DAY.test(to)) fail(400, 'Fecha inválida.');
    const sc = await scopeOf(req.user);
    res.json((await store.all('routes')).filter(x => x.date >= from && x.date <= to && inScope(sc, x.sellerId)));
  }));
  r.put('/routes', needBoss, wrap(async (req, res) => {
    const b = req.body, sc = await scopeOf(req.user);
    const seller = await store.get('users', str(b.sellerId, 90));
    if (!seller || !inScope(sc, seller.id)) fail(400, 'Ese vendedor no está a tu cargo.');
    if (!DAY.test(b.date)) fail(400, 'Fecha inválida.');
    const ids = [...new Set((Array.isArray(b.stops) ? b.stops : []).map(x => str(x, 90)).filter(Boolean))];
    if (ids.length > 200) fail(400, 'Demasiadas visitas para un día.');
    for (const id of ids) { const c = await store.get('clients', id); if (!c || !canSeeClient(sc, c)) fail(400, 'Un cliente de la ruta no existe o no es de tu equipo.'); }
    const weeks = Math.min(Math.max(int(b.repeatWeeks), 0), 12);
    const dates = [b.date];
    for (let i = 1; i <= weeks; i++) { const d = new Date(b.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * i); dates.push(d.toISOString().slice(0, 10)); }
    const saved = await store.tx(async s => {
      const out = [];
      for (const date of dates) {
        const id = 'r-' + seller.id + '-' + date;
        if (!ids.length) { await s.del('routes', id); continue; }
        out.push(await s.put('routes', { id, sellerId: seller.id, sellerName: seller.name, date, stops: ids.map(clientId => ({ clientId })), updatedBy: req.user.name, updatedAt: new Date().toISOString() }));
      }
      return out;
    });
    res.json({ ok: true, routes: saved, dates });
  }));

  // ---------- visitas ----------
  r.get('/visits', needUser, wrap(async (req, res) => {
    const q = req.query, sc = await scopeOf(req.user);
    const from = str(q.from, 10), to = str(q.to || q.from, 10), clientId = str(q.clientId, 90), sellerId = str(q.sellerId, 90);
    if (!clientId && (!DAY.test(from) || !DAY.test(to))) fail(400, 'Fecha inválida.');
    let list = (await store.all('visits')).filter(v => inScope(sc, v.sellerId) && (!sellerId || v.sellerId === sellerId));
    if (clientId) list = list.filter(v => v.clientId === clientId).sort((a, b) => b.checkIn.ts.localeCompare(a.checkIn.ts)).slice(0, 20);
    else list = list.filter(v => v.date >= from && v.date <= to);
    res.json(list);
  }));

  r.post('/visits/checkin', needUser, wrap(async (req, res) => {
    const b = req.body, sc = await scopeOf(req.user), settings = await getSettings();
    const client = await store.get('clients', str(b.clientId, 90));
    if (!client || !canSeeClient(sc, client)) fail(400, 'El cliente no existe o no está asignado a tu usuario.');
    const date = DAY.test(b.date) ? b.date : today();
    const mine = (await store.all('visits')).filter(v => v.sellerId === req.user.id && !v.checkOut);
    for (const v of mine) {
      if (v.date < date) { v.checkOut = { ts: new Date().toISOString(), auto: true }; v.result = v.result || 'sin_cierre'; await store.put('visits', v); }
      else fail(409, 'Primero cerrá la visita a ' + v.clientName + '.');
    }
    const pos = position(b), now = new Date().toISOString();
    const visit = {
      id: uid('v'), date, clientId: client.id, clientName: client.name, sellerId: req.user.id, sellerName: req.user.name,
      routeId: '', checkIn: Object.assign({ ts: now, deviceTs: str(b.deviceTs, 40) }, pos || {}), saleIds: []
    };
    const route = await store.get('routes', 'r-' + req.user.id + '-' + date);
    if (route && route.stops.some(s => s.clientId === client.id)) visit.routeId = route.id;

    // Validación GPS combinada con la ubicación del comercio
    const radius = settings.gpsRadius || 100;
    if (!pos) visit.gpsStatus = 'sin_gps';
    else if (!hasGeo(client)) {
      if (pos.accuracy !== null && pos.accuracy <= GOOD_ACCURACY) { setClientGeo(client, pos, 'vendedor', req.user.name); visit.gpsStatus = 'ok'; visit.located = true; }
      else visit.gpsStatus = 'sin_referencia'; // el comercio todavía no tiene ubicación y el GPS es impreciso
    } else {
      visit.distanceM = distanceM(pos, client);
      const approx = client.geoSource === 'direccion';
      if (pos.accuracy !== null && pos.accuracy > 100) visit.gpsStatus = 'baja_precision';
      else if (approx && visit.distanceM <= ADDRESS_TRUST && pos.accuracy !== null && pos.accuracy <= GOOD_ACCURACY) {
        setClientGeo(client, pos, 'vendedor', req.user.name); visit.gpsStatus = 'ok'; visit.located = true; // primera visita: se corrige la ubicación aproximada
      } else visit.gpsStatus = visit.distanceM <= radius ? 'ok' : 'lejos';
    }
    if (visit.located) await store.put('clients', client);
    await store.put('visits', visit);
    res.json({ visit, client });
  }));
  function setClientGeo(c, pos, source, by) { c.lat = pos.lat; c.lng = pos.lng; c.geoSource = source; c.geoBy = by; c.geoAt = new Date().toISOString(); delete c.geoFailed; }

  r.post('/visits/:id/checkout', needUser, wrap(async (req, res) => {
    const b = req.body, v = await store.get('visits', req.params.id);
    if (!v || v.sellerId !== req.user.id) fail(404, 'Visita no encontrada.');
    if (v.checkOut) fail(400, 'La visita ya está cerrada.');
    if (!RESULTS.includes(b.result) || b.result === 'sin_cierre') fail(400, 'Elegí el resultado de la visita.');
    const now = new Date().toISOString(), pos = position(b);
    v.checkOut = Object.assign({ ts: now, deviceTs: str(b.deviceTs, 40) }, pos || {});
    v.result = b.result; v.reason = str(b.reason, 80); v.note = str(b.note, 1000);
    // ventas hechas a este cliente durante la visita
    v.saleIds = (await store.all('sales')).filter(s => s.userId === req.user.id && s.clientId === v.clientId && s.status !== 'anulada' && s.date >= v.checkIn.ts && s.date <= now).map(s => s.id);
    res.json(await store.put('visits', v));
  }));

  // El supervisor confirma que la ubicación de una visita es la del comercio.
  r.post('/visits/:id/use-location', needBoss, wrap(async (req, res) => {
    const sc = await scopeOf(req.user), v = await store.get('visits', req.params.id);
    if (!v || !inScope(sc, v.sellerId) || !position(v.checkIn)) fail(404, 'Visita sin ubicación.');
    const c = await store.get('clients', v.clientId); if (!c) fail(404, 'Cliente no encontrado.');
    setClientGeo(c, position(v.checkIn), 'supervisor', req.user.name);
    await store.put('clients', c);
    v.gpsStatus = 'ok'; v.distanceM = 0; v.located = true; v.locatedBy = req.user.name;
    await store.put('visits', v);
    res.json({ visit: v, client: c });
  }));

  // ---------- comisiones ----------
  // % sobre el neto (sin IVA, con descuento) de las ventas COBRADAS en el mes (fecha de cobro).
  // El supervisor cobra además un % sobre lo cobrado por los vendedores de sus zonas.
  // El vendedor ve su comisión solo cuando su supervisor (o un administrador) la aprueba.
  async function commissionRows(month, sc) {
    const [users, sales, zones, approvals] = await Promise.all([store.all('users'), store.all('sales'), store.all('zones'), store.all('commissions')]);
    const paidIn = s => PAID.includes(s.status) && localDay(s.paidAt || s.date).slice(0, 7) === month;
    const netBy = {}, pendingBy = {};
    for (const s of sales) {
      if (paidIn(s)) netBy[s.userId] = (netBy[s.userId] || 0) + (s.subtotal || 0);
      if (s.status === 'pendiente') pendingBy[s.userId] = (pendingBy[s.userId] || 0) + (s.subtotal || 0);
    }
    return users.filter(u => inScope(sc, u.id)).map(u => {
      const pct = u.commissionPct || 0, net = round2(netBy[u.id] || 0);
      let teamNet = 0, teamPct = 0, team = [];
      if (u.role === 'supervisor') {
        const zs = zones.filter(z => z.supervisorId === u.id).map(z => z.id);
        team = users.filter(x => x.id !== u.id && x.zoneId && zs.includes(x.zoneId));
        teamNet = round2(team.reduce((a, x) => a + (netBy[x.id] || 0), 0));
        teamPct = u.teamCommissionPct || 0;
      }
      const commission = round2(net * pct / 100), teamCommission = round2(teamNet * teamPct / 100);
      const row = {
        userId: u.id, name: u.name, role: u.role, month, net, pct, commission, teamNet, teamPct, teamCommission, teamSize: team.length,
        total: round2(commission + teamCommission), pendingNet: round2(pendingBy[u.id] || 0)
      };
      const ap = approvals.find(a => a.id === month + '|' + u.id);
      if (ap) { row.approval = ap; row.changed = ap.total !== row.total; }
      return row;
    });
  }
  const canApprove = (me, sc, userId) => me.role === 'admin' || (me.role === 'supervisor' && userId !== me.id && inScope(sc, userId));

  r.get('/commissions', needUser, wrap(async (req, res) => {
    const month = str(req.query.month, 7); if (!MONTH.test(month)) fail(400, 'Mes inválido.');
    const sc = await scopeOf(req.user);
    let rows = await commissionRows(month, sc);
    if (req.user.role === 'vendedor') {
      // el vendedor solo ve lo que su supervisor aprobó
      rows = rows.filter(x => x.userId === req.user.id).map(x => x.approval
        ? { userId: x.userId, name: x.name, month, approval: x.approval }
        : { userId: x.userId, name: x.name, month, approval: null });
    } else rows.forEach(x => { x.canApprove = canApprove(req.user, sc, x.userId); });
    res.json(rows);
  }));
  r.post('/commissions/approve', needBoss, wrap(async (req, res) => {
    const month = str(req.body.month, 7), userId = str(req.body.userId, 90);
    if (!MONTH.test(month)) fail(400, 'Mes inválido.');
    const sc = await scopeOf(req.user);
    if (!canApprove(req.user, sc, userId)) fail(403, 'No podés aprobar esta comisión.');
    const row = (await commissionRows(month, sc)).find(x => x.userId === userId); if (!row) fail(404, 'Usuario no encontrado.');
    const ap = {
      id: month + '|' + userId, userId, month, net: row.net, pct: row.pct, commission: row.commission,
      teamNet: row.teamNet, teamPct: row.teamPct, teamCommission: row.teamCommission, total: row.total,
      approvedBy: req.user.name, approvedById: req.user.id, approvedAt: new Date().toISOString()
    };
    res.json(await store.put('commissions', ap));
  }));
  r.delete('/commissions/approve', needBoss, wrap(async (req, res) => {
    const month = str(req.query.month, 7), userId = str(req.query.userId, 90), sc = await scopeOf(req.user);
    if (!canApprove(req.user, sc, userId)) fail(403, 'No podés cambiar esta comisión.');
    await store.del('commissions', month + '|' + userId);
    res.json({ ok: true });
  }));

  // ---------- ubicar clientes desde su dirección (admin) ----------
  r.get('/geocode', needAdmin, (req, res) => res.json(geocode.status()));
  r.post('/geocode', needAdmin, wrap(async (req, res) => { res.json(await geocode.start({ retryFailed: !!req.body.retryFailed })); }));
};

