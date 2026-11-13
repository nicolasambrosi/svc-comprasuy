// Servidor de SVC (sitio + API + base de datos).
// Local:  npm install && npm start  → http://localhost:5173  (sin variables DB_* usa data/svc-dev.json)
// Hostinger: Web App de Node con archivo de entrada serve.js y estas variables de entorno:
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD
const path = require('path');
const express = require('express');

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile(); } catch { /* sin .env */ }

const store = require('./server/store');
const auth = require('./server/auth');
const api = require('./server/api');

async function main() {
  const app = express();
  const port = Number(process.env.PORT) || 5173;
  app.set('trust proxy', 1); // Hostinger atiende detrás de un proxy HTTPS
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });

  await store.init();
  await auth.ensureInitialAdmin();
  await require('./server/seed').seedCatalog().catch(err => console.error('No se pudo cargar el catálogo inicial:', err));
  setInterval(() => auth.cleanSessions().catch(() => {}), 6 * 3600e3).unref();

  app.use('/api', api());
  app.use(express.static(path.join(__dirname, 'app'), {
    // no-cache = el navegador revalida (ETag) y siempre usa la última versión publicada
    setHeaders: (res, file) => res.set('Cache-Control', /\.(svg|png|jpg|woff2?)$/.test(file) ? 'public, max-age=86400' : 'no-cache')
  }));
  app.use((req, res) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p style="font-family:sans-serif">Página no encontrada. <a href="/">Volver a SVC</a></p>'));

  app.listen(port, () => console.log(`SVC en http://localhost:${port} (datos: ${store.kind})`));
}

main().catch(err => { console.error('No se pudo iniciar SVC:', err); process.exit(1); });
