/* SVC · Notas de audio de las visitas (grabar, escuchar, borrar) y dictado por voz en la nota.
   Usa window.SVC (app.js). */
(function () {
  'use strict';
  var S = window.SVC;
  var $ = S.$, esc = S.esc, api = S.api, toast = S.toast;
  var MAX_S = 120;

  var fmtS = function (s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
  var src = function (id) { return '/api/audios/' + encodeURIComponent(id); };

  // Reproductores de los audios de una visita (para Jornada y el historial).
  S.audioPlayers = function (v) {
    return (v.audios || []).map(function (a) {
      return '<div class="aud"><audio controls preload="none" src="' + src(a.id) + '"></audio><span class="muted small">' + fmtS(a.durationS) + '</span></div>';
    }).join('');
  };

  S.canRecord = function () { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); };

  // Grabador dentro de una visita: botón grabar / detener, lista con escuchar y borrar.
  S.bindAudioRecorder = function (box, visit, onUpdate) {
    var rec = null, chunks = [], t0 = 0, timer = null, stream = null;
    function draw() {
      var list = visit.audios || [];
      box.innerHTML = '<div class="aud-head"><b>Notas de audio</b><span class="muted small">hasta ' + MAX_S / 60 + ' min cada una · ' + list.length + ' de 3</span></div>' +
        (list.length ? list.map(function (a) {
          return '<div class="aud"><audio controls preload="none" src="' + src(a.id) + '"></audio><span class="muted small">' + fmtS(a.durationS) + '</span>' +
            '<button type="button" class="btn sm danger" data-adel="' + esc(a.id) + '" aria-label="Borrar audio">✕</button></div>';
        }).join('') : '') +
        (S.canRecord() ? (list.length < 3 ? '<button type="button" class="btn rec" id="recBtn">🎙️ Grabar nota de audio</button>' : '')
          : '<p class="muted small">Este navegador no permite grabar audio.</p>');
      var b = $('#recBtn', box); if (b) b.addEventListener('click', toggle);
    }
    function toggle() { if (rec) stop(); else start(); }
    function start() {
      var b = $('#recBtn', box); b.disabled = true;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
        stream = st;
        var types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
        var type = types.filter(function (t) { return window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t); })[0];
        var opts = { audioBitsPerSecond: 32000 }; if (type) opts.mimeType = type;
        rec = new window.MediaRecorder(st, opts); chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = upload;
        rec.start(1000); t0 = Date.now();
        b.disabled = false; b.classList.add('on');
        timer = setInterval(function () {
          var s = (Date.now() - t0) / 1000;
          b.textContent = '⏹ Detener · ' + fmtS(s) + ' / ' + fmtS(MAX_S);
          if (s >= MAX_S) stop();
        }, 250);
        b.textContent = '⏹ Detener · 0:00';
      }, function () { b.disabled = false; toast('No se pudo usar el micrófono. Revisá que el navegador tenga permiso.', true); });
    }
    function stop() {
      clearInterval(timer);
      if (rec && rec.state !== 'inactive') rec.stop();
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      var b = $('#recBtn', box); if (b) { b.disabled = true; b.textContent = 'Guardando audio…'; }
    }
    function upload() {
      var dur = Math.round((Date.now() - t0) / 1000), blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      rec = null;
      if (dur < 1 || !blob.size) { draw(); return; }
      var fr = new FileReader();
      fr.onload = function () {
        api('POST', '/visits/' + visit.id + '/audio', { dataUrl: fr.result, durationS: dur }).then(function (v) {
          visit.audios = v.audios; toast('Audio guardado'); draw(); if (onUpdate) onUpdate(v);
        }, function (e) { toast(e.message, true); draw(); });
      };
      fr.readAsDataURL(blob);
    }
    box.addEventListener('click', function (e) {
      var d = e.target.closest('[data-adel]'); if (!d || !confirm('¿Borrar este audio?')) return;
      d.disabled = true;
      api('DELETE', '/visits/' + visit.id + '/audio/' + encodeURIComponent(d.dataset.adel)).then(function (v) { visit.audios = v.audios; draw(); if (onUpdate) onUpdate(v); }, function (er) { toast(er.message, true); d.disabled = false; });
    });
    draw();
    return { busy: function () { return !!rec; }, stop: stop };
  };

  // Dictado: el navegador pasa la voz a texto y la agrega a la nota (Chrome / Android).
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  S.canDictate = function () { return !!SR; };
  S.bindDictation = function (btn, textarea) {
    if (!SR) { btn.hidden = true; return; }
    var r = null, base = '';
    btn.addEventListener('click', function () {
      if (r) { r.stop(); return; }
      r = new SR(); r.lang = 'es-UY'; r.continuous = true; r.interimResults = true;
      base = textarea.value ? textarea.value.replace(/\s*$/, ' ') : '';
      r.onresult = function (e) {
        var fin = '', tmp = '';
        for (var i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript; else tmp += e.results[i][0].transcript; }
        textarea.value = base + fin + tmp;
      };
      r.onerror = function (e) { if (e.error === 'not-allowed') toast('El navegador no tiene permiso para usar el micrófono.', true); };
      r.onend = function () { r = null; btn.classList.remove('on'); btn.textContent = '🎤 Dictar'; };
      r.start(); btn.classList.add('on'); btn.textContent = '⏹ Terminar dictado';
    });
  };
})();
