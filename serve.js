// Servidor del sitio SVC. Local: node serve.js → http://localhost:5173
// En Hostinger (Web App de Node) el puerto llega en la variable PORT.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'app'), port = process.env.PORT || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  const file0 = path.join(root, path.normalize(urlPath));
  if (file0 !== root && !file0.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }

  let file = file0;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    // /app → /app/ para que funcionen las rutas relativas
    if (!urlPath.endsWith('/')) { res.writeHead(301, { Location: urlPath + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p style="font-family:sans-serif">Página no encontrada. <a href="/">Volver a SVC</a></p>');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}).listen(port, () => console.log('SVC en http://localhost:' + port));
