// Alcance de cada usuario: qué vendedores (y por lo tanto qué clientes y ventas) puede ver.
//  - admin: todo.
//  - supervisor: él mismo + los vendedores que lo tienen como supervisor (supervisorId) y los comercios de las zonas que supervisa.
//  - vendedor: solo él mismo.
const store = require('./store');

async function scopeOf(user) {
  if (user.role === 'admin') return { all: true, ids: new Set(), zones: new Set() };
  const ids = new Set([user.id]), zoneSet = new Set();
  if (user.role === 'supervisor') {
    for (const z of await store.all('zones')) if (z.supervisorId === user.id) zoneSet.add(z.id);
    for (const u of await store.all('users')) if (u.supervisorId === user.id) ids.add(u.id);
  }
  return { all: false, ids, zones: zoneSet };
}
const inScope = (sc, userId) => sc.all || (!!userId && sc.ids.has(userId));
const canSeeClient = (sc, c) => inScope(sc, c.sellerId) || (!!c.zoneId && !!sc.zones && sc.zones.has(c.zoneId));
const canSeeSale = (sc, s) => inScope(sc, s.userId);

// Una sola vez por vendedor: antes el equipo salía de la zona del usuario; ahora cada vendedor tiene su supervisor.
// Los vendedores que nunca tuvieron supervisorId toman el supervisor de su zona (o quedan sin supervisor).
async function migrateSupervisors() {
  const zones = await store.all('zones');
  let n = 0;
  for (const u of await store.all('users')) {
    if (u.supervisorId !== undefined) continue;
    const z = u.role === 'vendedor' && u.zoneId ? zones.find(x => x.id === u.zoneId) : null;
    u.supervisorId = z && z.supervisorId ? z.supervisorId : '';
    await store.put('users', u); n++;
  }
  if (n) console.log('Supervisor directo: ' + n + ' usuarios actualizados');
}

module.exports = { scopeOf, inScope, canSeeClient, canSeeSale, migrateSupervisors };
