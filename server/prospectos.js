// Prospectos: busca comercios en OpenStreetMap (Overpass API) dentro de un área del mapa, marca los que ya son
// clientes y deja agregar los nuevos como clientes "prospecto" en una zona, para meterlos en un recorrido.
// Datos © colaboradores de OpenStreetMap, licencia ODbL (se pueden guardar citando la fuente).
// No usa Google Maps: sus condiciones no permiten copiar ni guardar sus comercios.
const store = require('./store');
const { scopeOf, canSeeClient } = require('./scope');

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'SVC-Sistema-de-Ventas/1.0 (prospectos por zona)';
const MAX_SPAN = 0.06;        // grados (~6 km): área máxima de una búsqueda
const MAX_IMPORT = 300;

// Rubros: clave → { etiqueta, filtros OSM }
const CATS = {
  almacen: { label: 'Almacén / autoservicio', tags: { shop: ['convenience', 'supermarket', 'general', 'grocery', 'variety_store', 'wholesale', 'frozen_food'] } },
  kiosco: { label: 'Kiosco', tags: { shop: ['kiosk', 'newsagent', 'tobacco'] } },
  panaderia: { label: 'Panadería / confitería', tags: { shop: ['bakery', 'pastry', 'confectionery'] } },
  carniceria: { label: 'Carnicería / fiambrería', tags: { shop: ['butcher', 'deli', 'cheese', 'seafood'] } },
  verduleria: { label: 'Verdulería', tags: { shop: ['greengrocer', 'farm'] } },
  bebidas: { label: 'Bebidas / licorería', tags: { shop: ['alcohol', 'beverages', 'wine'] } },
  farmacia: { label: 'Farmacia', tags: { amenity: ['pharmacy'], shop: ['chemist'] } },
  gastronomia: { label: 'Bar / restaurante / café', tags: { amenity: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream'] } },
  residencial: { label: 'Residencial / hogar de ancianos', tags: { amenity: ['nursing_home', 'social_facility'] } },
  educacion: { label: 'Colegio / jardín', tags: { amenity: ['school', 'kindergarten', 'college'] } },
  salud: { label: 'Hospital / clínica', tags: { amenity: ['hospital', 'clinic', 'doctors'] } }
};
function catOf(tags) {
  for (const k of Object.keys(CATS)) for (const [key, vals] of Object.entries(CATS[k].tags)) if (vals.includes(tags[key])) return k;
  return '';
}

// ---------- comparación de nombres ----------
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'sa', 'srl', 'ltda', 'almacen', 'autoservice', 'autoservicio', 'supermercado', 'super', 'minimercado', 'mini', 'market', 'mercado', 'kiosco', 'panaderia', 'carniceria', 'farmacia', 'bar', 'cafe', 'restaurante', 'rotiseria', 'verduleria', 'local', 'comercial', 'casa']);
function words(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ').filter(w => w.length > 1 && !STOP.has(w));
}
function sameName(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return false;
  if (A.join(' ') === B.join(' ')) return true;
  const common = A.filter(w => B.includes(w)).length;
  return common / Math.min(A.length, B.length) >= 0.6;
}
function distanceM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const hasGeo = c => c && isFinite(c.lat) && isFinite(c.lng) && c.lat !== null && c.lng !== null;

// ---------- Overpass ----------
const cache = new Map();   // osmId → lugar (para importar sin volver a consultar)
const searches = new Map(); // clave de búsqueda → { at, places }
let busy = false;

