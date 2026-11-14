/* SVC · Perfil del negocio: tipo y tamaño del local, exhibición, competencia, categorías de interés,
   días y horario de atención, notas y fotos de fachada / góndola. Usa window.SVC (app.js). */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, $$ = S.$$, esc = S.esc, api = S.api, toast = S.toast;

  var OPTIONS = {
    businessType: ['Almacén', 'Autoservicio', 'Supermercado', 'Kiosco', 'Farmacia', 'Panadería', 'Bar / Restaurante', 'Residencial', 'Colegio / Club', 'Institución', 'Distribuidor'],
    exhibition: ['Góndola', 'Mostrador', 'Heladera', 'Exhibidor de pie', 'Punta de góndola', 'Vidriera', 'Sin exhibición (depósito)'],
    competitors: [],
    days: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
  };
  var LABELS = { size: 'Tamaño', businessType: 'Tipo de negocio', exhibition: 'Exhibición', competitors: 'Competencia presente', interests: 'Categorías de interés', days: 'Días de atención', hours: 'Horario', notes: 'Notas' };
  var SIZES = [{ v: 'chico', t: 'Chico' }, { v: 'mediano', t: 'Mediano' }, { v: 'grande', t: 'Grande' }];
  var KINDS = { fachada: 'Fachada', gondola: 'Góndola', otra: 'Otra' };
  var imgUrl = function (id) { return '/api/images/' + encodeURIComponent(id); };

  function categories() {
    var s = {}; S.db.products.forEach(function (p) { if (p.category) s[p.category.charAt(0).toUpperCase() + p.category.slice(1).toLowerCase()] = 1; });
    return Object.keys(s).sort();
  }
  // sugerencias de competencia: las que ya cargó el equipo en otros perfiles
  var suggestP = null;
  function suggestions() {
    if (!suggestP) suggestP = api('GET', '/profiles').then(function (list) {
      var s = {}; list.forEach(function (p) { (p.competitors || []).forEach(function (x) { s[x] = 1; }); });
      return Object.keys(s).sort();
    }, function () { suggestP = null; return []; });
    return suggestP;
  }
  function filled(p) { return p && (p.size || p.hours || p.notes || ['businessType', 'exhibition', 'competitors', 'interests', 'days'].some(function (k) { return (p[k] || []).length; }) || (p.photos || []).length); }

  // ---------- resumen (en la ficha del comercio) ----------
  S.loadProfileSummary = function (box, c) {
    if (!box) return;
    box.innerHTML = '<p class="muted small">Cargando perfil…</p>';
    api('GET', '/profiles/' + encodeURIComponent(c.id)).then(function (p) {
      var tags = [].concat(p.businessType || [], p.size ? ['Local ' + p.size] : [], p.exhibition || []);
      box.innerHTML = filled(p)
        ? '<div class="prof-tags">' + tags.map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join('') + '</div>' +
          ((p.competitors || []).length ? '<p class="small"><b>Competencia:</b> ' + esc(p.competitors.join(', ')) + '</p>' : '') +
          ((p.interests || []).length ? '<p class="small"><b>Le interesa:</b> ' + esc(p.interests.join(', ')) + '</p>' : '') +
          ((p.days || []).length || p.hours ? '<p class="small"><b>Atiende:</b> ' + esc([(p.days || []).join(' '), p.hours].filter(Boolean).join(' · ')) + '</p>' : '') +
          ((p.photos || []).length ? '<div class="prof-thumbs">' + p.photos.slice(0, 4).map(function (ph) { return '<img src="' + imgUrl(ph.imageId) + '" alt="' + esc(KINDS[ph.kind]) + '" loading="lazy">'; }).join('') + '</div>' : '') +
          '<p class="muted small">Actualizado ' + (p.updatedAt || p.photosAt ? S.fmtDate(p.updatedAt || p.photosAt) + (p.updatedBy ? ' por ' + esc(p.updatedBy) : '') : '') + '</p>'
        : '<p class="muted small">Todavía no tiene perfil cargado.</p>';
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn sm' + (filled(p) ? '' : ' primary'); b.textContent = filled(p) ? '✏️ Actualizar perfil' : '+ Cargar perfil del negocio';
      b.addEventListener('click', function () { S.openProfile(c, function () { S.loadProfileSummary(box, c); }); });
      box.appendChild(b);
    }, function (e) { box.innerHTML = '<p class="muted small">' + esc(e.message) + '</p>'; });
  };

  // ---------- formulario ----------
  S.openProfile = function (c, after) {
    if (!c) return;
    api('GET', '/profiles/' + encodeURIComponent(c.id)).then(function (p) {
      return suggestions().then(function (sug) { draw(c, p, sug, after); });
    }).catch(function (e) { toast(e.message, true); });
  };

  function chipGroup(key, options, selected, multi, addable) {
    var all = options.slice();
    (selected || []).forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); });
    return '<div class="pf-group" data-key="' + key + '" data-multi="' + (multi ? 1 : 0) + '"><b class="pf-label">' + esc(LABELS[key]) + '</b><div class="chips">' +
      all.map(function (o) { var v = typeof o === 'string' ? o : o.v, t = typeof o === 'string' ? o : o.t; return '<button type="button" class="chip' + ((multi ? (selected || []).indexOf(v) >= 0 : selected === v) ? ' on' : '') + '" data-v="' + esc(v) + '">' + esc(t) + '</button>'; }).join('') +
      (addable ? '<span class="chip-add"><input type="text" placeholder="Agregar…" maxlength="60" aria-label="Agregar en ' + esc(LABELS[key]) + '"><button type="button" class="btn sm">+</button></span>' : '') +
      '</div></div>';
  }

  function draw(c, p, sug, after) {
    var cats = categories();
    var html = '<div class="pf">' +
      '<p class="muted small">' + esc(c.address || '') + (p.updatedAt ? ' · Última actualización: ' + S.fmtDateTime(p.updatedAt) + ' por ' + esc(p.updatedBy) : '') + '</p>' +
      '<div class="pf-photos"><b class="pf-label">Fotos</b><div class="pf-photo-btns">' +
      '<label class="btn">📷 Fachada<input type="file" accept="image/*" capture="environment" data-kind="fachada" hidden></label>' +
      '<label class="btn">📷 Góndola<input type="file" accept="image/*" capture="environment" data-kind="gondola" hidden></label>' +
      '<label class="btn">📷 Otra<input type="file" accept="image/*" capture="environment" data-kind="otra" hidden></label></div>' +
      '<div class="pf-grid" id="pfGrid"></div></div>' +
      chipGroup('businessType', OPTIONS.businessType, p.businessType, true, true) +
      chipGroup('size', SIZES, p.size, false, false) +
      chipGroup('exhibition', OPTIONS.exhibition, p.exhibition, true, true) +
      chipGroup('competitors', sug, p.competitors, true, true) +
      chipGroup('interests', cats, p.interests, true, true) +
      chipGroup('days', OPTIONS.days, p.days, true, false) +
      '<label class="f full">Horario<input id="pfHours" maxlength="120" value="' + esc(p.hours || '') + '" placeholder="Ej.: 8 a 13 y 16 a 20 · mejor visitar de mañana"></label>' +
      '<label class="f full">Notas del perfil<textarea id="pfNotes" rows="2" maxlength="1000" placeholder="Quién decide las compras, cómo paga, particularidades…">' + esc(p.notes || '') + '</textarea></label>' +
      ((p.history || []).length ? '<details class="pf-hist"><summary>Cambios anteriores (' + p.history.length + ')</summary><ul class="plain small">' + p.history.map(function (h) {
        return '<li><b>' + S.fmtDateTime(h.at) + '</b>' + (h.by ? ' · ' + esc(h.by) : '') + ': ' + h.changed.map(function (k) {
          var v = h[k]; v = Array.isArray(v) ? v.join(', ') : v;
          return esc(LABELS[k] || k) + ' era “' + esc(v || '—') + '”';
        }).join('; ') + '</li>';
      }).join('') + '</ul></details>' : '') +
      '<div class="foot"><button class="btn" data-close>Cerrar</button><button class="btn primary" id="pfSave">Guardar perfil</button></div></div>';

    S.openModal('Perfil · ' + c.name, html, function (m) {
      function drawPhotos() {
        var ph = p.photos || [];
        $('#pfGrid', m).innerHTML = ph.length ? ph.map(function (x) {
          return '<figure><a href="' + imgUrl(x.imageId) + '" target="_blank" rel="noopener"><img src="' + imgUrl(x.imageId) + '" alt="' + esc(KINDS[x.kind]) + '" loading="lazy"></a>' +
            '<figcaption><b>' + esc(KINDS[x.kind] || '') + '</b> ' + S.fmtDate(x.at) + '<br><span class="muted">' + esc(x.by || '') + '</span></figcaption>' +
            '<button type="button" class="pf-del" data-del="' + esc(x.imageId) + '" aria-label="Borrar foto">✕</button></figure>';
        }).join('') : '<p class="muted small">Sin fotos todavía. Con la tablet se abre la cámara.</p>';
      }
      drawPhotos();
      m.addEventListener('click', function (e) {
        var chip = e.target.closest('.chip');
        if (chip) {
          var g = chip.closest('.pf-group');
          if (g.dataset.multi === '1') chip.classList.toggle('on');
          else { var was = chip.classList.contains('on'); $$('.chip', g).forEach(function (x) { x.classList.remove('on'); }); if (!was) chip.classList.add('on'); }
          return;
        }
        var add = e.target.closest('.chip-add button');
        if (add) addChip(add.parentNode);
        var del = e.target.closest('[data-del]');
        if (del && confirm('¿Borrar esta foto?')) {
          del.disabled = true;
          api('DELETE', '/profiles/' + encodeURIComponent(c.id) + '/photos/' + encodeURIComponent(del.dataset.del)).then(function (np) { p.photos = np.photos; drawPhotos(); toast('Foto borrada'); }, function (er) { toast(er.message, true); del.disabled = false; });
        }
      });
      m.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.closest('.chip-add')) { e.preventDefault(); addChip(e.target.parentNode); } });
      function addChip(wrapEl) {
        var inp = $('input', wrapEl), v = inp.value.trim(); if (!v) return;
        var g = wrapEl.closest('.pf-group');
        var ex = $$('.chip', g).filter(function (x) { return x.dataset.v.toLowerCase() === v.toLowerCase(); })[0];
        if (ex) ex.classList.add('on');
        else { var b = document.createElement('button'); b.type = 'button'; b.className = 'chip on'; b.dataset.v = v; b.textContent = v; wrapEl.parentNode.insertBefore(b, wrapEl); }
        inp.value = ''; inp.focus();
      }
      $$('input[type=file]', m).forEach(function (inp) {
        inp.addEventListener('change', function () {
          var file = inp.files[0]; if (!file) return;
          var lbl = inp.parentNode, txt = lbl.firstChild.textContent; lbl.firstChild.textContent = 'Subiendo…'; lbl.classList.add('busy');
          S.shrinkImage(file, 1280).then(function (dataUrl) {
            return api('POST', '/profiles/' + encodeURIComponent(c.id) + '/photos', { dataUrl: dataUrl, kind: inp.dataset.kind });
          }).then(function (np) { p.photos = np.photos; drawPhotos(); toast('Foto guardada'); if (after) after(); },
            function (er) { toast(er.message, true); })
            .then(function () { lbl.firstChild.textContent = txt; lbl.classList.remove('busy'); inp.value = ''; });
        });
      });
      $('#pfSave', m).addEventListener('click', function () {
        var b = this, body = { hours: $('#pfHours', m).value, notes: $('#pfNotes', m).value };
        $$('.pf-group', m).forEach(function (g) {
          var on = $$('.chip.on', g).map(function (x) { return x.dataset.v; });
          body[g.dataset.key] = g.dataset.multi === '1' ? on : (on[0] || '');
        });
        b.disabled = true;
        api('PUT', '/profiles/' + encodeURIComponent(c.id), body).then(function () {
          suggestP = null; S.closeModal(); toast('Perfil guardado'); if (after) after();
        }, function (er) { toast(er.message, true); b.disabled = false; });
      });
    }, true);
  }
})();
