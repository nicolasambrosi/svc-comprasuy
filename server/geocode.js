// Ubica en el mapa los clientes que tienen dirección y todavía no tienen coordenadas.
// Usa Nominatim (OpenStreetMap): gratis, máximo 1 consulta por segundo. Corre en segundo plano.
// La ubicación queda marcada como aproximada (geoSource 'direccion'): la primera visita con buen GPS la corrige.
const store = require('./store');

const URL = 'https://nominatim.openstreetmap.org/search';
const UA = 'SVC-Sistema-de-Ventas/1.0 (ubicacion de clientes)';
let state = { running: false, total: 0, done: 0, ok: 0, failed: 0, startedAt: null, finishedAt: null, error: '' };
const COARSE = ['country', 'state', 'region', 'province', 'county', 'municipality', 'city', 'town', 'village', 'hamlet', 'city_district', 'district', 'borough', 'suburb', 'quarter', 'neighbourhood', 'postcode', 'administrative'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function variants(address) {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  const out = [a];
  // sin apartamento / local / esquina, que confunden al buscador
  const simple = a.replace(/\b(apto|apt|ap|local|loc|piso|esq|esquina|casi|block|torre|of)\b\.?.*$/i, '').replace(/[,\s]+$/, '').trim();
  if (simple && simple !== a) out.push(simple);
  return out.filter(Boolean);
}
async function lookup(q) {
  const u = URL + '?format=jsonv2&limit=1&countrycodes=uy&q=' + encodeURIComponent(q + ', Uruguay');
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' } });
  if (r.status === 429 || r.status === 403) throw new Error('El servicio de mapas pidió esperar (' + r.status + '). Probá más tarde.');
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j[0]) return null;
  // Solo sirve si encontró la calle o el edificio: una ciudad o un barrio entero no permite validar visitas.
  if (COARSE.includes(j[0].addresstype) || COARSE.includes(j[0].type)) return null;
  return { lat: Number(j[0].lat), lng: Number(j[0].lon), label: j[0].display_name };
}

async function run(list) {
  for (const id of list) {
    const c = await store.get('clients', id);
    if (c && c.address && !(isFinite(c.lat) && c.lat !== null)) {
      let hit = null;
      for (const q of variants(c.address)) { hit = await lookup(q); await sleep(1100); if (hit) break; }
      const fresh = await store.get('clients', id); // pudo cambiar mientras tanto
      if (fresh && !(isFinite(fresh.lat) && fresh.lat !== null)) {
        if (hit) { Object.assign(fresh, { lat: Math.round(hit.lat * 1e6) / 1e6, lng: Math.round(hit.lng * 1e6) / 1e6, geoSource: 'direccion', geoLabel: hit.label.slice(0, 200), geoAt: new Date().toISOString() }); delete fresh.geoFailed; state.ok++; }
        else { fresh.geoFailed = true; state.failed++; }
        await store.put('clients', fresh);
      }
    }
    state.done++;
  }
}

async function start(opts) {
  if (state.running) return state;
  const clients = await store.all('clients');
  const list = clients.filter(c => c.address && !(isFinite(c.lat) && c.lat !== null) && (opts.retryFailed || !c.geoFailed)).map(c => c.id);
  state = { running: true, total: list.length, done: 0, ok: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, error: '' };
  run(list).catch(e => { state.error = e.message; }).then(() => { state.running = false; state.finishedAt = new Date().toISOString(); });
  return state;
}
function status() { return state; }

module.exports = { start, status };
