// Alcance de cada usuario: qué vendedores (y por lo tanto qué clientes y ventas) puede ver.
//  - admin: todo.
//  - supervisor: él mismo + los usuarios de las zonas que supervisa (y los comercios de esas zonas).
//  - vendedor: solo él mismo.
const store = require('./store');

async function scopeOf(user) {
  if (user.role === 'admin') return { all: true, ids: new Set(), zones: new Set() };
  const ids = new Set([user.id]), zoneSet = new Set();
  if (user.role === 'supervisor') {
    const zones = (await store.all('zones')).filter(z => z.supervisorId === user.id).map(z => z.id);
    zones.forEach(z => zoneSet.add(z));
    if (zones.length) for (const u of await store.all('users')) if (u.zoneId && zones.includes(u.zoneId)) ids.add(u.id);
  }
  return { all: false, ids, zones: zoneSet };
}
const inScope = (sc, userId) => sc.all || (!!userId && sc.ids.has(userId));
const canSeeClient = (sc, c) => inScope(sc, c.sellerId) || (!!c.zoneId && !!sc.zones && sc.zones.has(c.zoneId));
const canSeeSale = (sc, s) => inScope(sc, s.userId);

module.exports = { scopeOf, inScope, canSeeClient, canSeeSale };
