// Almacén de datos de SVC.
// - Con DB_HOST/DB_USER/DB_NAME: MySQL (Hostinger). Una tabla svc_docs guarda cada registro como JSON.
// - Sin esas variables: un archivo JSON local (solo para desarrollo).
const fs = require('fs');
const path = require('path');

function mysqlStore() {
  const mysql = require('mysql2/promise');
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const pool = mysql.createPool({
    host: DB_HOST, port: Number(DB_PORT) || 3306, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    charset: 'utf8mb4', connectionLimit: 5, waitForConnections: true
  });

  const api = (exec, lock) => ({
    async all(col) {
      const [rows] = await exec.query('SELECT data FROM svc_docs WHERE collection = ?' + (lock ? ' FOR UPDATE' : ''), [col]);
      return rows.map(r => JSON.parse(r.data));
    },
    async get(col, id) {
      const [rows] = await exec.query('SELECT data FROM svc_docs WHERE collection = ? AND id = ?' + (lock ? ' FOR UPDATE' : ''), [col, String(id)]);
      return rows.length ? JSON.parse(rows[0].data) : null;
    },
    async put(col, doc) {
      await exec.query(
        'INSERT INTO svc_docs (collection, id, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
        [col, String(doc.id), JSON.stringify(doc)]);
      return doc;
    },
    async del(col, id) { await exec.query('DELETE FROM svc_docs WHERE collection = ? AND id = ?', [col, String(id)]); },
    async clear(col) { await exec.query('DELETE FROM svc_docs WHERE collection = ?', [col]); }
  });

  const base = api(pool, false);
  return Object.assign(base, {
    kind: 'mysql',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS svc_docs (
        collection VARCHAR(32) NOT NULL,
        id VARCHAR(100) NOT NULL,
        data LONGTEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (collection, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    },
    // Ejecuta fn dentro de una transacción; las lecturas bloquean las filas hasta el final.
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(api(conn, true));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    }
  });
}

function fileStore() {
  const file = process.env.SVC_DATA_FILE || path.join(__dirname, '..', 'data', 'svc-dev.json');
  let data = {};
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const clone = v => JSON.parse(JSON.stringify(v));
  let queue = Promise.resolve();
  const s = {
    kind: 'archivo',
    async init() { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; } },
    async all(col) { return Object.values(data[col] || {}).map(clone); },
    async get(col, id) { const d = (data[col] || {})[id]; return d ? clone(d) : null; },
    async put(col, doc) { (data[col] = data[col] || {})[doc.id] = clone(doc); persist(); return doc; },
    async del(col, id) { if (data[col]) delete data[col][id]; persist(); },
    async clear(col) { data[col] = {}; persist(); },
    tx(fn) { // serializa las transacciones; sin rollback (solo desarrollo)
      const run = queue.then(() => fn(s));
      queue = run.catch(() => {});
      return run;
    }
  };
  return s;
}

const usingMysql = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
module.exports = usingMysql ? mysqlStore() : fileStore();
