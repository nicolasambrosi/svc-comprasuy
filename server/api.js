// API de SVC: /api/...
const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const auth = require('./auth');
const images = require('./images');
const { scopeOf, inScope, canSeeClient, canSeeSale } = require('./scope');
const { calcSale, num, round2 } = require('../app/app/calc.js');

const STATUSES = ['pagada', 'pendiente', 'entregada', 'anulada'];
const PAYMENTS = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'Cuenta corriente'];
const IVAS = [22, 10, 0];
const DEFAULT_SETTINGS = { id: 'main', company: 'Comprasuy', rut: '', address: '', phone: '', email: '', nextNumber: 1, lowStockDefault: 5, gpsRadius: 100 };
const PAID = ['pagada', 'entregada']; // estados que cuentan como cobrados (para comisiones)

const uid = p => p + '-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max || 200);
const int = v => Math.round(num(v));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const needUser = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Iniciá sesión.')));
const needAdmin = (req, _res, next) => (!req.user ? next(new HttpError(401, 'Iniciá sesión.'))
  : req.user.role === 'admin' ? next() : next(new HttpError(403, 'Solo un administrador puede hacer esto.')));

async function getSettings(s) { return Object.assign({}, DEFAULT_SETTINGS, await (s || store).get('settings', 'main')); }

function cleanProduct(b, old) {
  const p = Object.assign({}, old);
  p.name = str(b.name, 150); if (!p.name) fail(400, 'El producto necesita un nombre.');
  p.code = str(b.code, 60); p.category = str(b.category, 60); p.description = str(b.description, 300);
  p.cost = Math.max(0, round2(num(b.cost))); p.price = Math.max(0, round2(num(b.price)));
  p.iva = IVAS.includes(int(b.iva)) ? int(b.iva) : 22;
  if (!old || b.stock !== undefined) p.stock = int(b.stock);
  p.minStock = Math.max(0, int(b.minStock));
  p.list = listOf(b.list === undefined && old ? old.list : b.list);
  return p;
}
// Dos listas de precios: comercios (por defecto) y residenciales e instituciones.
const LISTS = ['comercio', 'institucion'];
const listOf = v => (v === 'institucion' ? 'institucion' : 'comercio');
function cleanClient(b, old) {
  const c = Object.assign({}, old);
  c.name = str(b.name, 150); if (!c.name) fail(400, 'El cliente necesita un nombre.');
  c.doc = str(b.doc, 30); c.phone = str(b.phone, 40); c.email = str(b.email, 120); c.address = str(b.address, 200); c.notes = str(b.notes, 1000);
  return c;
}
// Cada cliente puede tener un vendedor asignado (sellerId). Ver server/scope.js para quién ve qué.
const pct = v => Math.min(Math.max(round2(num(v)), 0), 100);
async function userExtras(b, old) {
  const o = {};
  if (b.zoneId !== undefined) { o.zoneId = str(b.zoneId, 90); if (o.zoneId && !(await store.get('zones', o.zoneId))) fail(400, 'La zona elegida no existe.'); }
  if (b.commissionPct !== undefined) o.commissionPct = pct(b.commissionPct);
  if (b.teamCommissionPct !== undefined) o.teamCommissionPct = pct(b.teamCommissionPct);
  return o;
}
async function sellerIdFrom(v) {
  const id = str(v, 90); if (!id) return '';
  if (!(await store.get('users', id))) fail(400, 'El vendedor elegido no existe.');
  return id;
}

