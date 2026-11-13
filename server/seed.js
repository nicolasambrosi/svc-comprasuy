// Carga inicial de los catálogos de Comprasuy la primera vez que arranca cada uno:
//  - seed/catalogo-comprasuy.json      → lista "comercio" (catalogo.treinta.co/comprasuycomercios)
//  - seed/catalogo-instituciones.json  → lista "institucion" (catalogo.treinta.co/comprasuyresidenciales, sin "Precio por Mayor")
// Cada uno se carga una sola vez (queda marcado en la configuración); después no vuelve a correr.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const images = require('./images');

const CATALOGS = [
  { file: 'catalogo-comprasuy.json', flag: 'catalogSeeded', list: 'comercio', skipIfProducts: true },
  { file: 'catalogo-instituciones.json', flag: 'catalogInstSeeded', list: 'institucion' }
];

async function loadOne(c) {
  const file = path.join(__dirname, '..', 'seed', c.file);
  if (!fs.existsSync(file)) return;
  const settings = (await store.get('settings', 'main')) || { id: 'main' };
  if (settings[c.flag]) return;
  if (c.skipIfProducts && (await store.all('products')).length) { // ya cargaron productos a mano: no tocar
    settings[c.flag] = 'omitido';
    await store.put('settings', settings);
    return;
  }
  const list = JSON.parse(fs.readFileSync(file, 'utf8')).products || [];
  let n = 0;
  for (const p of list) {
    const doc = {
      id: p.id, list: p.list || c.list, name: p.name, code: p.code || '', category: p.category || '', description: p.description || '',
      cost: 0, price: Number(p.price) || 0, iva: p.iva == null ? 22 : p.iva, stock: Math.round(Number(p.stock) || 0), minStock: p.minStock || 0
    };
    if (await store.get('products', doc.id)) continue;
    const img = images.parseDataUrl(p.image);
    if (img) doc.image = await images.save(null, img);
    await store.put('products', doc);
    n++;
  }
  const s2 = (await store.get('settings', 'main')) || { id: 'main' };
  s2[c.flag] = new Date().toISOString();
  await store.put('settings', s2);
  console.log('Catálogo ' + c.list + ' cargado: ' + n + ' productos.');
}

async function seedCatalog() {
  for (const c of CATALOGS) await loadOne(c);
}

module.exports = { seedCatalog };
