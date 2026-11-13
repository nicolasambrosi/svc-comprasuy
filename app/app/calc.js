/* Cálculo de totales de una venta. Lo usan el navegador y el servidor.
   Los precios incluyen IVA. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SVCCalc = factory();
})(this, function () {
  var num = function (v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
  var round2 = function (n) { return Math.round(n * 100) / 100; };
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
  return { calcSale: calcSale, num: num, round2: round2 };
});
