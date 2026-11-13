/* SVC · Sistema de Ventas Comprasuy
   App de una sola página. Los datos viven en el servidor (MySQL) y se leen/escriben por /api. */
(function () {
  'use strict';

  // ---------- utilidades ----------
  var OLD_KEY = 'svc-data-v1'; // datos de la versión anterior (solo navegador)
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = SVCCalc.num, round2 = SVCCalc.round2, calcSale = SVCCalc.calcSale;
  var money = function (n) {
    return '$U ' + (n || 0).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var dayKey = function (d) { d = new Date(d); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var fmtDate = function (d) { d = new Date(d); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); };
  var fmtDateTime = function (d) { d = new Date(d); return fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  var STATUSES = ['pagada', 'pendiente', 'entregada', 'anulada'];
  var PAYMENTS = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'Cuenta corriente'];
  var IVA_RATES = [{ v: 22, t: '22% (básica)' }, { v: 10, t: '10% (mínima)' }, { v: 0, t: 'Exento' }];
  var ROLE_NAMES = { admin: 'Administrador', vendedor: 'Vendedor' };

  // ---------- servidor ----------
  function api(method, url, body) {
    return fetch('/api' + url, {
      method: method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/login') { showLogin(); throw new Error('Tu sesión terminó. Volvé a entrar.'); }
        if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
        return data;
      });
    }, function () { throw new Error('Sin conexión con el servidor. Revisá internet y probá de nuevo.'); });
  }
  var db = { products: [], clients: [], sales: [], users: [], settings: {}, me: null };
  function refresh() {
    return api('GET', '/data').then(function (d) { db = d; return d; });
  }
  var isAdmin = function () { return db.me && db.me.role === 'admin'; };
  // Ejecuta una escritura, recarga los datos y vuelve a dibujar.
  function act(promise, okMsg, after) {
    return promise.then(function (res) {
      return refresh().then(function () { if (okMsg) toast(okMsg); (after || render)(res); return res; });
    }).catch(function (e) { toast(e.message, true); throw e; });
  }
  var byId = function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; };

  // ---------- imágenes de productos ----------
  function thumb(p, cls) {
    return p.image ? '<img class="' + (cls || 'thumb') + '" src="/api/images/' + encodeURIComponent(p.image) + '" alt="" loading="lazy">'
      : '<span class="' + (cls || 'thumb') + ' noimg" aria-hidden="true">' + esc((p.name || '?').charAt(0).toUpperCase()) + '</span>';
  }
  // Achica la foto en el navegador (máx. 640 px, JPG) antes de subirla.
  function shrinkImage(file) {
    return new Promise(function (ok, bad) {
      if (!/^image\//.test(file.type)) { bad(new Error('Elegí un archivo de imagen (JPG, PNG o WEBP).')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 640, k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); bad(new Error('No se pudo leer esa imagen.')); };
      img.src = url;
    });
  }

  // ---------- UI helpers ----------
  var toastTimer;
  function toast(msg, err) {
    var old = $('.toast'); if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 3200);
  }
  function openModal(title, html, onMount, wide) {
    var root = $('#modal-root');
    root.innerHTML = '<div class="modal-bg"><div class="modal"' + (wide ? ' style="max-width:760px"' : '') + '><h2>' + esc(title) + '</h2>' + html + '</div></div>';
    var bg = $('.modal-bg', root);
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) closeModal(); });
    $$('[data-close]', root).forEach(function (b) { b.addEventListener('click', closeModal); });
    if (onMount) onMount($('.modal', root));
    var first = $('input,select,textarea', root); if (first) first.focus();
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function field(f, val) {
    var v = val == null ? (f.def == null ? '' : f.def) : val;
    var cls = 'f' + (f.full ? ' full' : '');
    var req = f.req ? ' required' : '';
    if (f.type === 'select') {
      return '<label class="' + cls + '">' + esc(f.label) + '<select name="' + f.name + '">' +
        f.options.map(function (o) { return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(v) ? ' selected' : '') + '>' + esc(o.t) + '</option>'; }).join('') +
        '</select></label>';
    }
    if (f.type === 'textarea') return '<label class="' + cls + '">' + esc(f.label) + '<textarea name="' + f.name + '" rows="2">' + esc(v) + '</textarea></label>';
    return '<label class="' + cls + '">' + esc(f.label) + '<input name="' + f.name + '" type="' + (f.type || 'text') + '"' +
      (f.type === 'number' ? ' step="' + (f.step || 'any') + '" min="' + (f.min == null ? 0 : f.min) + '"' : '') +
      (f.auto ? ' autocomplete="' + f.auto + '"' : '') +
      ' value="' + esc(v) + '"' + req + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '></label>';
  }
  // onSave devuelve una promesa; el modal se cierra solo si sale bien.
  function formModal(title, fields, obj, onSave) {
    var html = '<form class="form">' + fields.map(function (f) { return field(f, obj[f.name]); }).join('') +
      '<div class="foot full"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Guardar</button></div></form>';
    openModal(title, html, function (m) {
      var form = $('form', m);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var out = {};
        fields.forEach(function (f) {
          var raw = form.elements[f.name].value;
          out[f.name] = f.type === 'number' || f.numeric ? num(raw) : f.type === 'password' ? raw : raw.trim();
        });
        var btn = $('button.primary', form); btn.disabled = true;
        Promise.resolve(onSave(out)).then(function () { closeModal(); }, function () { btn.disabled = false; });
      });
    });
  }

  function csv(filename, rows) {
    var text = '﻿' + rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? '' : c);
        return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(';');
    }).join('\r\n');
    download(filename, text, 'text/csv;charset=utf-8');
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function barChart(data) {
    var W = 700, H = 220, padL = 8, padB = 26, top = 14;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var bw = (W - padL * 2) / Math.max(data.length, 1);
    var bars = data.map(function (d, i) {
      var h = (H - padB - top) * d.value / max;
      var x = padL + i * bw + bw * 0.15, y = H - padB - h;
      var showLabel = data.length <= 14 || i % Math.ceil(data.length / 10) === 0;
      return '<g><title>' + esc(d.label) + ': ' + esc(money(d.value)) + '</title>' +
        '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + Math.max(h, d.value ? 2 : 0).toFixed(1) + '" rx="4" fill="#ff7a1a"></rect>' +
        (showLabel ? '<text x="' + (x + bw * 0.35).toFixed(1) + '" y="' + (H - 8) + '" font-size="11" text-anchor="middle" fill="#666">' + esc(d.label) + '</text>' : '') + '</g>';
    }).join('');
    return '<svg class="bars" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Gráfico de ventas">' +
      '<line x1="0" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" stroke="#dcdcdc"/>' + bars + '</svg>';
  }
  function lastDays(n) {
    var out = [], d = new Date(); d.setHours(0, 0, 0, 0);
    for (var i = n - 1; i >= 0; i--) { var x = new Date(d); x.setDate(d.getDate() - i); out.push(x); }
    return out;
  }
  var activeSales = function () { return db.sales.filter(function (s) { return s.status !== 'anulada'; }); };
  function oldLocalData() {
    try { var d = JSON.parse(localStorage.getItem(OLD_KEY)); return d && Array.isArray(d.products) && (d.products.length || d.sales.length) ? d : null; }
    catch (e) { return null; }
  }

  // ---------- vistas ----------
  var views = {};

  views.panel = function (el) {
    var today = dayKey(new Date());
    var now = new Date(), mKey = now.getFullYear() + '-' + pad(now.getMonth() + 1);
    var act0 = activeSales();
    var tSales = act0.filter(function (s) { return dayKey(s.date) === today; });
    var mSales = act0.filter(function (s) { return dayKey(s.date).slice(0, 7) === mKey; });
    var sum = function (arr) { return arr.reduce(function (a, s) { return a + s.total; }, 0); };
    var debt = sum(db.sales.filter(function (s) { return s.status === 'pendiente'; }));
    var low = db.products.filter(function (p) { return p.stock <= p.minStock; });
    var days = lastDays(14).map(function (d) {
      var k = dayKey(d);
      return { label: pad(d.getDate()) + '/' + pad(d.getMonth() + 1), value: sum(act0.filter(function (s) { return dayKey(s.date) === k; })) };
    });
    var recent = db.sales.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 6);
    var old = isAdmin() && db.products.length === 0 && db.sales.length === 0 ? oldLocalData() : null;

    el.innerHTML =
      '<div class="head"><h1>Panel</h1><div class="actions">' +
      (isAdmin() && db.products.length === 0 ? '<button class="btn" id="demo">Cargar datos de ejemplo</button>' : '') +
      '<a class="btn primary" href="#/venta">+ Nueva venta</a></div></div>' +
      (old ? '<div class="card" style="margin-bottom:16px;border-color:var(--orange)"><b>Este navegador tiene datos de la versión anterior</b> (' + old.products.length + ' productos, ' + (old.clients || []).length + ' clientes, ' + old.sales.length + ' ventas). <button class="btn sm primary" id="migrate">Pasarlos a la base de datos</button></div>' : '') +
      (isAdmin() ? '' : '<p class="muted small">Mostrando tus ventas.</p>') +
      '<div class="grid kpis">' +
      '<div class="card kpi accent"><span>Ventas de hoy</span><b>' + money(sum(tSales)) + '</b><span>' + tSales.length + ' ventas</span></div>' +
      '<div class="card kpi"><span>Ventas del mes</span><b>' + money(sum(mSales)) + '</b><span class="muted small">' + mSales.length + ' ventas</span></div>' +
      '<div class="card kpi"><span>Ticket promedio (mes)</span><b>' + money(mSales.length ? sum(mSales) / mSales.length : 0) + '</b></div>' +
      '<div class="card kpi"><span>Por cobrar</span><b>' + money(debt) + '</b><span class="muted small">' + low.length + ' productos con stock bajo</span></div>' +
      '</div><div class="grid two" style="margin-top:16px">' +
      '<div class="card"><h2>Ventas de los últimos 14 días</h2>' + barChart(days) + '</div>' +
      '<div class="card"><h2>Stock bajo</h2>' + (low.length ? low.slice(0, 8).map(function (p) {
        return '<div class="list-row"><span>' + esc(p.name) + '</span><span class="pill low">' + p.stock + ' u.</span></div>';
      }).join('') : '<p class="muted">Todo en orden. 👌</p>') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><h2>Últimas ventas</h2>' + salesTable(recent, true) + '</div>';

    var demo = $('#demo', el);
    if (demo) demo.addEventListener('click', function () { demo.disabled = true; act(api('POST', '/import', demoData()), 'Datos de ejemplo cargados').catch(function () { demo.disabled = false; }); });
    var mig = $('#migrate', el);
    if (mig) mig.addEventListener('click', function () {
      mig.disabled = true;
      act(api('POST', '/import', Object.assign({ mode: 'replace' }, old)), 'Datos pasados a la base de datos', function () {
        try { localStorage.setItem(OLD_KEY + '-migrado', localStorage.getItem(OLD_KEY)); localStorage.removeItem(OLD_KEY); } catch (e) { /* nada */ }
        render();
      }).catch(function () { mig.disabled = false; });
    });
    bindSalesTable(el);
  };

  // ----- Nueva venta (punto de venta) -----
  var cart = { items: [], clientId: '', payment: 'Efectivo', status: 'pagada', discount: 0, notes: '' };

  views.venta = function (el) {
    el.innerHTML =
      '<div class="head"><h1>Nueva venta</h1></div>' +
      '<div class="pos"><div>' +
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar producto por nombre, código o categoría…"><select id="cat"><option value="">Todas las categorías</option>' +
      categories().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="prod-grid" id="prods"></div></div>' +
      '<div class="card cart" id="cart"></div></div>' +
      '<button class="btn primary cartbar" id="cartbar" hidden></button>';
    $('#cartbar', el).addEventListener('click', function () { $('#cart', el).scrollIntoView({ behavior: 'smooth' }); });

    // Quita del carrito lo que ya no existe y actualiza precios.
    cart.items = cart.items.filter(function (it) {
      var p = byId(db.products, it.productId); if (!p) return false;
      it.price = p.price; it.iva = p.iva; it.cost = p.cost; it.name = p.name; return true;
    });

    function drawProducts() {
      var q = $('#q', el).value.toLowerCase(), cat = $('#cat', el).value;
      var list = db.products.filter(function (p) {
        return (!cat || p.category === cat) && (!q || (p.name + ' ' + p.code + ' ' + p.category + ' ' + (p.description || '')).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('#prods', el).innerHTML = list.length ? list.map(function (p) {
        var it = inCart(p.id);
        return '<div class="prod' + (p.stock <= 0 ? ' out' : '') + (it ? ' incart' : '') + '" data-id="' + p.id + '">' +
          '<button type="button" class="prod-pick" data-add title="Agregar ' + esc(p.name) + '">' + thumb(p, 'pimg') +
          (it ? '<span class="badge">' + it.qty + '</span>' : '') +
          '<b>' + esc(p.name) + '</b>' + (p.description ? '<span class="muted small">' + esc(p.description) + '</span>' : '') +
          '<span class="p">' + money(p.price) + '</span><span class="small ' + (p.stock <= p.minStock ? 'pill low' : 'muted') + '">Stock: ' + p.stock + '</span></button>' +
          '<div class="qrow"><button type="button" class="qb" data-step="-1" aria-label="Menos">−</button>' +
          '<input type="number" min="1" step="1" value="1" inputmode="numeric" aria-label="Cantidad a agregar">' +
          '<button type="button" class="qb" data-step="1" aria-label="Más">+</button>' +
          '<button type="button" class="btn sm primary" data-add>Agregar</button></div></div>';
      }).join('') : '<div class="card empty" style="grid-column:1/-1">No hay productos.' + (isAdmin() ? ' <a href="#/productos">Cargá tus productos</a>.' : ' Pedile a un administrador que los cargue.') + '</div>';
    }
    function inCart(id) { for (var i = 0; i < cart.items.length; i++) if (cart.items[i].productId === id) return cart.items[i]; return null; }
    function drawCart() {
      var t = calcSale(cart.items, cart.discount);
      var clientOpts = '<option value="">Consumidor final</option>' + db.clients.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === cart.clientId ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('');
      $('#cart', el).innerHTML = '<h2>Carrito</h2>' +
        (cart.items.length ? cart.items.map(function (it, i) {
          return '<div class="cart-line"><div><b>' + esc(it.name) + '</b><div class="muted small">' + money(it.price) + ' c/u</div></div>' +
            '<div class="qrow"><button type="button" class="qb" data-cstep="-1" data-i="' + i + '" aria-label="Menos">−</button>' +
            '<input type="number" min="1" step="1" inputmode="numeric" value="' + it.qty + '" data-qty="' + i + '" aria-label="Cantidad">' +
            '<button type="button" class="qb" data-cstep="1" data-i="' + i + '" aria-label="Más">+</button></div>' +
            '<b>' + money(it.qty * it.price) + '</b><button class="x" data-rm="' + i + '" title="Quitar">×</button></div>';
        }).join('') : '<p class="muted">Tocá un producto para agregarlo.</p>') +
        '<div class="form" style="margin-top:14px">' +
        '<label class="f full">Cliente<select id="cClient">' + clientOpts + '</select></label>' +
        '<label class="f">Medio de pago<select id="cPay">' + PAYMENTS.map(function (p) { return '<option' + (p === cart.payment ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Estado<select id="cStatus">' + STATUSES.filter(function (s) { return s !== 'anulada'; }).map(function (s) { return '<option value="' + s + '"' + (s === cart.status ? ' selected' : '') + '>' + s[0].toUpperCase() + s.slice(1) + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Descuento %<input id="cDisc" type="number" min="0" max="100" step="any" value="' + cart.discount + '"></label>' +
        '<label class="f">Nota<input id="cNotes" value="' + esc(cart.notes) + '" placeholder="Opcional"></label></div>' +
        '<div style="margin-top:14px">' +
        '<div class="tot muted"><span>Subtotal sin IVA</span><span>' + money(t.subtotal) + '</span></div>' +
        '<div class="tot muted"><span>IVA</span><span>' + money(t.iva) + '</span></div>' +
        (t.discount ? '<div class="tot muted"><span>Descuento</span><span>− ' + money(t.discount) + '</span></div>' : '') +
        '<div class="tot big"><span>Total</span><span>' + money(t.total) + '</span></div></div>' +
        '<div style="display:grid;gap:8px;margin-top:14px"><button class="btn primary big" id="checkout"' + (cart.items.length ? '' : ' disabled') + '>Cobrar ' + money(t.total) + '</button>' +
        (cart.items.length ? '<button class="btn sm" id="clear">Vaciar carrito</button>' : '') + '</div>';
      var n = cart.items.reduce(function (a, it) { return a + it.qty; }, 0);
      var bar = $('#cartbar', el);
      bar.hidden = !n;
      bar.textContent = 'Ver carrito (' + n + ') · ' + money(t.total) + ' ↓';
    }

    $('#q', el).addEventListener('input', drawProducts);
    $('#cat', el).addEventListener('change', drawProducts);
    function addToCart(p, q) {
      var it = inCart(p.id), want = (it ? it.qty : 0) + q;
      if (want > p.stock) { toast('Sin stock suficiente de ' + p.name + ' (quedan ' + p.stock + (it ? ', ya tenés ' + it.qty + ' en el carrito' : '') + ')', true); return false; }
      if (it) it.qty = want;
      else cart.items.push({ productId: p.id, name: p.name, code: p.code, qty: q, price: p.price, iva: p.iva, cost: p.cost });
      toast(q + ' × ' + p.name + ' agregado' + (q > 1 ? 's' : ''));
      return true;
    }
    function refreshTile(card) {
      var it = inCart(card.dataset.id), pick = $('.prod-pick', card), badge = $('.badge', card);
      card.classList.toggle('incart', !!it);
      if (it && !badge) { badge = document.createElement('span'); badge.className = 'badge'; pick.insertBefore(badge, pick.children[1]); }
      if (badge) { if (it) badge.textContent = it.qty; else badge.remove(); }
    }
    $('#prods', el).addEventListener('click', function (e) {
      var card = e.target.closest('.prod'); if (!card) return;
      var input = $('.qrow input', card);
      var step = e.target.closest('[data-step]');
      if (step) { input.value = Math.max(1, Math.floor(num(input.value) || 1) + Number(step.dataset.step)); return; }
      if (!e.target.closest('[data-add]')) return;
      var p = byId(db.products, card.dataset.id), q = Math.max(1, Math.floor(num(input.value) || 1));
      if (addToCart(p, q)) { input.value = 1; refreshTile(card); drawCart(); }
    });
    $('#prods', el).addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches('.qrow input')) { e.preventDefault(); $('.qrow [data-add]', e.target.closest('.prod')).click(); }
    });
    $('#cart', el).addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.qty != null) {
        var it = cart.items[+t.dataset.qty], p = byId(db.products, it.productId);
        var q = Math.max(1, Math.floor(num(t.value)));
        if (p && q > p.stock) { toast('Solo quedan ' + p.stock + ' de ' + p.name, true); q = Math.max(1, p.stock); }
        it.qty = q;
        drawProducts();
      }
      if (t.id === 'cClient') cart.clientId = t.value;
      if (t.id === 'cPay') { cart.payment = t.value; if (t.value === 'Cuenta corriente') cart.status = 'pendiente'; }
      if (t.id === 'cStatus') cart.status = t.value;
      if (t.id === 'cDisc') cart.discount = Math.min(Math.max(num(t.value), 0), 100);
      if (t.id === 'cNotes') { cart.notes = t.value; return; }
      drawCart();
    });
    $('#cart', el).addEventListener('click', function (e) {
      var cs = e.target.closest('[data-cstep]');
      if (cs) {
        var it = cart.items[+cs.dataset.i], p = byId(db.products, it.productId), q = it.qty + Number(cs.dataset.cstep);
        if (q < 1) return;
        if (p && q > p.stock) { toast('Solo quedan ' + p.stock + ' de ' + p.name, true); return; }
        it.qty = q; drawCart(); drawProducts(); return;
      }
      if (e.target.dataset.rm != null) { cart.items.splice(+e.target.dataset.rm, 1); drawCart(); drawProducts(); }
      if (e.target.id === 'clear') { cart.items = []; drawCart(); drawProducts(); }
      if (e.target.id === 'checkout') checkout(e.target);
    });

    function checkout(btn) {
      cart.notes = $('#cNotes', el).value;
      if (cart.status === 'pendiente' && !cart.clientId) { toast('Elegí un cliente para dejar la venta pendiente de cobro', true); return; }
      btn.disabled = true;
      var body = {
        items: cart.items.map(function (it) { return { productId: it.productId, qty: it.qty }; }),
        clientId: cart.clientId, payment: cart.payment, status: cart.status, discountPct: cart.discount, notes: cart.notes
      };
      api('POST', '/sales', body).then(function (sale) {
        cart = { items: [], clientId: '', payment: 'Efectivo', status: 'pagada', discount: 0, notes: '' };
        return refresh().then(function () {
          drawProducts(); drawCart();
          toast('Venta N.º ' + sale.number + ' registrada');
          showReceipt(sale);
        });
      }).catch(function (e) {
        toast(e.message, true);
        refresh().then(function () { drawProducts(); drawCart(); });
      });
    }
    drawProducts(); drawCart();
    $('#q', el).focus();
  };

  function categories() {
    var s = {}; db.products.forEach(function (p) { if (p.category) s[p.category] = 1; });
    return Object.keys(s).sort();
  }

  // ----- Ventas -----
  function salesTable(list, compact) {
    if (!list.length) return '<div class="empty">Todavía no hay ventas.</div>';
    var opts = STATUSES.filter(function (x) { return x !== 'anulada' || isAdmin(); });
    return '<div class="tbl-wrap"><table><thead><tr><th>N.º</th><th>Fecha</th><th>Cliente</th>' + (compact ? '' : '<th>Pago</th>') +
      (compact || !isAdmin() ? '' : '<th>Vendedor</th>') +
      '<th>Estado</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
      list.map(function (s) {
        return '<tr><td>' + s.number + '</td><td>' + fmtDateTime(s.date) + '</td><td>' + esc(s.clientName) + '</td>' +
          (compact ? '' : '<td>' + esc(s.payment) + '</td>') +
          (compact || !isAdmin() ? '' : '<td>' + esc(s.userName || '—') + '</td>') +
          '<td>' + (compact || s.status === 'anulada' ? '<span class="pill ' + s.status + '">' + s.status + '</span>' :
            '<select data-status="' + s.id + '">' + opts.map(function (x) { return '<option' + (x === s.status ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>') + '</td>' +
          '<td class="num"><b>' + money(s.total) + '</b></td><td class="act"><button class="btn sm" data-view="' + s.id + '">Ver</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bindSalesTable(el, after) {
    $$('[data-view]', el).forEach(function (b) { b.addEventListener('click', function () { showReceipt(byId(db.sales, b.dataset.view)); }); });
    $$('[data-status]', el).forEach(function (sel) {
      sel.addEventListener('change', function () {
        var s = byId(db.sales, sel.dataset.status);
        if (sel.value === 'anulada' && !confirm('¿Anular la venta N.º ' + s.number + '? El stock vuelve al inventario y no se puede deshacer.')) { sel.value = s.status; return; }
        sel.disabled = true;
        act(api('PATCH', '/sales/' + s.id, { status: sel.value }), 'Venta N.º ' + s.number + ': ' + sel.value, after)
          .catch(function () { sel.value = s.status; sel.disabled = false; });
      });
    });
  }
  function showReceipt(s) {
    var st = db.settings;
    var html = '<div class="receipt"><div class="r-head"><div><h3>' + esc(st.company) + '</h3><div class="small muted">' +
      (st.rut ? 'RUT ' + esc(st.rut) + '<br>' : '') + esc(st.address) + (st.phone ? '<br>Tel. ' + esc(st.phone) : '') + '</div></div>' +
      '<div style="text-align:right"><b>Comprobante N.º ' + s.number + '</b><div class="small">' + fmtDateTime(s.date) + '</div>' +
      '<span class="pill ' + s.status + '">' + s.status + '</span></div></div>' +
      '<p><b>Cliente:</b> ' + esc(s.clientName) + '<br><b>Pago:</b> ' + esc(s.payment) + (s.userName ? '<br><b>Vendedor:</b> ' + esc(s.userName) : '') + (s.notes ? '<br><b>Nota:</b> ' + esc(s.notes) : '') + '</p>' +
      '<table><thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">IVA</th><th class="num">Importe</th></tr></thead><tbody>' +
      s.items.map(function (it) {
        return '<tr><td>' + esc(it.name) + '</td><td class="num">' + it.qty + '</td><td class="num">' + money(it.price) + '</td><td class="num">' + it.iva + '%</td><td class="num">' + money(it.qty * it.price) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div style="max-width:300px;margin-left:auto;margin-top:10px">' +
      (s.discount ? '<div class="tot"><span>Descuento (' + s.discountPct + '%)</span><span>− ' + money(s.discount) + '</span></div>' : '') +
      '<div class="tot"><span>Subtotal sin IVA</span><span>' + money(s.subtotal) + '</span></div>' +
      '<div class="tot"><span>IVA</span><span>' + money(s.iva) + '</span></div>' +
      '<div class="tot big"><span>Total</span><span>' + money(s.total) + '</span></div></div>' +
      '<p class="small muted" style="margin-top:14px">Comprobante interno, no válido como factura electrónica (CFE).</p></div>' +
      '<div class="foot"><button class="btn" data-close>Cerrar</button><button class="btn primary" id="print">Imprimir</button></div>';
    openModal('Venta N.º ' + s.number, html, function (m) { $('#print', m).addEventListener('click', function () { window.print(); }); }, true);
  }

  views.ventas = function (el) {
    el.innerHTML = '<div class="head"><h1>Ventas</h1><div class="actions"><button class="btn" id="exp">Exportar CSV</button><a class="btn primary" href="#/venta">+ Nueva venta</a></div></div>' +
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar por cliente, vendedor o N.º…">' +
      '<select id="st"><option value="">Todos los estados</option>' + STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select>' +
      '<input type="date" id="from" title="Desde"><input type="date" id="to" title="Hasta"></div><div id="list"></div><p class="muted small" id="sum"></p>';
    function filtered() {
      var q = $('#q', el).value.toLowerCase(), st = $('#st', el).value, from = $('#from', el).value, to = $('#to', el).value;
      return db.sales.filter(function (s) {
        var k = dayKey(s.date);
        return (!st || s.status === st) && (!from || k >= from) && (!to || k <= to) &&
          (!q || (s.clientName + ' ' + s.number + ' ' + (s.userName || '')).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    }
    function draw() {
      var list = filtered();
      $('#list', el).innerHTML = salesTable(list);
      var tot = list.filter(function (s) { return s.status !== 'anulada'; }).reduce(function (a, s) { return a + s.total; }, 0);
      $('#sum', el).textContent = list.length + ' ventas · Total (sin anuladas): ' + money(tot);
      bindSalesTable(el, draw);
    }
    ['q', 'st', 'from', 'to'].forEach(function (id) { $('#' + id, el).addEventListener('input', draw); });
    $('#exp', el).addEventListener('click', function () {
      var rows = [['Numero', 'Fecha', 'Cliente', 'Vendedor', 'Pago', 'Estado', 'Subtotal', 'IVA', 'Descuento', 'Total', 'Productos']];
      filtered().forEach(function (s) {
        rows.push([s.number, fmtDateTime(s.date), s.clientName, s.userName, s.payment, s.status, s.subtotal, s.iva, s.discount, s.total,
          s.items.map(function (i) { return i.qty + 'x ' + i.name; }).join(', ')]);
      });
      csv('ventas.csv', rows);
    });
    draw();
  };

  // ----- Productos -----
  var productFields = function () {
    return [
      { name: 'name', label: 'Nombre', req: true, full: true },
      { name: 'description', label: 'Presentación / descripción', ph: 'Ej.: caja x 20 botellas', full: true },
      { name: 'code', label: 'Código / SKU' },
      { name: 'category', label: 'Categoría', ph: 'Ej.: Bebidas' },
      { name: 'cost', label: 'Costo ($U)', type: 'number' },
      { name: 'price', label: 'Precio de venta con IVA ($U)', type: 'number', req: true },
      { name: 'iva', label: 'IVA', type: 'select', numeric: true, options: IVA_RATES, def: 22 },
      { name: 'stock', label: 'Stock actual', type: 'number', step: 1, min: -999999 },
      { name: 'minStock', label: 'Avisar cuando el stock baje de', type: 'number', step: 1, def: db.settings.lowStockDefault }
    ];
  };
  // Alta / edición de producto, con foto.
  function productModal(p, after) {
    var fields = productFields(), cur = p || {};
    var newImg = null, removeImg = false;
    var html = '<form class="form">' +
      '<div class="f full img-pick"><div class="img-prev" id="imgPrev">' + thumb(cur, 'big') + '</div><div>' +
      '<b>Imagen del producto</b><p class="muted small">Ayuda a reconocerlo rápido en Nueva venta. Podés sacar una foto con el celular.</p>' +
      '<label class="btn sm">Elegir imagen<input type="file" id="imgFile" accept="image/*" hidden></label> ' +
      '<button type="button" class="btn sm danger" id="imgDel"' + (cur.image ? '' : ' hidden') + '>Quitar imagen</button></div></div>' +
      fields.map(function (f) { return field(f, cur[f.name]); }).join('') +
      '<div class="foot full"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Guardar</button></div></form>';
    openModal(p ? 'Editar producto' : 'Nuevo producto', html, function (m) {
      var form = $('form', m), prev = $('#imgPrev', m), del = $('#imgDel', m);
      $('#imgFile', m).addEventListener('change', function (e) {
        var file = e.target.files[0]; if (!file) return;
        shrinkImage(file).then(function (dataUrl) {
          newImg = dataUrl; removeImg = false;
          prev.innerHTML = '<img class="big" src="' + dataUrl + '" alt="">'; del.hidden = false;
        }, function (err) { toast(err.message, true); });
      });
      del.addEventListener('click', function () {
        newImg = null; removeImg = true; prev.innerHTML = thumb({ name: form.elements.name.value }, 'big'); del.hidden = true;
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var out = {};
        fields.forEach(function (f) { var raw = form.elements[f.name].value; out[f.name] = f.type === 'number' || f.numeric ? num(raw) : raw.trim(); });
        var btn = $('button.primary', form); btn.disabled = true;
        var save = p ? api('PUT', '/products/' + p.id, out) : api('POST', '/products', out);
        var chain = save.then(function (saved) {
          if (newImg) return api('PUT', '/products/' + saved.id + '/image', { dataUrl: newImg });
          if (removeImg && cur.image) return api('DELETE', '/products/' + saved.id + '/image');
          return saved;
        });
        act(chain, p ? 'Producto actualizado' : 'Producto creado', after).then(closeModal, function () { btn.disabled = false; });
      });
    });
  }
  views.productos = function (el) {
    var adm = isAdmin();
    el.innerHTML = '<div class="head"><h1>Productos</h1><div class="actions"><button class="btn" id="exp">Exportar CSV</button>' +
      (adm ? '<button class="btn primary" id="add">+ Nuevo producto</button>' : '') + '</div></div>' +
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar producto…"><select id="cat"><option value="">Todas las categorías</option>' +
      categories().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<select id="lw"><option value="">Todo el stock</option><option value="low">Solo stock bajo</option></select></div><div id="list"></div>';
    function draw() {
      var q = $('#q', el).value.toLowerCase(), cat = $('#cat', el).value, lw = $('#lw', el).value;
      var list = db.products.filter(function (p) {
        return (!cat || p.category === cat) && (!lw || p.stock <= p.minStock) &&
          (!q || (p.name + ' ' + p.code + ' ' + p.category).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('#list', el).innerHTML = list.length ? '<div class="tbl-wrap"><table><thead><tr><th></th><th>Producto</th><th>Categoría</th>' + (adm ? '<th class="num">Costo</th>' : '') + '<th class="num">Precio</th>' + (adm ? '<th class="num">Margen</th>' : '') + '<th class="num">IVA</th><th class="num">Stock</th>' + (adm ? '<th></th>' : '') + '</tr></thead><tbody>' +
        list.map(function (p) {
          var net = p.price / (1 + p.iva / 100), margin = net ? (net - p.cost) / net * 100 : 0;
          return '<tr><td class="tdimg">' + thumb(p) + '</td><td><b>' + esc(p.name) + '</b>' +
            ((p.description || p.code) ? '<div class="small muted">' + esc([p.code, p.description].filter(Boolean).join(' · ')) + '</div>' : '') + '</td><td>' + esc(p.category) + '</td>' + (adm ? '<td class="num">' + money(p.cost) + '</td>' : '') + '<td class="num">' + money(p.price) + '</td>' +
            (adm ? '<td class="num">' + (p.cost ? margin.toFixed(0) + '%' : '—') + '</td>' : '') + '<td class="num">' + p.iva + '%</td>' +
            '<td class="num"><span class="' + (p.stock <= p.minStock ? 'pill low' : '') + '">' + p.stock + '</span></td>' +
            (adm ? '<td class="act"><button class="btn sm" data-stock="' + p.id + '">± Stock</button><button class="btn sm" data-edit="' + p.id + '">Editar</button><button class="btn sm danger" data-del="' + p.id + '">Borrar</button></td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">No hay productos' + (db.products.length ? ' con ese filtro' : ' todavía') + '.</div>';
    }
    ['q', 'cat', 'lw'].forEach(function (id) { $('#' + id, el).addEventListener('input', draw); });
    if (adm) $('#add', el).addEventListener('click', function () { productModal(null); });
    $('#list', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) productModal(byId(db.products, b.dataset.edit));
      if (b.dataset.stock) {
        var ps = byId(db.products, b.dataset.stock);
        formModal('Ajustar stock: ' + ps.name, [
          { name: 'delta', label: 'Cantidad a sumar (usá negativo para restar)', type: 'number', step: 1, min: -999999, req: true, full: true }
        ], {}, function (o) { return act(api('POST', '/products/' + ps.id + '/stock', { delta: o.delta }), null, function (np) { toast('Stock actualizado: ' + np.stock); draw(); }); });
      }
      if (b.dataset.del) {
        var pd = byId(db.products, b.dataset.del);
        if (confirm('¿Borrar "' + pd.name + '"? Las ventas anteriores se mantienen.')) act(api('DELETE', '/products/' + pd.id), 'Producto borrado', draw);
      }
    });
    $('#exp', el).addEventListener('click', function () {
      csv('productos.csv', [['Codigo', 'Nombre', 'Categoria'].concat(adm ? ['Costo'] : []).concat(['Precio', 'IVA', 'Stock', 'StockMinimo'])].concat(
        db.products.map(function (p) { return [p.code, p.name, p.category].concat(adm ? [p.cost] : []).concat([p.price, p.iva, p.stock, p.minStock]); })));
    });
    draw();
  };

  // ----- Clientes -----
  var clientFields = [
    { name: 'name', label: 'Nombre o razón social', req: true, full: true },
    { name: 'doc', label: 'RUT / Cédula' },
    { name: 'phone', label: 'Teléfono' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'address', label: 'Dirección' },
    { name: 'notes', label: 'Notas', type: 'textarea', full: true }
  ];
  function clientStats(id) {
    var s = db.sales.filter(function (x) { return x.clientId === id && x.status !== 'anulada'; });
    return {
      count: s.length,
      total: s.reduce(function (a, x) { return a + x.total; }, 0),
      debt: s.filter(function (x) { return x.status === 'pendiente'; }).reduce(function (a, x) { return a + x.total; }, 0),
      last: s.reduce(function (a, x) { return x.date > a ? x.date : a; }, '')
    };
  }
  views.clientes = function (el) {
    var adm = isAdmin();
    el.innerHTML = '<div class="head"><h1>Clientes</h1><div class="actions"><button class="btn" id="exp">Exportar CSV</button><button class="btn primary" id="add">+ Nuevo cliente</button></div></div>' +
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar por nombre, RUT, teléfono…"><select id="dbt"><option value="">Todos</option><option value="1">Con saldo pendiente</option></select></div><div id="list"></div>';
    function draw() {
      var q = $('#q', el).value.toLowerCase(), dbt = $('#dbt', el).value;
      var list = db.clients.map(function (c) { return { c: c, s: clientStats(c.id) }; }).filter(function (x) {
        return (!dbt || x.s.debt > 0) && (!q || (x.c.name + ' ' + x.c.doc + ' ' + x.c.phone + ' ' + x.c.email).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return a.c.name.localeCompare(b.c.name); });
      $('#list', el).innerHTML = list.length ? '<div class="tbl-wrap"><table><thead><tr><th>Cliente</th><th>RUT / CI</th><th>Teléfono</th><th class="num">Compras</th><th class="num">Total comprado</th><th class="num">Saldo pendiente</th><th></th></tr></thead><tbody>' +
        list.map(function (x) {
          return '<tr><td><b>' + esc(x.c.name) + '</b><div class="small muted">' + esc(x.c.address) + '</div></td><td>' + esc(x.c.doc) + '</td><td>' + esc(x.c.phone) + '</td>' +
            '<td class="num">' + x.s.count + '</td><td class="num">' + money(x.s.total) + '</td><td class="num">' + (x.s.debt ? '<span class="pill pendiente">' + money(x.s.debt) + '</span>' : '—') + '</td>' +
            '<td class="act"><button class="btn sm" data-hist="' + x.c.id + '">Historial</button><button class="btn sm" data-edit="' + x.c.id + '">Editar</button>' + (adm ? '<button class="btn sm danger" data-del="' + x.c.id + '">Borrar</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">No hay clientes' + (db.clients.length ? ' con ese filtro' : ' todavía') + '.</div>';
    }
    ['q', 'dbt'].forEach(function (id) { $('#' + id, el).addEventListener('input', draw); });
    $('#add', el).addEventListener('click', function () {
      formModal('Nuevo cliente', clientFields, {}, function (o) { return act(api('POST', '/clients', o), 'Cliente creado', draw); });
    });
    $('#list', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) {
        var c = byId(db.clients, b.dataset.edit);
        formModal('Editar cliente', clientFields, c, function (o) { return act(api('PUT', '/clients/' + c.id, o), 'Cliente actualizado', draw); });
      }
      if (b.dataset.del) {
        var cd = byId(db.clients, b.dataset.del);
        if (confirm('¿Borrar a "' + cd.name + '"? Sus ventas se mantienen con el nombre guardado.')) act(api('DELETE', '/clients/' + cd.id), 'Cliente borrado', draw);
      }
      if (b.dataset.hist) {
        var ch = byId(db.clients, b.dataset.hist), st = clientStats(ch.id);
        var list = db.sales.filter(function (s) { return s.clientId === ch.id; }).sort(function (a, b2) { return b2.date.localeCompare(a.date); });
        openModal(ch.name, '<p class="muted">' + st.count + ' compras · ' + money(st.total) + ' en total · Saldo pendiente: <b>' + money(st.debt) + '</b>' +
          (st.last ? ' · Última compra: ' + fmtDate(st.last) : '') + '</p>' + salesTable(list, true) +
          '<div class="foot"><button class="btn" data-close>Cerrar</button></div>', function (m) { bindSalesTable(m); }, true);
      }
    });
    $('#exp', el).addEventListener('click', function () {
      csv('clientes.csv', [['Nombre', 'RUT_CI', 'Telefono', 'Email', 'Direccion', 'Compras', 'TotalComprado', 'SaldoPendiente']].concat(
        db.clients.map(function (c) { var s = clientStats(c.id); return [c.name, c.doc, c.phone, c.email, c.address, s.count, round2(s.total), round2(s.debt)]; })));
    });
    draw();
  };

  // ----- Reportes -----
  views.reportes = function (el) {
    var d30 = new Date(); d30.setDate(d30.getDate() - 29);
    el.innerHTML = '<div class="head"><h1>Reportes</h1></div>' + (isAdmin() ? '' : '<p class="muted small">Reportes de tus ventas.</p>') +
      '<div class="toolbar"><label class="small muted">Desde <input type="date" id="from" value="' + dayKey(d30) + '"></label>' +
      '<label class="small muted">Hasta <input type="date" id="to" value="' + dayKey(new Date()) + '"></label></div><div id="rep"></div>';
    function draw() {
      var from = $('#from', el).value, to = $('#to', el).value;
      var list = activeSales().filter(function (s) { var k = dayKey(s.date); return (!from || k >= from) && (!to || k <= to); });
      var total = 0, iva = 0, cost = 0, prods = {}, clients = {}, pays = {}, sellers = {}, perDay = {};
      list.forEach(function (s) {
        total += s.total; iva += s.iva; cost += s.cost || 0;
        perDay[dayKey(s.date)] = (perDay[dayKey(s.date)] || 0) + s.total;
        pays[s.payment] = (pays[s.payment] || 0) + s.total;
        clients[s.clientName] = (clients[s.clientName] || 0) + s.total;
        sellers[s.userName || '—'] = (sellers[s.userName || '—'] || 0) + s.total;
        var f = s.gross ? s.total / s.gross : 1;
        s.items.forEach(function (it) {
          var p = prods[it.name] || (prods[it.name] = { qty: 0, amount: 0 });
          p.qty += it.qty; p.amount += it.qty * it.price * f;
        });
      });
      var days = [], start = new Date((from || dayKey(new Date())) + 'T00:00:00'), end = new Date((to || dayKey(new Date())) + 'T00:00:00');
      for (var d = new Date(start), guard = 0; d <= end && guard < 366; d.setDate(d.getDate() + 1), guard++) {
        days.push({ label: pad(d.getDate()) + '/' + pad(d.getMonth() + 1), value: perDay[dayKey(d)] || 0 });
      }
      var net = total - iva, margin = net - cost;
      function ranking(obj, key, fmt) {
        var arr = Object.keys(obj).map(function (k) { return { k: k, v: key ? obj[k][key] : obj[k], o: obj[k] }; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 8);
        var max = arr.length ? arr[0].v : 1;
        return arr.length ? arr.map(function (x) {
          return '<div class="list-row" style="display:block"><div style="display:flex;justify-content:space-between;gap:8px"><span>' + esc(x.k) + '</span><b>' + fmt(x) + '</b></div><div class="bar-h"><i style="width:' + (x.v / max * 100).toFixed(1) + '%"></i></div></div>';
        }).join('') : '<p class="muted">Sin datos en el período.</p>';
      }
      var m = function (x) { return money(x.v); };
      $('#rep', el).innerHTML =
        '<div class="grid kpis"><div class="card kpi accent"><span>Ventas</span><b>' + money(total) + '</b><span>' + list.length + ' ventas</span></div>' +
        '<div class="card kpi"><span>Neto sin IVA</span><b>' + money(net) + '</b></div>' +
        '<div class="card kpi"><span>IVA a declarar</span><b>' + money(iva) + '</b></div>' +
        (isAdmin() ? '<div class="card kpi"><span>Margen bruto</span><b>' + money(margin) + '</b><span class="muted small">' + (net ? (margin / net * 100).toFixed(1) : 0) + '% sobre neto</span></div>'
          : '<div class="card kpi"><span>Ticket promedio</span><b>' + money(list.length ? total / list.length : 0) + '</b></div>') + '</div>' +
        '<div class="card" style="margin-top:16px"><h2>Ventas por día</h2>' + barChart(days) + '</div>' +
        '<div class="grid half" style="margin-top:16px">' +
        '<div class="card"><h2>Productos más vendidos</h2>' + ranking(prods, 'amount', function (x) { return x.o.qty + ' u. · ' + money(x.v); }) + '</div>' +
        '<div class="card"><h2>Mejores clientes</h2>' + ranking(clients, null, m) + '</div>' +
        (isAdmin() ? '<div class="card"><h2>Por vendedor</h2>' + ranking(sellers, null, m) + '</div>' : '') +
        '<div class="card"><h2>Por medio de pago</h2>' + ranking(pays, null, m) + '</div>' +
        '<div class="card"><h2>Exportar</h2><p class="muted">Descargá el detalle de ventas del período para Excel.</p><button class="btn primary" id="expR">Exportar ventas del período (CSV)</button></div></div>';
      $('#expR', el).addEventListener('click', function () {
        var rows = [['Numero', 'Fecha', 'Cliente', 'Vendedor', 'Producto', 'Cantidad', 'PrecioUnit', 'IVA', 'Importe', 'Pago', 'Estado']];
        list.forEach(function (s) { s.items.forEach(function (it) { rows.push([s.number, fmtDateTime(s.date), s.clientName, s.userName, it.name, it.qty, it.price, it.iva + '%', round2(it.qty * it.price), s.payment, s.status]); }); });
        csv('reporte-ventas.csv', rows);
      });
    }
    ['from', 'to'].forEach(function (id) { $('#' + id, el).addEventListener('change', draw); });
    draw();
  };

  // ----- Configuración -----
  var userFields = function (isNew) {
    return [
      { name: 'name', label: 'Nombre', req: true, full: true },
      { name: 'email', label: 'Email (para entrar)', type: 'email', req: true, auto: 'off' },
      { name: 'role', label: 'Rol', type: 'select', options: [{ v: 'vendedor', t: 'Vendedor' }, { v: 'admin', t: 'Administrador' }], def: 'vendedor' },
      { name: 'password', label: isNew ? 'Contraseña (mín. 8 caracteres)' : 'Nueva contraseña (dejá vacío para no cambiarla)', type: 'password', req: isNew, auto: 'new-password' },
      { name: 'active', label: 'Estado', type: 'select', options: [{ v: '1', t: 'Activo' }, { v: '0', t: 'Inactivo (no puede entrar)' }], def: '1' }
    ];
  };
  function userBody(o) { return { name: o.name, email: o.email, role: o.role, password: o.password || undefined, active: o.active !== '0' }; }

  function passwordCard() {
    return '<div class="card"><h2>Mi contraseña</h2><p class="muted small">Entraste como <b>' + esc(db.me.email) + '</b> (' + ROLE_NAMES[db.me.role] + ').</p>' +
      '<button class="btn" id="myPw">Cambiar mi contraseña</button></div>';
  }
  function bindPasswordCard(el) {
    $('#myPw', el).addEventListener('click', function () {
      formModal('Cambiar mi contraseña', [
        { name: 'current', label: 'Contraseña actual', type: 'password', req: true, full: true, auto: 'current-password' },
        { name: 'password', label: 'Nueva contraseña (mín. 8 caracteres)', type: 'password', req: true, full: true, auto: 'new-password' }
      ], {}, function (o) { return api('POST', '/me/password', o).then(function () { toast('Contraseña cambiada'); }, function (e) { toast(e.message, true); throw e; }); });
    });
  }

  views.config = function (el) {
    if (!isAdmin()) {
      el.innerHTML = '<div class="head"><h1>Configuración</h1></div><div class="grid half">' + passwordCard() + '</div>';
      bindPasswordCard(el);
      return;
    }
    var st = db.settings;
    el.innerHTML = '<div class="head"><h1>Configuración</h1></div>' +
      '<div class="card" style="margin-bottom:16px"><div class="head" style="margin-bottom:10px"><h2 style="margin:0">Usuarios</h2><button class="btn primary" id="addUser">+ Nuevo usuario</button></div>' +
      '<p class="muted small">Los <b>administradores</b> ven y manejan todo. Los <b>vendedores</b> registran ventas y clientes y solo ven sus propias ventas.</p>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th class="num">Ventas</th><th></th></tr></thead><tbody>' +
      db.users.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (u) {
        var n = db.sales.filter(function (s) { return s.userId === u.id && s.status !== 'anulada'; }).length;
        return '<tr><td><b>' + esc(u.name) + '</b>' + (u.id === db.me.id ? ' <span class="pill">vos</span>' : '') + '</td><td>' + esc(u.email) + '</td><td>' + ROLE_NAMES[u.role] + '</td>' +
          '<td>' + (u.active ? '<span class="pill pagada">activo</span>' : '<span class="pill anulada">inactivo</span>') + '</td><td class="num">' + n + '</td>' +
          '<td class="act"><button class="btn sm" data-uedit="' + u.id + '">Editar</button>' + (u.id === db.me.id ? '' : '<button class="btn sm danger" data-udel="' + u.id + '">Borrar</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="grid half">' +
      '<div class="card"><h2>Datos de la empresa</h2><p class="muted small">Salen en los comprobantes.</p><form class="form" id="cfg">' +
      field({ name: 'company', label: 'Nombre', full: true, req: true }, st.company) +
      field({ name: 'rut', label: 'RUT' }, st.rut) + field({ name: 'phone', label: 'Teléfono' }, st.phone) +
      field({ name: 'address', label: 'Dirección', full: true }, st.address) +
      field({ name: 'nextNumber', label: 'Próximo N.º de venta', type: 'number', step: 1, min: 1 }, st.nextNumber) +
      field({ name: 'lowStockDefault', label: 'Stock mínimo por defecto', type: 'number', step: 1 }, st.lowStockDefault) +
      '<div class="full"><button class="btn primary">Guardar</button></div></form></div>' +
      '<div style="display:grid;gap:16px;align-content:start">' + passwordCard() +
      '<div class="card"><h2>Respaldo de datos</h2><p class="muted small">Los datos se guardan en la base de datos del servidor. Igual conviene descargar un respaldo cada tanto.</p>' +
      '<p class="small">' + db.products.length + ' productos · ' + db.clients.length + ' clientes · ' + db.sales.length + ' ventas</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn dark" id="bk">Descargar respaldo</button>' +
      '<label class="btn">Restaurar respaldo<input type="file" id="rs" accept=".json,application/json" hidden></label></div>' +
      '<hr style="border:0;border-top:1px solid #ececec;margin:20px 0"><h2>Zona de cuidado</h2>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="demo">Cargar datos de ejemplo</button><button class="btn danger" id="wipe">Borrar productos, clientes y ventas</button></div></div></div></div>';

    $('#addUser', el).addEventListener('click', function () {
      formModal('Nuevo usuario', userFields(true), {}, function (o) { return act(api('POST', '/users', userBody(o)), 'Usuario creado'); });
    });
    $$('[data-uedit]', el).forEach(function (b) {
      b.addEventListener('click', function () {
        var u = byId(db.users, b.dataset.uedit);
        formModal('Editar usuario', userFields(false), { name: u.name, email: u.email, role: u.role, active: u.active ? '1' : '0' },
          function (o) { return act(api('PUT', '/users/' + u.id, userBody(o)), 'Usuario actualizado'); });
      });
    });
    $$('[data-udel]', el).forEach(function (b) {
      b.addEventListener('click', function () {
        var u = byId(db.users, b.dataset.udel);
        if (confirm('¿Borrar el usuario ' + u.name + ' (' + u.email + ')? Sus ventas se mantienen. Si solo querés que no entre más, editalo y ponelo inactivo.')) act(api('DELETE', '/users/' + u.id), 'Usuario borrado');
      });
    });
    $('#cfg', el).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = this.elements;
      act(api('PUT', '/settings', { company: f.company.value, rut: f.rut.value, phone: f.phone.value, address: f.address.value, nextNumber: f.nextNumber.value, lowStockDefault: f.lowStockDefault.value }), 'Configuración guardada');
    });
    bindPasswordCard(el);
    $('#bk', el).addEventListener('click', function () {
      api('GET', '/backup').then(function (data) {
        download('svc-respaldo-' + dayKey(new Date()) + '.json', JSON.stringify(data, null, 2), 'application/json');
      }).catch(function (e) { toast(e.message, true); });
    });
    $('#rs', el).addEventListener('change', function () {
      var file = this.files[0]; if (!file) return;
      var r = new FileReader();
      r.onload = function () {
        var data;
        try { data = JSON.parse(r.result); if (!data || !Array.isArray(data.products) || !Array.isArray(data.sales)) throw 0; }
        catch (e) { toast('El archivo no es un respaldo válido de SVC', true); return; }
        if (!confirm('Esto reemplaza todos los productos, clientes y ventas por los del respaldo (' + data.products.length + ' productos, ' + data.sales.length + ' ventas). Los usuarios no cambian. ¿Seguir?')) return;
        act(api('POST', '/import', Object.assign({ mode: 'replace' }, data)), 'Respaldo restaurado');
      };
      r.readAsText(file);
    });
    $('#demo', el).addEventListener('click', function () {
      if ((db.products.length || db.sales.length) && !confirm('Se agregan productos, clientes y ventas de ejemplo a tus datos actuales. ¿Seguir?')) return;
      act(api('POST', '/import', demoData()), 'Datos de ejemplo cargados');
    });
    $('#wipe', el).addEventListener('click', function () {
      if (!confirm('¿Borrar TODOS los productos, clientes y ventas? Los usuarios se mantienen. No se puede deshacer: descargá un respaldo antes.')) return;
      if (prompt('Para confirmar escribí BORRAR') !== 'BORRAR') return;
      act(api('POST', '/import', { mode: 'replace', products: [], clients: [], sales: [] }), 'Datos borrados');
    });
  };

  // ---------- datos de ejemplo ----------
  function demoData() {
    var P = [
      ['BEB-001', 'Agua mineral 2 L', 'Bebidas', 38, 65, 22, 120], ['BEB-002', 'Refresco cola 1,5 L', 'Bebidas', 70, 119, 22, 80],
      ['BEB-003', 'Jugo de naranja 1 L', 'Bebidas', 55, 95, 22, 40], ['ALM-001', 'Arroz 1 kg', 'Almacén', 45, 72, 10, 90],
      ['ALM-002', 'Fideos 500 g', 'Almacén', 30, 52, 10, 110], ['ALM-003', 'Aceite girasol 900 ml', 'Almacén', 85, 139, 10, 4],
      ['ALM-004', 'Yerba mate 1 kg', 'Almacén', 160, 255, 10, 60], ['LIM-001', 'Detergente 750 ml', 'Limpieza', 60, 99, 22, 35],
      ['LIM-002', 'Lavandina 2 L', 'Limpieza', 40, 69, 22, 3], ['LAC-001', 'Leche entera 1 L', 'Lácteos', 32, 48, 10, 70],
      ['LAC-002', 'Queso dambo kg', 'Lácteos', 290, 459, 10, 18], ['PAN-001', 'Galletitas surtidas', 'Panadería', 48, 79, 22, 50]
    ];
    var tag = uid();
    var products = P.map(function (x, i) { return { id: 'p-demo-' + tag + i, code: x[0] + (db.products.some(function (p) { return p.code === x[0]; }) ? '-' + tag.slice(-3) : ''), name: x[1], category: x[2], cost: x[3], price: x[4], iva: x[5], stock: x[6], minStock: 5 }; });
    var C = [['Almacén El Puerto', '211234560019', '099 123 456', 'Rambla 1234, Montevideo'], ['Kiosco Central', '4.567.890-1', '098 765 432', '18 de Julio 900'],
      ['Super Del Barrio', '217654320015', '2900 1122', 'Av. Italia 3300'], ['Restorán La Esquina', '214445550012', '091 222 333', 'Sarandí 450'],
      ['María Fernández', '3.456.789-0', '094 555 666', 'Pocitos'], ['Distribuidora Norte', '219998880017', '4732 1100', 'Salto']];
    var clients = C.map(function (x, i) { return { id: 'c-demo-' + tag + i, name: x[0], doc: x[1], phone: x[2], email: '', address: x[3], notes: '' }; });
    var rnd = function (n) { return Math.floor(Math.random() * n); };
    var sales = [];
    for (var i = 0; i < 70; i++) {
      var date = new Date(); date.setDate(date.getDate() - rnd(30)); date.setHours(8 + rnd(11), rnd(60), 0, 0);
      var items = [], used = {};
      for (var j = 0, n = 1 + rnd(4); j < n; j++) {
        var p = products[rnd(products.length)]; if (used[p.id]) continue; used[p.id] = 1;
        items.push({ productId: p.id, name: p.name, code: p.code, qty: 1 + rnd(6), price: p.price, iva: p.iva, cost: p.cost });
      }
      var c = rnd(4) ? clients[rnd(clients.length)] : null;
      var pay = PAYMENTS[rnd(c ? 5 : 4)];
      var status = pay === 'Cuenta corriente' ? (rnd(2) ? 'pendiente' : 'pagada') : (rnd(10) ? 'pagada' : 'entregada');
      sales.push({ id: 's-demo-' + tag + i, date: date.toISOString(), clientId: c ? c.id : '', clientName: c ? c.name : 'Consumidor final',
        items: items, discountPct: rnd(6) ? 0 : 5, payment: pay, status: status, notes: '' });
    }
    return { mode: 'merge', products: products, clients: clients, sales: sales };
  }

  // ---------- login y arranque ----------
  function showLogin() {
    $('#shell').hidden = true; closeModal();
    $('#login').hidden = false;
    var f = $('#loginForm'); f.elements.password.value = '';
    setTimeout(function () { (f.elements.email.value ? f.elements.password : f.elements.email).focus(); }, 0);
  }
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = this, err = $('#loginErr'), btn = $('button', f);
    err.hidden = true; btn.disabled = true;
    api('POST', '/login', { email: f.elements.email.value, password: f.elements.password.value })
      .then(function () { return start(); })
      .catch(function (e2) { err.textContent = e2.message; err.hidden = false; })
      .then(function () { btn.disabled = false; });
  });

  function drawWho() {
    $('#who').innerHTML = '<b>' + esc(db.me.name) + '</b><span class="em">' + esc(db.me.email) + '</span><br><span class="role">' + ROLE_NAMES[db.me.role] + '</span><br><button id="logout">Salir</button>';
    $('#logout').addEventListener('click', function () {
      api('POST', '/logout', {}).catch(function () {}).then(function () { cart.items = []; showLogin(); });
    });
  }

  function render() {
    if (!db.me) return;
    var name = (location.hash.replace(/^#\/?/, '') || 'panel').split('?')[0];
    if (!views[name]) name = 'panel';
    $$('.side a.nav').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#/' + name); });
    var el = $('#view');
    var y = window.scrollY, same = el.dataset.view === name;
    closeModal();
    el.innerHTML = '';
    el.dataset.view = name;
    views[name](el);
    document.title = 'SVC · ' + ($('.side a.nav.on') ? $('.side a.nav.on').textContent.replace(/^\W+/, '') : 'Sistema de Ventas');
    window.scrollTo(0, same ? y : 0);
  }

  function start() {
    return refresh().then(function () {
      $('#login').hidden = true;
      $('#shell').hidden = false;
      drawWho();
      $('#view').dataset.view = '';
      render();
    });
  }
  window.addEventListener('hashchange', function () { if (db.me) { $('#view').dataset.view = ''; render(); } });
  // Si otro usuario cargó ventas, se ven al volver a la pestaña.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && db.me && !$('#modal-root').innerHTML && $('#view').dataset.view !== 'venta') refresh().then(render).catch(function () {});
  });

  $('#view').innerHTML = '<div class="loading">Cargando…</div>';
  start().catch(function (e) {
    if (!$('#login').hidden) return; // ya mostró el login (sesión vencida)
    $('#shell').hidden = false;
    $('#view').innerHTML = '<div class="card empty">' + esc(e.message) + ' <button class="btn sm" onclick="location.reload()">Reintentar</button></div>';
  });
})();