module.exports = function api() {
  const r = express.Router();
  r.use(express.json({ limit: '20mb' }));
  // Las escrituras solo aceptan JSON (protege contra formularios de otros sitios).
  r.use((req, _res, next) => (!['POST', 'PUT', 'PATCH'].includes(req.method) || req.is('application/json') ? next() : next(new HttpError(415, 'Se esperaba JSON.'))));
  r.use(auth.loadUser);

  // ---------- sesión ----------
  r.post('/login', wrap(async (req, res) => {
    const email = auth.normEmail(req.body.email), pw = String(req.body.password || '');
    const key = req.ip + '|' + email;
    if (auth.tooManyAttempts(key)) fail(429, 'Demasiados intentos. Esperá 15 minutos.');
    const u = await auth.findByEmail(email);
    const ok = u && u.active !== false && (await auth.verifyPassword(pw, u.passwordHash));
    if (!ok) { if (!u) await auth.hashPassword(pw); auth.noteFailure(key); fail(401, 'Email o contraseña incorrectos.'); }
    auth.clearFailures(key);
    await auth.createSession(req, res, u);
    res.json({ user: auth.publicUser(u) });
  }));
  r.post('/logout', wrap(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));
  r.get('/me', needUser, (req, res) => res.json({ user: auth.publicUser(req.user) }));
  r.post('/me/password', needUser, wrap(async (req, res) => {
    if (!(await auth.verifyPassword(String(req.body.current || ''), req.user.passwordHash))) fail(400, 'La contraseña actual no es correcta.');
    const err = auth.passwordError(req.body.password); if (err) fail(400, err);
    req.user.passwordHash = await auth.hashPassword(req.body.password);
    await store.put('users', req.user);
    res.json({ ok: true });
  }));

  // ---------- todos los datos visibles para el usuario ----------
  r.get('/data', needUser, wrap(async (req, res) => {
    const sc = await scopeOf(req.user);
    const [products, clients, sales, settings, users, zones] = await Promise.all([
      store.all('products'), store.all('clients'), store.all('sales'), getSettings(), store.all('users'), store.all('zones')
    ]);
    res.json({
      me: auth.publicUser(req.user), settings, products, clients: clients.filter(c => canSeeClient(sc, c)),
      sales: sales.filter(s => canSeeSale(sc, s)),
      // admin: todos; supervisor: su equipo; vendedor: nadie más
      users: req.user.role === 'vendedor' ? [] : users.filter(u => inScope(sc, u.id)).map(auth.publicUser),
      zones,
      storage: store.kind
    });
  }));

  // ---------- productos (admin) ----------
  r.post('/products', needAdmin, wrap(async (req, res) => {
    const p = cleanProduct(req.body); p.id = uid('p');
    const all = await store.all('products');
    if (p.code && all.some(x => x.code && x.code.toLowerCase() === p.code.toLowerCase())) fail(409, 'Ya existe un producto con ese código.');
    res.json(await store.put('products', p));
  }));
  r.put('/products/:id', needAdmin, wrap(async (req, res) => {
    const old = await store.get('products', req.params.id); if (!old) fail(404, 'Producto no encontrado.');
    const p = cleanProduct(req.body, old);
    const all = await store.all('products');
    if (p.code && all.some(x => x.id !== p.id && x.code && x.code.toLowerCase() === p.code.toLowerCase())) fail(409, 'Ya existe un producto con ese código.');
    res.json(await store.put('products', p));
  }));
  r.post('/products/:id/stock', needAdmin, wrap(async (req, res) => {
    const p = await store.tx(async s => {
      const p = await s.get('products', req.params.id); if (!p) fail(404, 'Producto no encontrado.');
      p.stock += int(req.body.delta);
      return s.put('products', p);
    });
    res.json(p);
  }));
  r.delete('/products/:id', needAdmin, wrap(async (req, res) => {
    const p = await store.get('products', req.params.id);
    await store.del('products', req.params.id);
    if (p) await images.remove(null, p.image);
    res.json({ ok: true });
  }));

  // ---------- imágenes de productos ----------
  r.put('/products/:id/image', needAdmin, wrap(async (req, res) => {
    const img = images.parseDataUrl(req.body.dataUrl);
    if (!img) fail(400, 'La imagen tiene que ser JPG, PNG o WEBP y pesar menos de 1,5 MB.');
    const p = await store.get('products', req.params.id); if (!p) fail(404, 'Producto no encontrado.');
    const old = p.image;
    p.image = await images.save(null, img);
    await store.put('products', p);
    await images.remove(null, old);
    res.json(p);
  }));
  r.delete('/products/:id/image', needAdmin, wrap(async (req, res) => {
    const p = await store.get('products', req.params.id); if (!p) fail(404, 'Producto no encontrado.');
    const old = p.image; delete p.image;
    await store.put('products', p);
    await images.remove(null, old);
    res.json(p);
  }));
  r.get('/images/:id', needUser, wrap(async (req, res) => {
    const doc = await store.get('images', req.params.id); if (!doc) fail(404, 'Imagen no encontrada.');
    // Cada imagen nueva tiene otro id, así que el navegador puede guardarla para siempre.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(doc.type).send(Buffer.from(doc.data, 'base64'));
  }));

  // ---------- clientes ----------
  r.post('/clients', needUser, wrap(async (req, res) => {
    const c = cleanClient(req.body); c.id = uid('c'); c.createdBy = req.user.id;
    // el vendedor que crea un cliente queda asignado; el administrador elige a quién (o a nadie)
    if (req.user.role === 'admin') c.sellerId = await sellerIdFrom(req.body.sellerId);
    else if (req.user.role === 'supervisor') { const sid = await sellerIdFrom(req.body.sellerId); c.sellerId = sid && inScope(await scopeOf(req.user), sid) ? sid : req.user.id; }
    else c.sellerId = req.user.id;
    res.json(await store.put('clients', c));
  }));
  // asignar varios clientes a un vendedor (o dejarlos sin asignar con sellerId vacío)
  r.post('/clients/assign', needAdmin, wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => str(x, 90)) : [];
    if (!ids.length) fail(400, 'Elegí al menos un cliente.');
    const sellerId = await sellerIdFrom(req.body.sellerId);
    const n = await store.tx(async s => {
      let count = 0;
      for (const id of ids) { const c = await s.get('clients', id); if (c) { c.sellerId = sellerId; await s.put('clients', c); count++; } }
      return count;
    });
    res.json({ ok: true, updated: n });
  }));
  r.put('/clients/:id', needUser, wrap(async (req, res) => {
    const sc = await scopeOf(req.user);
    const old = await store.get('clients', req.params.id); if (!old || !canSeeClient(sc, old)) fail(404, 'Cliente no encontrado.');
    const c = cleanClient(req.body, old);
    if (req.user.role !== 'vendedor' && req.body.sellerId !== undefined) {
      const sid = await sellerIdFrom(req.body.sellerId);
      if (req.user.role === 'admin' || (sid && inScope(sc, sid))) c.sellerId = sid;
    }
    await store.put('clients', c);
    if (c.name !== old.name) { // las ventas guardan el nombre del cliente
      for (const s of await store.all('sales')) if (s.clientId === c.id) { s.clientName = c.name; await store.put('sales', s); }
    }
    res.json(c);
  }));
  r.delete('/clients/:id', needAdmin, wrap(async (req, res) => { await store.del('clients', req.params.id); res.json({ ok: true }); }));

  // ---------- ventas ----------
  r.post('/sales', needUser, wrap(async (req, res) => {
    const b = req.body;
    const reqItems = Array.isArray(b.items) ? b.items : [];
    if (!reqItems.length) fail(400, 'La venta no tiene productos.');
    const payment = PAYMENTS.includes(b.payment) ? b.payment : 'Efectivo';
    const status = ['pagada', 'pendiente', 'entregada'].includes(b.status) ? b.status : 'pagada';
    const discountPct = Math.min(Math.max(num(b.discountPct), 0), 100);
    const client = b.clientId ? await store.get('clients', String(b.clientId)) : null;
    if (b.clientId && (!client || !canSeeClient(await scopeOf(req.user), client))) fail(400, 'El cliente no existe o no está asignado a tu usuario.');
    if (status === 'pendiente' && !client) fail(400, 'Elegí un cliente para dejar la venta pendiente de cobro.');
    if (!LISTS.includes(b.list)) fail(400, 'Elegí si la venta es para un comercio o una institución.');
    const list = b.list;

    const sale = await store.tx(async s => {
      const settings = await getSettings(s);
      const items = [], products = [];
      for (const it of reqItems) {
        const qty = int(it.qty); if (qty < 1) fail(400, 'Cantidad inválida.');
        const p = await s.get('products', String(it.productId)); if (!p) fail(400, 'Un producto ya no existe. Recargá la página.');
        if (listOf(p.list) !== list) fail(400, p.name + ' no es de la lista de ' + (list === 'institucion' ? 'instituciones' : 'comercios') + '. Recargá la página.');
        if (qty > p.stock) fail(409, 'Stock insuficiente de ' + p.name + ' (quedan ' + p.stock + ').');
        p.stock -= qty; products.push(p);
        items.push({ productId: p.id, name: p.name, code: p.code, qty, price: p.price, iva: p.iva, cost: p.cost });
      }
      const sale = Object.assign({
        id: uid('s'), number: settings.nextNumber, date: new Date().toISOString(),
        clientId: client ? client.id : '', clientName: client ? client.name : 'Consumidor final',
        // Datos para la entrega: los que se escribieron al cobrar o, si no, los de la ficha del cliente.
        clientDoc: client ? client.doc || '' : '',
        deliveryAddress: str(b.deliveryAddress, 200) || (client ? client.address || '' : ''),
        deliveryPhone: str(b.deliveryPhone, 40) || (client ? client.phone || '' : ''),
        list, items, discountPct, payment, status, notes: str(b.notes, 500),
        userId: req.user.id, userName: req.user.name
      }, calcSale(items, discountPct));
      if (PAID.includes(status)) sale.paidAt = sale.date;
      settings.nextNumber++;
      for (const p of products) await s.put('products', p);
      await s.put('settings', settings);
      await s.put('sales', sale);
      return sale;
    });
    res.json(sale);
  }));
  r.patch('/sales/:id', needUser, wrap(async (req, res) => {
    const to = req.body.status;
    if (!STATUSES.includes(to)) fail(400, 'Estado inválido.');
    if (to === 'anulada' && req.user.role !== 'admin') fail(403, 'Solo un administrador puede anular ventas.');
    const sc = await scopeOf(req.user);
    const sale = await store.tx(async s => {
      const sale = await s.get('sales', req.params.id);
      if (!sale || !canSeeSale(sc, sale)) fail(404, 'Venta no encontrada.');
      if (sale.status === 'anulada') fail(400, 'La venta ya está anulada.');
      if (to === 'anulada') {
        for (const it of sale.items) {
          const p = await s.get('products', it.productId);
          if (p) { p.stock += it.qty; await s.put('products', p); }
        }
        sale.cancelledBy = req.user.name; sale.cancelledAt = new Date().toISOString();
      }
      sale.status = to;
      if (PAID.includes(to) && !sale.paidAt) sale.paidAt = new Date().toISOString(); // fecha de cobro: cuenta para la comisión
      if (!PAID.includes(to)) delete sale.paidAt;
      return s.put('sales', sale);
    });
    res.json(sale);
  }));

  // ---------- configuración (admin) ----------
  r.put('/settings', needAdmin, wrap(async (req, res) => {
    const s = await getSettings(), b = req.body;
    s.company = str(b.company, 120) || 'Comprasuy'; s.rut = str(b.rut, 30); s.address = str(b.address, 200); s.phone = str(b.phone, 40);
    s.nextNumber = Math.max(1, int(b.nextNumber)); s.lowStockDefault = Math.max(0, int(b.lowStockDefault));
    if (b.gpsRadius !== undefined) s.gpsRadius = Math.min(Math.max(int(b.gpsRadius), 20), 2000);
    res.json(await store.put('settings', s));
  }));

  // ---------- usuarios (admin) ----------
  async function checkAdminsLeft(changedId, willBeAdmin) {
    const users = await store.all('users');
    const admins = users.filter(u => u.role === 'admin' && u.active !== false && u.id !== changedId);
    if (!admins.length && !willBeAdmin) fail(400, 'Tiene que quedar al menos un administrador activo.');
  }
  r.post('/users', needAdmin, wrap(async (req, res) => {
    const b = req.body, email = auth.normEmail(b.email);
    if (!auth.validEmail(email)) fail(400, 'Email inválido.');
    if (await auth.findByEmail(email)) fail(409, 'Ya existe un usuario con ese email.');
    const err = auth.passwordError(b.password); if (err) fail(400, err);
    const u = {
      id: uid('u'), name: str(b.name, 100) || email, email, role: auth.ROLES.includes(b.role) ? b.role : 'vendedor',
      active: b.active !== false, passwordHash: await auth.hashPassword(b.password), createdAt: new Date().toISOString()
    };
    Object.assign(u, await userExtras(b));
    await store.put('users', u);
    res.json(auth.publicUser(u));
  }));
  r.put('/users/:id', needAdmin, wrap(async (req, res) => {
    const u = await store.get('users', req.params.id); if (!u) fail(404, 'Usuario no encontrado.');
    const b = req.body, email = auth.normEmail(b.email);
    if (!auth.validEmail(email)) fail(400, 'Email inválido.');
    const other = await auth.findByEmail(email);
    if (other && other.id !== u.id) fail(409, 'Ya existe un usuario con ese email.');
    const role = auth.ROLES.includes(b.role) ? b.role : u.role, active = b.active !== false;
    await checkAdminsLeft(u.id, role === 'admin' && active);
    Object.assign(u, { name: str(b.name, 100) || email, email, role, active }, await userExtras(b, u));
    if (b.password) { const err = auth.passwordError(b.password); if (err) fail(400, err); u.passwordHash = await auth.hashPassword(b.password); }
    await store.put('users', u);
    res.json(auth.publicUser(u));
  }));
  r.delete('/users/:id', needAdmin, wrap(async (req, res) => {
    if (req.params.id === req.user.id) fail(400, 'No podés borrar tu propio usuario.');
    await checkAdminsLeft(req.params.id, false);
    await store.del('users', req.params.id);
    for (const z of await store.all('zones')) if (z.supervisorId === req.params.id) { z.supervisorId = ''; await store.put('zones', z); }
    for (const c of await store.all('clients')) if (c.sellerId === req.params.id) { c.sellerId = ''; await store.put('clients', c); } // quedan sin asignar
    res.json({ ok: true });
  }));

  // ---------- respaldo / importación (admin) ----------
  r.get('/backup', needAdmin, wrap(async (req, res) => {
    const [products, clients, sales, settings] = await Promise.all([store.all('products'), store.all('clients'), store.all('sales'), getSettings()]);
    // terreno: se incluye para tener copia (restaurar respaldo no los toca)
    const [zones, routes, visits, profiles, commissions] = await Promise.all(['zones', 'routes', 'visits', 'profiles', 'commissions'].map(k => store.all(k)));
    res.json({ app: 'SVC', version: 2, exportedAt: new Date().toISOString(), settings, products, clients, sales, zones, routes, visits, profiles, commissions });
  }));
  r.post('/import', needAdmin, wrap(async (req, res) => {
    const b = req.body, replace = b.mode === 'replace';
    if (!Array.isArray(b.products) || !Array.isArray(b.sales)) fail(400, 'El archivo no es un respaldo válido de SVC.');
    const out = await store.tx(async s => {
      if (replace) { await s.clear('products'); await s.clear('clients'); await s.clear('sales'); }
      const settings = await getSettings(s);
      if (replace && b.settings) Object.assign(settings, { company: str(b.settings.company, 120) || settings.company, rut: str(b.settings.rut, 30), address: str(b.settings.address, 200), phone: str(b.settings.phone, 40) });
      for (const p of b.products) {
        const c = cleanProduct(p); c.id = str(p.id, 90) || uid('p');
        if (p.image && await s.get('images', str(p.image, 90))) c.image = str(p.image, 90); // la imagen sigue en la base
        await s.put('products', c);
      }
      for (const c0 of b.clients || []) { const c = cleanClient(c0); c.id = str(c0.id, 90) || uid('c'); c.sellerId = str(c0.sellerId, 90); await s.put('clients', c); }
      const sales = b.sales.slice().sort((x, y) => String(x.date).localeCompare(String(y.date)));
      let maxNumber = replace ? 0 : settings.nextNumber - 1;
      for (const x of sales) {
        const items = (Array.isArray(x.items) ? x.items : []).map(it => ({
          productId: str(it.productId, 90), name: str(it.name, 150), code: str(it.code, 60), qty: Math.max(1, int(it.qty)),
          price: round2(num(it.price)), iva: IVAS.includes(int(it.iva)) ? int(it.iva) : 22, cost: round2(num(it.cost))
        }));
        if (!items.length) continue;
        const discountPct = Math.min(Math.max(num(x.discountPct), 0), 100);
        const number = replace && int(x.number) > 0 ? int(x.number) : ++maxNumber;
        maxNumber = Math.max(maxNumber, number);
        const d = new Date(x.date);
        await s.put('sales', Object.assign({
          id: str(x.id, 90) || uid('s'), number, date: isNaN(d) ? new Date().toISOString() : d.toISOString(),
          list: listOf(x.list), clientId: str(x.clientId, 90), clientName: str(x.clientName, 150) || 'Consumidor final', items, discountPct,
          clientDoc: str(x.clientDoc, 30), deliveryAddress: str(x.deliveryAddress, 200), deliveryPhone: str(x.deliveryPhone, 40),
          payment: PAYMENTS.includes(x.payment) ? x.payment : 'Efectivo', status: STATUSES.includes(x.status) ? x.status : 'pagada',
          notes: str(x.notes, 500), userId: str(x.userId, 90) || req.user.id, userName: str(x.userName, 100) || req.user.name
        }, calcSale(items, discountPct)));
      }
      settings.nextNumber = Math.max(replace ? 1 : settings.nextNumber, maxNumber + 1);
      await s.put('settings', settings);
      return { products: b.products.length, clients: (b.clients || []).length, sales: sales.length };
    });
    res.json(out);
  }));

  require('./terreno')(r, { wrap, needUser, needAdmin, fail, str, int, uid, getSettings, PAID });

  r.use((req, _res, next) => next(new HttpError(404, 'No existe ' + req.path)));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error del servidor. Probá de nuevo.' : err.message });
  });
  return r;
};
