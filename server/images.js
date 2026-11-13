// Imágenes de productos: se guardan en la base (colección "images") como base64.
// El navegador las achica antes de subirlas, así que pesan ~20–80 KB cada una.
const crypto = require('crypto');
const store = require('./store');

const TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const MAX_BYTES = 1.5 * 1024 * 1024;

// "data:image/jpeg;base64,...." → { type, data } o null si no es válida.
function parseDataUrl(s) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m || !TYPES[m[1]]) return null;
  const data = m[2].replace(/\s/g, '');
  if (Buffer.byteLength(data, 'base64') > MAX_BYTES) return null;
  return { type: m[1], data };
}

async function save(s, img) {
  const doc = { id: 'img-' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex'), type: img.type, data: img.data };
  await (s || store).put('images', doc);
  return doc.id;
}

async function remove(s, id) { if (id) await (s || store).del('images', id); }

module.exports = { parseDataUrl, save, remove };
