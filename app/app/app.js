/* SVC · Sistema de Ventas Comprasuy
   App de una sola página, sin dependencias. Los datos se guardan en localStorage. */
(function () {
  'use strict';

  // ---------- utilidades ----------
  var KEY = 'svc-data-v1';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = function (v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
  var round2 = function (n) { return Math.round(n * 100) / 100; };
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

  // ---------- datos ----------
  function emptyDB() {
    return {
      products: [], clients: [], sales: [],
      settings: { company: 'Comprasuy', rut: '', address: '', phone: '', email: '', nextNumber: 1, lowStockDefault: 5 }
    };
  }
  var db;
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      db = raw ? JSON.parse(raw) : emptyDB();
    } catch (e) { db = emptyDB(); }
    var base = emptyDB();
    ['products', 'clients', 'sales'].forEach(function (k) { if (!Array.isArray(db[k])) db[k] = []; });
    db.settings = Object.assign(base.settings, db.settings || {});
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('No se pudo guardar en el navegador. Descargá un respaldo.', true); }
  }
  var byId = function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; };

  // Calcula totales de una venta. Los precios incluyen IVA.
  function calcSale(items, discountPct) {
    var d = Math.min(Math.max(num(discountPct), 0), 100) / 100;
    var gross = 0, iva = 0, cost = 0;
    items.forEach(function (it) {
      var line = it.qty * it.price * (1 - d);
      gross += it.qty * it.price;
      iva += line * it.iva / (100 + it.iva);
      cost += it.qty * (it.cost || 0);
    });
    var total = round2(gross * (1 - d));
    iva = round2(iva);
    return { gross: round2(gross), discount: round2(gross - total), subtotal: round2(total - iva), iva: iva, total: total, cost: round2(cost) };
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
    toastTimer = setTimeout(function () { t.remove(); }, 2800);
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
      ' value="' + esc(v) + '"' + req + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + '></label>';
  }
  function formModal(title, fields, obj, onSave) {
    var html = '<form class="form">' + fields.map(function (f) { return field(f, obj[f.name]); }).join('') +
      '<div class="foot full"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Guardar</button></div></form>';
    openModal(title, html, function (m) {
      $('form', m).addEventListener('submit', function (e) {
        e.preventDefault();
        var out = {};
        fields.forEach(function (f) {
          var raw = this.elements[f.name].value;
          out[f.name] = f.type === 'number' || f.numeric ? num(raw) : raw.trim();
        }, this);
        if (onSave(out) !== false) closeModal();
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

  function barChart(data) { // data: [{label, value}]
    var W = 700, H = 220, padL = 8, padB = 26, top = 14;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var bw = (W - padL * 2) / data.length;
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

  // ---------- vistas ----------
  var views = {};

  views.panel = function (el) {
    var today = dayKey(new Date());
    var now = new Date(), mKey = now.getFullYear() + '-' + pad(now.getMonth() + 1);
    var act = activeSales();
    var tSales = act.filter(function (s) { return dayKey(s.date) === today; });
    var mSales = act.filter(function (s) { return dayKey(s.date).slice(0, 7) === mKey; });
    var sum = function (arr) { return arr.reduce(function (a, s) { return a + s.total; }, 0); };
    var debt = sum(db.sales.filter(function (s) { return s.status === 'pendiente'; }));
    var low = db.products.filter(function (p) { return p.stock <= p.minStock; });
    var days = lastDays(14).map(function (d) {
      var k = dayKey(d);
      return { label: pad(d.getDate()) + '/' + pad(d.getMonth() + 1), value: sum(act.filter(function (s) { return dayKey(s.date) === k; })) };
    });
    var recent = db.sales.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 6);

    el.innerHTML =
      '<div class="head"><h1>Panel</h1><div class="actions">' +
      (db.products.length === 0 ? '<button class="btn" id="demo">Cargar datos de ejemplo</button>' : '') +
      '<a class="btn primary" href="#/venta">+ Nueva venta</a></div></div>' +
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
    if (demo) demo.addEventListener('click', function () { seedDemo(); toast('Datos de ejemplo cargados'); render(); });
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

    function drawProducts() {
      var q = $('#q', el).value.toLowerCase(), cat = $('#cat', el).value;
      var list = db.products.filter(function (p) {
        return (!cat || p.category === cat) && (!q || (p.name + ' ' + p.code + ' ' + p.category).toLowerCase().indexOf(q) >= 0);
      });
      $('#prods', el).innerHTML = list.length ? list.map(function (p) {
        return '<button class="prod' + (p.stock <= 0 ? ' out' : '') + '" data-id="' + p.id + '"><span class="muted small">' + esc(p.code || p.category) + '</span><b>' + esc(p.name) + '</b><span class="p">' + money(p.price) + '</span><span class="small ' + (p.stock <= p.minStock ? 'pill low' : 'muted') + '">Stock: ' + p.stock + '</span></button>';
      }).join('') : '<div class="card empty" style="grid-column:1/-1">No hay productos. <a href="#/productos">Cargá tus productos</a>.</div>';
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
            '<input type="number" min="1" step="1" value="' + it.qty + '" data-qty="' + i + '" aria-label="Cantidad">' +
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
    $('#prods', el).addEventListener('click', function (e) {
      var b = e.target.closest('.prod'); if (!b) return;
      var p = byId(db.products, b.dataset.id);
      var it = inCart(p.id), want = (it ? it.qty : 0) + 1;
      if (want > p.stock) { toast('Sin stock suficiente de ' + p.name + ' (quedan ' + p.stock + ')', true); return; }
      if (it) it.qty = want;
      else cart.items.push({ productId: p.id, name: p.name, code: p.code, qty: 1, price: p.price, iva: p.iva, cost: p.cost });
      drawCart();
    });
    $('#cart', el).addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.qty != null) {
        var it = cart.items[+t.dataset.qty], p = byId(db.products, it.productId);
        var q = Math.max(1, Math.floor(num(t.value)));
        if (p && q > p.stock) { toast('Solo quedan ' + p.stock + ' de ' + p.name, true); q = Math.max(1, p.stock); }
        it.qty = q;
      }
      if (t.id === 'cClient') cart.clientId = t.value;
      if (t.id === 'cPay') { cart.payment = t.value; if (t.value === 'Cuenta corriente') cart.status = 'pendiente'; }
      if (t.id === 'cStatus') cart.status = t.value;
      if (t.id === 'cDisc') cart.discount = Math.min(Math.max(num(t.value), 0), 100);
      if (t.id === 'cNotes') { cart.notes = t.value; return; }
      drawCart();
    });
    $('#cart', el).addEventListener('click', function (e) {
      if (e.target.dataset.rm != null) { cart.items.splice(+e.target.dataset.rm, 1); drawCart(); }
      if (e.target.id === 'clear') { cart.items = []; drawCart(); }
      if (e.target.id === 'checkout') checkout();
    });

    function checkout() {
      cart.notes = $('#cNotes', el).value;
      for (var i = 0; i < cart.items.length; i++) {
        var p = byId(db.products, cart.items[i].productId);
        if (p && cart.items[i].qty > p.stock) { toast('Stock insuficiente de ' + p.name, true); return; }
      }
      if (cart.status === 'pendiente' && !cart.clientId) { toast('Elegí un cliente para dejar la venta pendiente de cobro', true); return; }
      var client = byId(db.clients, cart.clientId);
      var t = calcSale(cart.items, cart.discount);
      var sale = {
        id: uid(), number: db.settings.nextNumber++, date: new Date().toISOString(),
        clientId: cart.clientId, clientName: client ? client.name : 'Consumidor final',
        items: cart.items.map(function (x) { return Object.assign({}, x); }),
        discountPct: cart.discount, payment: cart.payment, status: cart.status, notes: cart.notes
      };
      Object.assign(sale, t);
      sale.items.forEach(function (it) { var p = byId(db.products, it.productId); if (p) p.stock -= it.qty; });
      db.sales.push(sale);
      save();
      cart = { items: [], clientId: '', payment: 'Efectivo', status: 'pagada', discount: 0, notes: '' };
      drawProducts(); drawCart();
      toast('Venta N.º ' + sale.number + ' registrada');
      showReceipt(sale);
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
    return '<div class="tbl-wrap"><table><thead><tr><th>N.º</th><th>Fecha</th><th>Cliente</th>' + (compact ? '' : '<th>Pago</th>') +
      '<th>Estado</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
      list.map(function (s) {
        return '<tr><td>' + s.number + '</td><td>' + fmtDateTime(s.date) + '</td><td>' + esc(s.clientName) + '</td>' +
          (compact ? '' : '<td>' + esc(s.payment) + '</td>') +
          '<td>' + (compact || s.status === 'anulada' ? '<span class="pill ' + s.status + '">' + s.status + '</span>' :
            '<select data-status="' + s.id + '">' + STATUSES.map(function (x) { return '<option' + (x === s.status ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>') + '</td>' +
          '<td class="num"><b>' + money(s.total) + '</b></td><td class="act"><button class="btn sm" data-view="' + s.id + '">Ver</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bindSalesTable(el, after) {
    $$('[data-view]', el).forEach(function (b) { b.addEventListener('click', function () { showReceipt(byId(db.sales, b.dataset.view)); }); });
    $$('[data-status]', el).forEach(function (sel) {
      sel.addEventListener('change', function () {
        var s = byId(db.sales, sel.dataset.status);
        if (sel.value === 'anulada') {
          if (!confirm('¿Anular la venta N.º ' + s.number + '? El stock vuelve al inventario y no se puede deshacer.')) { sel.value = s.status; return; }
          s.items.forEach(function (it) { var p = byId(db.products, it.productId); if (p) p.stock += it.qty; });
        }
        s.status = sel.value; save(); toast('Venta N.º ' + s.number + ': ' + s.status);
        if (after) after(); else render();
      });
    });
  }
  function showReceipt(s) {
    var st = db.settings;
    var html = '<div class="receipt"><div class="r-head"><div><h3>' + esc(st.company) + '</h3><div class="small muted">' +
      (st.rut ? 'RUT ' + esc(st.rut) + '<br>' : '') + esc(st.address) + (st.phone ? '<br>Tel. ' + esc(st.phone) : '') + '</div></div>' +
      '<div style="text-align:right"><b>Comprobante N.º ' + s.number + '</b><div class="small">' + fmtDateTime(s.date) + '</div>' +
      '<span class="pill ' + s.status + '">' + s.status + '</span></div></div>' +
      '<p><b>Cliente:</b> ' + esc(s.clientName) + '<br><b>Pago:</b> ' + esc(s.payment) + (s.notes ? '<br><b>Nota:</b> ' + esc(s.notes) : '') + '</p>' +
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
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar por cliente o N.º…">' +
      '<select id="st"><option value="">Todos los estados</option>' + STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select>' +
      '<input type="date" id="from" title="Desde"><input type="date" id="to" title="Hasta"></div><div id="list"></div><p class="muted small" id="sum"></p>';
    function filtered() {
      var q = $('#q', el).value.toLowerCase(), st = $('#st', el).value, from = $('#from', el).value, to = $('#to', el).value;
      return db.sales.filter(function (s) {
        var k = dayKey(s.date);
        return (!st || s.status === st) && (!from || k >= from) && (!to || k <= to) &&
          (!q || (s.clientName + ' ' + s.number).toLowerCase().indexOf(q) >= 0);
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
      var rows = [['Numero', 'Fecha', 'Cliente', 'Pago', 'Estado', 'Subtotal', 'IVA', 'Descuento', 'Total', 'Productos']];
      filtered().forEach(function (s) {
        rows.push([s.number, fmtDateTime(s.date), s.clientName, s.payment, s.status, s.subtotal, s.iva, s.discount, s.total,
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
      { name: 'code', label: 'Código / SKU' },
      { name: 'category', label: 'Categoría', ph: 'Ej.: Bebidas' },
      { name: 'cost', label: 'Costo ($U)', type: 'number' },
      { name: 'price', label: 'Precio de venta con IVA ($U)', type: 'number', req: true },
      { name: 'iva', label: 'IVA', type: 'select', numeric: true, options: IVA_RATES, def: 22 },
      { name: 'stock', label: 'Stock actual', type: 'number', step: 1, min: -999999 },
      { name: 'minStock', label: 'Avisar cuando el stock baje de', type: 'number', step: 1, def: db.settings.lowStockDefault }
    ];
  };
  views.productos = function (el) {
    el.innerHTML = '<div class="head"><h1>Productos</h1><div class="actions"><button class="btn" id="exp">Exportar CSV</button><button class="btn primary" id="add">+ Nuevo producto</button></div></div>' +
      '<div class="toolbar"><input type="search" id="q" placeholder="Buscar producto…"><select id="cat"><option value="">Todas las categorías</option>' +
      categories().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<select id="lw"><option value="">Todo el stock</option><option value="low">Solo stock bajo</option></select></div><div id="list"></div>';
    function draw() {
      var q = $('#q', el).value.toLowerCase(), cat = $('#cat', el).value, lw = $('#lw', el).value;
      var list = db.products.filter(function (p) {
        return (!cat || p.category === cat) && (!lw || p.stock <= p.minStock) &&
          (!q || (p.name + ' ' + p.code + ' ' + p.category).toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      $('#list', el).innerHTML = list.length ? '<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Producto</th><th>Categoría</th><th class="num">Costo</th><th class="num">Precio</th><th class="num">Margen</th><th class="num">IVA</th><th class="num">Stock</th><th></th></tr></thead><tbody>' +
        list.map(function (p) {
          var net = p.price / (1 + p.iva / 100), margin = net ? (net - p.cost) / net * 100 : 0;
          return '<tr><td class="muted">' + esc(p.code) + '</td><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.category) + '</td><td class="num">' + money(p.cost) + '</td><td class="num">' + money(p.price) + '</td>' +
            '<td class="num">' + (p.cost ? margin.toFixed(0) + '%' : '—') + '</td><td class="num">' + p.iva + '%</td>' +
            '<td class="num"><span class="' + (p.stock <= p.minStock ? 'pill low' : '') + '">' + p.stock + '</span></td>' +
            '<td class="act"><button class="btn sm" data-stock="' + p.id + '">± Stock</button><button class="btn sm" data-edit="' + p.id + '">Editar</button><button class="btn sm danger" data-del="' + p.id + '">Borrar</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">No hay productos' + (db.products.length ? ' con ese filtro' : ' todavía') + '.</div>';
    }
    ['q', 'cat', 'lw'].forEach(function (id) { $('#' + id, el).addEventListener('input', draw); });
    $('#add', el).addEventListener('click', function () {
      formModal('Nuevo producto', productFields(), {}, function (o) {
        if (o.code && db.products.some(function (p) { return p.code && p.code.toLowerCase() === o.code.toLowerCase(); })) { toast('Ya existe un producto con ese código', true); return false; }
        o.id = uid(); db.products.push(o); save(); toast('Producto creado'); render();
      });
    });
    $('#list', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) {
        var p = byId(db.products, b.dataset.edit);
        formModal('Editar producto', productFields(), p, function (o) {
          if (o.code && db.products.some(function (x) { return x.id !== p.id && x.code && x.code.toLowerCase() === o.code.toLowerCase(); })) { toast('Ya existe un producto con ese código', true); return false; }
          Object.assign(p, o); save(); toast('Producto actualizado'); render();
        });
      }
      if (b.dataset.stock) {
        var ps = byId(db.products, b.dataset.stock);
        formModal('Ajustar stock: ' + ps.name, [
          { name: 'delta', label: 'Cantidad a sumar (usá negativo para restar)', type: 'number', step: 1, min: -999999, req: true, full: true }
        ], {}, function (o) { ps.stock += Math.round(o.delta); save(); toast('Stock actualizado: ' + ps.stock); draw(); });
      }
      if (b.dataset.del) {
        var pd = byId(db.products, b.dataset.del);
        if (confirm('¿Borrar "' + pd.name + '"? Las ventas anteriores se mantienen.')) {
          db.products = db.products.filter(function (x) { return x.id !== pd.id; }); save(); toast('Producto borrado'); draw();
        }
      }
    });
    $('#exp', el).addEventListener('click', function () {
      csv('productos.csv', [['Codigo', 'Nombre', 'Categoria', 'Costo', 'Precio', 'IVA', 'Stock', 'StockMinimo']].concat(
        db.products.map(function (p) { return [p.code, p.name, p.category, p.cost, p.price, p.iva, p.stock, p.minStock]; })));
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
            '<td class="act"><button class="btn sm" data-hist="' + x.c.id + '">Historial</button><button class="btn sm" data-edit="' + x.c.id + '">Editar</button><button class="btn sm danger" data-del="' + x.c.id + '">Borrar</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">No hay clientes' + (db.clients.length ? ' con ese filtro' : ' todavía') + '.</div>';
    }
    ['q', 'dbt'].forEach(function (id) { $('#' + id, el).addEventListener('input', draw); });
    $('#add', el).addEventListener('click', function () {
      formModal('Nuevo cliente', clientFields, {}, function (o) { o.id = uid(); db.clients.push(o); save(); toast('Cliente creado'); draw(); });
    });
    $('#list', el).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit) {
        var c = byId(db.clients, b.dataset.edit);
        formModal('Editar cliente', clientFields, c, function (o) {
          Object.assign(c, o);
          db.sales.forEach(function (s) { if (s.clientId === c.id) s.clientName = c.name; });
          save(); toast('Cliente actualizado'); draw();
        });
      }
      if (b.dataset.del) {
        var cd = byId(db.clients, b.dataset.del);
        if (confirm('¿Borrar a "' + cd.name + '"? Sus ventas se mantienen con el nombre guardado.')) {
          db.clients = db.clients.filter(function (x) { return x.id !== cd.id; }); save(); toast('Cliente borrado'); draw();
        }
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
    el.innerHTML = '<div class="head"><h1>Reportes</h1></div>' +
      '<div class="toolbar"><label class="small muted">Desde <input type="date" id="from" value="' + dayKey(d30) + '"></label>' +
      '<label class="small muted">Hasta <input type="date" id="to" value="' + dayKey(new Date()) + '"></label></div><div id="rep"></div>';
    function draw() {
      var from = $('#from', el).value, to = $('#to', el).value;
      var list = activeSales().filter(function (s) { var k = dayKey(s.date); return (!from || k >= from) && (!to || k <= to); });
      var total = 0, iva = 0, cost = 0, prods = {}, clients = {}, pays = {}, perDay = {};
      list.forEach(function (s) {
        total += s.total; iva += s.iva; cost += s.cost || 0;
        perDay[dayKey(s.date)] = (perDay[dayKey(s.date)] || 0) + s.total;
        pays[s.payment] = (pays[s.payment] || 0) + s.total;
        clients[s.clientName] = (clients[s.clientName] || 0) + s.total;
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
      $('#rep', el).innerHTML =
        '<div class="grid kpis"><div class="card kpi accent"><span>Ventas</span><b>' + money(total) + '</b><span>' + list.length + ' ventas</span></div>' +
        '<div class="card kpi"><span>Neto sin IVA</span><b>' + money(net) + '</b></div>' +
        '<div class="card kpi"><span>IVA a declarar</span><b>' + money(iva) + '</b></div>' +
        '<div class="card kpi"><span>Margen bruto</span><b>' + money(margin) + '</b><span class="muted small">' + (net ? (margin / net * 100).toFixed(1) : 0) + '% sobre neto</span></div></div>' +
        '<div class="card" style="margin-top:16px"><h2>Ventas por día</h2>' + barChart(days) + '</div>' +
        '<div class="grid half" style="margin-top:16px">' +
        '<div class="card"><h2>Productos más vendidos</h2>' + ranking(prods, 'amount', function (x) { return x.o.qty + ' u. · ' + money(x.v); }) + '</div>' +
        '<div class="card"><h2>Mejores clientes</h2>' + ranking(clients, null, function (x) { return money(x.v); }) + '</div>' +
        '<div class="card"><h2>Por medio de pago</h2>' + ranking(pays, null, function (x) { return money(x.v); }) + '</div>' +
        '<div class="card"><h2>Exportar</h2><p class="muted">Descargá el detalle de ventas del período para Excel.</p><button class="btn primary" id="expR">Exportar ventas del período (CSV)</button></div></div>';
      $('#expR', el).addEventListener('click', function () {
        var rows = [['Numero', 'Fecha', 'Cliente', 'Producto', 'Cantidad', 'PrecioUnit', 'IVA', 'Importe', 'Pago', 'Estado']];
        list.forEach(function (s) { s.items.forEach(function (it) { rows.push([s.number, fmtDateTime(s.date), s.clientName, it.name, it.qty, it.price, it.iva + '%', round2(it.qty * it.price), s.payment, s.status]); }); });
        csv('reporte-ventas.csv', rows);
      });
    }
    ['from', 'to'].forEach(function (id) { $('#' + id, el).addEventListener('change', draw); });
    draw();
  };

  // ----- Configuración -----
  views.config = function (el) {
    var st = db.settings;
    el.innerHTML = '<div class="head"><h1>Configuración</h1></div><div class="grid half">' +
      '<div class="card"><h2>Datos de la empresa</h2><p class="muted small">Salen en los comprobantes.</p><form class="form" id="cfg">' +
      field({ name: 'company', label: 'Nombre', full: true, req: true }, st.company) +
      field({ name: 'rut', label: 'RUT' }, st.rut) + field({ name: 'phone', label: 'Teléfono' }, st.phone) +
      field({ name: 'address', label: 'Dirección', full: true }, st.address) +
      field({ name: 'nextNumber', label: 'Próximo N.º de venta', type: 'number', step: 1, min: 1 }, st.nextNumber) +
      field({ name: 'lowStockDefault', label: 'Stock mínimo por defecto', type: 'number', step: 1 }, st.lowStockDefault) +
      '<div class="full"><button class="btn primary">Guardar</button></div></form></div>' +
      '<div class="card"><h2>Respaldo de datos</h2><p class="muted small">Tus datos se guardan en este navegador. Descargá un respaldo seguido y usalo para pasarlos a otro equipo.</p>' +
      '<p class="small">' + db.products.length + ' productos · ' + db.clients.length + ' clientes · ' + db.sales.length + ' ventas</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn dark" id="bk">Descargar respaldo</button>' +
      '<label class="btn">Restaurar respaldo<input type="file" id="rs" accept=".json,application/json" hidden></label></div>' +
      '<hr style="border:0;border-top:1px solid #ececec;margin:20px 0"><h2>Zona de cuidado</h2>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="demo">Cargar datos de ejemplo</button><button class="btn danger" id="wipe">Borrar todos los datos</button></div></div></div>';

    $('#cfg', el).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = this.elements;
      st.company = f.company.value.trim(); st.rut = f.rut.value.trim(); st.phone = f.phone.value.trim(); st.address = f.address.value.trim();
      st.nextNumber = Math.max(1, Math.round(num(f.nextNumber.value)));
      st.lowStockDefault = Math.max(0, Math.round(num(f.lowStockDefault.value)));
      save(); toast('Configuración guardada');
    });
    $('#bk', el).addEventListener('click', function () {
      download('svc-respaldo-' + dayKey(new Date()) + '.json', JSON.stringify(db, null, 2), 'application/json');
    });
    $('#rs', el).addEventListener('change', function () {
      var file = this.files[0]; if (!file) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result);
          if (!data || !Array.isArray(data.products) || !Array.isArray(data.sales)) throw new Error('formato');
          if (!confirm('Esto reemplaza todos los datos actuales por los del respaldo. ¿Seguir?')) return;
          localStorage.setItem(KEY, JSON.stringify(data)); load(); toast('Respaldo restaurado'); render();
        } catch (e) { toast('El archivo no es un respaldo válido de SVC', true); }
      };
      r.readAsText(file);
    });
    $('#demo', el).addEventListener('click', function () {
      if ((db.products.length || db.sales.length) && !confirm('Se agregan productos, clientes y ventas de ejemplo a tus datos actuales. ¿Seguir?')) return;
      seedDemo(); toast('Datos de ejemplo cargados'); render();
    });
    $('#wipe', el).addEventListener('click', function () {
      if (!confirm('¿Borrar TODOS los productos, clientes y ventas de este navegador? No se puede deshacer. Descargá un respaldo antes.')) return;
      db = emptyDB(); save(); toast('Datos borrados'); render();
    });
  };

  // ---------- datos de ejemplo ----------
  function seedDemo() {
    var P = [
      ['BEB-001', 'Agua mineral 2 L', 'Bebidas', 38, 65, 22, 120], ['BEB-002', 'Refresco cola 1,5 L', 'Bebidas', 70, 119, 22, 80],
      ['BEB-003', 'Jugo de naranja 1 L', 'Bebidas', 55, 95, 22, 40], ['ALM-001', 'Arroz 1 kg', 'Almacén', 45, 72, 10, 90],
      ['ALM-002', 'Fideos 500 g', 'Almacén', 30, 52, 10, 110], ['ALM-003', 'Aceite girasol 900 ml', 'Almacén', 85, 139, 10, 4],
      ['ALM-004', 'Yerba mate 1 kg', 'Almacén', 160, 255, 10, 60], ['LIM-001', 'Detergente 750 ml', 'Limpieza', 60, 99, 22, 35],
      ['LIM-002', 'Lavandina 2 L', 'Limpieza', 40, 69, 22, 3], ['LAC-001', 'Leche entera 1 L', 'Lácteos', 32, 48, 10, 70],
      ['LAC-002', 'Queso dambo kg', 'Lácteos', 290, 459, 10, 18], ['PAN-001', 'Galletitas surtidas', 'Panadería', 48, 79, 22, 50]
    ];
    var newP = P.map(function (x) { return { id: uid(), code: x[0], name: x[1], category: x[2], cost: x[3], price: x[4], iva: x[5], stock: x[6], minStock: 5 }; });
    var C = [['Almacén El Puerto', '211234560019', '099 123 456', 'Rambla 1234, Montevideo'], ['Kiosco Central', '4.567.890-1', '098 765 432', '18 de Julio 900'],
      ['Super Del Barrio', '217654320015', '2900 1122', 'Av. Italia 3300'], ['Restorán La Esquina', '214445550012', '091 222 333', 'Sarandí 450'],
      ['María Fernández', '3.456.789-0', '094 555 666', 'Pocitos'], ['Distribuidora Norte', '219998880017', '4732 1100', 'Salto']];
    var newC = C.map(function (x) { return { id: uid(), name: x[0], doc: x[1], phone: x[2], email: '', address: x[3], notes: '' }; });
    db.products = db.products.concat(newP);
    db.clients = db.clients.concat(newC);
    var rnd = function (n) { return Math.floor(Math.random() * n); };
    for (var i = 0; i < 70; i++) {
      var date = new Date(); date.setDate(date.getDate() - rnd(30)); date.setHours(8 + rnd(11), rnd(60), 0, 0);
      var items = [], used = {};
      for (var j = 0, n = 1 + rnd(4); j < n; j++) {
        var p = newP[rnd(newP.length)]; if (used[p.id]) continue; used[p.id] = 1;
        items.push({ productId: p.id, name: p.name, code: p.code, qty: 1 + rnd(6), price: p.price, iva: p.iva, cost: p.cost });
      }
      var c = rnd(4) ? newC[rnd(newC.length)] : null;
      var pay = PAYMENTS[rnd(c ? 5 : 4)];
      var status = pay === 'Cuenta corriente' ? (rnd(2) ? 'pendiente' : 'pagada') : (rnd(10) ? 'pagada' : 'entregada');
      var disc = rnd(6) ? 0 : 5;
      var s = { id: uid(), number: 0, date: date.toISOString(), clientId: c ? c.id : '', clientName: c ? c.name : 'Consumidor final',
        items: items, discountPct: disc, payment: pay, status: status, notes: '' };
      Object.assign(s, calcSale(items, disc));
      db.sales.push(s);
    }
    db.sales.sort(function (a, b) { return a.date.localeCompare(b.date); });
    db.sales.forEach(function (s) { if (!s.number) s.number = db.settings.nextNumber++; });
    save();
  }

  // ---------- router ----------
  function render() {
    var name = (location.hash.replace(/^#\/?/, '') || 'panel').split('?')[0];
    if (!views[name]) name = 'panel';
    $$('.side a.nav').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#/' + name); });
    closeModal();
    var el = $('#view');
    el.innerHTML = '';
    views[name](el);
    document.title = 'SVC · ' + ($('.side a.nav.on') ? $('.side a.nav.on').textContent.replace(/^\W+/, '') : 'Sistema de Ventas');
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('storage', function (e) { if (e.key === KEY) { load(); render(); } });
  load();
  render();
})();