function query(b, cats) {
  const box = [b.s, b.w, b.n, b.e].join(',');
  const parts = [];
  for (const k of cats) for (const [key, vals] of Object.entries(CATS[k].tags)) parts.push('nwr["' + key + '"~"^(' + vals.join('|') + ')$"]["name"](' + box + ');');
  return '[out:json][timeout:40];(' + parts.join('') + ');out center tags 800;';
}
async function overpass(q) {
  let last = '';
  for (const url of ENDPOINTS) {
    try {
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 45000);
      const r = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      clearTimeout(t);
      if (r.ok) return (await r.json()).elements || [];
      last = 'el servicio respondió ' + r.status;
    } catch (e) { last = e.name === 'AbortError' ? 'tardó demasiado' : e.message; }
  }
  throw Object.assign(new Error('No se pudo consultar OpenStreetMap (' + last + '). Probá de nuevo en un rato o con un área más chica.'), { status: 502 });
}
function toPlace(el) {
  const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lng = el.lon != null ? el.lon : el.center && el.center.lon;
  if (lat == null || lng == null || !t.name) return null;
  const street = t['addr:street'] ? t['addr:street'] + (t['addr:housenumber'] ? ' ' + t['addr:housenumber'] : '') : '';
  const cat = catOf(t);
  return {
    osmId: el.type.charAt(0) + el.id, name: String(t.name).slice(0, 150), cat, catLabel: cat ? CATS[cat].label : '',
    address: street.slice(0, 200), phone: String(t.phone || t['contact:phone'] || '').slice(0, 40),
    lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, brand: t.brand || ''
  };
}

