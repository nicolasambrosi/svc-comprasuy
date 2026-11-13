// Carga inicial del catálogo de Comprasuy (seed/catalogo-comprasuy.json) la primera vez que arranca.
// Solo se hace si la base todavía no tiene productos y nunca se cargó; después no vuelve a correr.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const images = require('./images');

const FILE = path.join(__dirname, '..', 'seed', 'catalogo-comprasuy.json');

async function seedCatalog() {
  if (!fs.existsSync(FILE)) return;
  const settings = (await store.get('settings', 'main')) || { id: 'main' };
  if (settings.catalogSeeded) return;
  if ((await store.all('products')).length) { // ya cargaron productos a mano: no tocar
    settings.catalogSeeded = 'omitido';
    await store.put('settings', settings);
    return;
  }
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8')).products || [];
  let n = 0;
  for (const p of list) {
    const doc = {
      id: p.id, name: p.name, code: p.code || '', category: p.category || '', description: p.description || '',
      cost: 0, price: Number(p.price) || 0, iva: p.iva == null ? 22 : p.iva, stock: Math.round(Number(p.stock) || 0), minStock: p.minStock || 0
    };
    if (await store.get('products', doc.id)) continue;
    const img = images.parseDataUrl(p.image);
    if (img) doc.image = await images.save(null, img);
    await store.put('products', doc);
    n++;
  }
  settings.catalogSeeded = new Date().toISOString();
  await store.put('settings', settings);
  console.log('Catálogo inicial cargado: ' + n + ' productos.');
}

module.exports = { seedCatalog };