module.exports = function prospectos(r, h) {
  const { wrap, needUser, fail, str, uid } = h;
  const needBoss = (req, _res, next) => (req.user && ['admin', 'supervisor'].includes(req.user.role) ? next() : wrap(async () => fail(403, 'Solo un supervisor o administrador puede hacer esto.'))(req, _res, next));
  async function zoneFor(user, id) {
    const z = await store.get('zones', str(id, 90)); if (!z) fail(400, 'Elegí una zona.');
    if (user.role === 'supervisor' && z.supervisorId !== user.id) fail(403, 'La zona ' + z.name + ' no es tuya.');
    return z;
  }

  r.get('/prospects/categories', needUser, (req, res) => res.json(Object.keys(CATS).map(k => ({ id: k, label: CATS[k].label }))));

  // GET /prospects/search?s=&w=&n=&e=&cats=almacen,kiosco
  r.get('/prospects/search', needBoss, wrap(async (req, res) => {
    const b = {}; for (const k of ['s', 'w', 'n', 'e']) { b[k] = Number(req.query[k]); if (!isFinite(b[k])) fail(400, 'Área inválida.'); }
    if (b.n <= b.s || b.e <= b.w) fail(400, 'Área inválida.');
    if (b.n - b.s > MAX_SPAN || b.e - b.w > MAX_SPAN) fail(400, 'El área es muy grande: acercá el mapa a la zona (máx. unos 6 km de lado).');
    const cats = String(req.query.cats || '').split(',').filter(k => CATS[k]);
    if (!cats.length) fail(400, 'Elegí al menos un rubro.');
    for (const k of ['s', 'w', 'n', 'e']) b[k] = Math.round(b[k] * 1e4) / 1e4;
    const key = [b.s, b.w, b.n, b.e].join(',') + '|' + cats.sort().join(',');
    let hit = searches.get(key), places;
    if (hit && Date.now() - hit.at < 30 * 60e3) places = hit.places;
    else {
      if (busy) fail(429, 'Ya hay una búsqueda en curso. Esperá unos segundos.');
      busy = true;
      try { places = (await overpass(query(b, cats))).map(toPlace).filter(Boolean); }
      finally { busy = false; }
      const seen = new Set(); places = places.filter(p => !seen.has(p.osmId) && seen.add(p.osmId));
      searches.set(key, { at: Date.now(), places });
      if (searches.size > 200) searches.delete(searches.keys().next().value);
      for (const p of places) cache.set(p.osmId, p);
      while (cache.size > 20000) cache.delete(cache.keys().next().value);
    }
    // marcar los que ya están en el sistema
    const clients = await store.all('clients'), skips = new Set((await store.all('osmskip')).map(x => x.id));
    const sc = await scopeOf(req.user);
    const out = places.map(p => {
      const o = Object.assign({}, p);
      let c = clients.find(x => x.osmId === p.osmId);
      if (c) o.status = c.prospect ? 'prospecto' : 'cliente';
      else {
        c = clients.find(x => hasGeo(x) && sameName(x.name, p.name) && distanceM(x, p) < 300) ||
            clients.find(x => hasGeo(x) && distanceM(x, p) < 25 && words(x.name).length && words(p.name).some(w => words(x.name).includes(w)));
        if (c) o.status = 'cliente';
        else { c = clients.find(x => !hasGeo(x) && sameName(x.name, p.name)); if (c) o.status = 'posible'; }
      }
      if (c) { o.clientName = canSeeClient(sc, c) ? c.name : ''; o.clientId = canSeeClient(sc, c) ? c.id : ''; }
      if (!o.status) o.status = skips.has(p.osmId) ? 'oculto' : 'nuevo';
      return o;
    });
    res.json({ places: out, attribution: '© colaboradores de OpenStreetMap (ODbL)' });
  }));

  // POST /prospects/import { zoneId, ids:[osmId] } → crea clientes prospecto en la zona
  r.post('/prospects/import', needBoss, wrap(async (req, res) => {
    const z = await zoneFor(req.user, req.body.zoneId);
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(x => str(x, 40)))].filter(Boolean) : [];
    if (!ids.length) fail(400, 'Elegí al menos un comercio.');
    if (ids.length > MAX_IMPORT) fail(400, 'Máximo ' + MAX_IMPORT + ' por vez.');
    const missing = ids.filter(id => !cache.has(id));
    if (missing.length) fail(409, 'La búsqueda venció. Volvé a buscar y agregalos de nuevo.');
    const now = new Date().toISOString();
    const created = await store.tx(async s => {
      const have = new Set((await s.all('clients')).map(c => c.osmId).filter(Boolean));
      let n = 0;
      for (const id of ids) {
        if (have.has(id)) continue;
        const p = cache.get(id);
        await s.put('clients', {
          id: uid('c'), name: p.name, doc: '', phone: p.phone, email: '', address: p.address,
          notes: (p.catLabel ? 'Rubro: ' + p.catLabel + '. ' : '') + 'Encontrado en OpenStreetMap; confirmar datos en la visita.',
          sellerId: '', zoneId: z.id, createdBy: req.user.id,
          lat: p.lat, lng: p.lng, geoSource: 'osm', geoAt: now,
          prospect: true, prospectAt: now, prospectCat: p.cat, source: 'OpenStreetMap', osmId: p.osmId
        });
        have.add(id); n++;
      }
      return n;
    });
    res.json({ ok: true, created });
  }));

  // POST /prospects/hide { ids:[osmId] } → no volver a mostrarlos como nuevos (cerró, no sirve, etc.)
  r.post('/prospects/hide', needBoss, wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => str(x, 40)).filter(Boolean).slice(0, MAX_IMPORT) : [];
    const undo = !!req.body.undo;
    for (const id of ids) {
      if (undo) await store.del('osmskip', id);
      else await store.put('osmskip', { id, by: req.user.id, at: new Date().toISOString(), name: (cache.get(id) || {}).name || '' });
    }
    res.json({ ok: true });
  }));

  // POST /prospects/discard { ids:[clientId] } → borra prospectos que no sirven (sin ventas) y no los vuelve a sugerir
  r.post('/prospects/discard', needBoss, wrap(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => str(x, 90)) : [];
    const sc = await scopeOf(req.user);
    const sold = new Set((await store.all('sales')).map(s => s.clientId));
    let n = 0;
    for (const id of ids) {
      const c = await store.get('clients', id);
      if (!c || !c.prospect || sold.has(id) || !canSeeClient(sc, c)) continue;
      for (const rec of await store.all('recorridos')) if (rec.stops.includes(id)) { rec.stops = rec.stops.filter(x => x !== id); await store.put('recorridos', rec); }
      if (c.osmId) await store.put('osmskip', { id: c.osmId, by: req.user.id, at: new Date().toISOString(), name: c.name });
      await store.del('clients', id); n++;
    }
    res.json({ ok: true, discarded: n });
  }));
};
module.exports.CATS = CATS;
module.exports._test = { sameName, words };
