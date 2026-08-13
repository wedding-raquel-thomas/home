(function () {
  var cfg = window.RIFA_CONFIG || {};
  var SCRIPT_URL = (cfg.SCRIPT_URL || '').trim();
  var PRECO = cfg.PRECO || 20;
  var MAX = cfg.MAX_POR_PEDIDO || 20;
  var STORAGE_KEY = 'rifaPedidoAtual';
  var PICKS_KEY = 'rifaPicks';
  var qrcode = null;
  var pollTimer = null;
  var selected = {};
  var lastStatus = { vendidosLista: [], reservadosLista: [] };
  var pickingEnabled = true;

  function $(id) {
    return document.getElementById(id);
  }

  function money(n) {
    return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
  }

  function selectedList() {
    return Object.keys(selected).map(Number).sort(function (a, b) { return a - b; });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = 'rifaCb' + Date.now() + Math.floor(Math.random() * 1000);
      var timeout = setTimeout(function () {
        cleanup();
        reject(new Error('Demorou demais. Tente de novo.'));
      }, 20000);
      function cleanup() {
        clearTimeout(timeout);
        delete window[cb];
        if (script && script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) {
        cleanup();
        resolve(data);
      };
      var script = document.createElement('script');
      var q = new URLSearchParams(params);
      q.set('callback', cb);
      script.src = SCRIPT_URL + (SCRIPT_URL.indexOf('?') === -1 ? '?' : '&') + q.toString();
      script.onerror = function () {
        cleanup();
        reject(new Error('Não conseguiu falar com o sistema da rifa.'));
      };
      document.body.appendChild(script);
    });
  }

  function postNoCors(payload) {
    return fetch(SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function postAndWait(payload, lookup) {
    await postNoCors(payload);
    var last = null;
    for (var i = 0; i < 40; i++) {
      await sleep(900);
      last = await lookup();
      if (last && last.ok && !last.pending) return last;
      if (last && last.ok === false && last.error) return last;
    }
    return last || { ok: false, error: 'Não recebemos resposta. Tente de novo.' };
  }

  function configured() {
    return SCRIPT_URL && SCRIPT_URL.indexOf('http') === 0;
  }

  function show(id) {
    ['step-form', 'step-pay', 'step-wait', 'step-done', 'step-setup'].forEach(function (s) {
      var el = $(s);
      if (el) el.classList.toggle('is-hidden', s !== id);
    });
    pickingEnabled = id === 'step-form';
    var boardCard = $('board-card');
    if (boardCard) boardCard.classList.toggle('is-picking', pickingEnabled);
  }

  function setError(msg) {
    var el = $('rifa-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-hidden', !msg);
  }

  function saveLocal(pedido) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pedido));
      localStorage.setItem(PICKS_KEY, JSON.stringify(selectedList()));
    } catch (e) {}
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function loadPicks() {
    try {
      var raw = localStorage.getItem(PICKS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      selected = {};
      (arr || []).forEach(function (n) { selected[n] = true; });
    } catch (e) {
      selected = {};
    }
  }

  function clearLocal() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PICKS_KEY);
    } catch (e) {}
    selected = {};
  }

  function updateTotal() {
    var list = selectedList();
    var q = list.length;
    $('total-valor').textContent = money(q * PRECO);
    $('qtd-escolhida').textContent = String(q);
    $('escolhidos-texto').textContent = q ? list.join(', ') : 'nenhum ainda';
    var btn = $('btn-gerar');
    if (btn) btn.disabled = q < 1;
  }

  function renderBoard(vendidos, reservados, meus) {
    var board = $('rifa-board');
    if (!board) return;
    lastStatus.vendidosLista = vendidos || lastStatus.vendidosLista || [];
    lastStatus.reservadosLista = reservados || lastStatus.reservadosLista || [];
    var sold = {};
    lastStatus.vendidosLista.forEach(function (n) { sold[n] = true; });
    var held = {};
    lastStatus.reservadosLista.forEach(function (n) { held[n] = true; });
    var mine = {};
    (meus || []).forEach(function (n) { mine[n] = true; });
    var html = '';
    for (var n = 1; n <= 500; n++) {
      var cls = 'rifa-num';
      if (mine[n]) cls += ' is-mine';
      else if (sold[n]) cls += ' is-sold';
      else if (held[n] && !selected[n]) cls += ' is-reserved';
      else if (selected[n]) cls += ' is-picked';
      html += '<button type="button" class="' + cls + '" data-n="' + n + '"' +
        ((sold[n] || (held[n] && !selected[n]) || mine[n] || !pickingEnabled) ? ' disabled' : '') +
        '>' + n + '</button>';
    }
    board.innerHTML = html;
  }

  function togglePick(n) {
    if (!pickingEnabled) return;
    if (selected[n]) {
      delete selected[n];
    } else {
      if (selectedList().length >= MAX) {
        setError('Máximo de ' + MAX + ' números por vez.');
        return;
      }
      setError('');
      selected[n] = true;
    }
    updateTotal();
    renderBoard(lastStatus.vendidosLista, lastStatus.reservadosLista, []);
  }

  function renderQr(payload) {
    var box = $('pix-qr');
    box.innerHTML = '';
    qrcode = new QRCode(box, {
      text: payload,
      width: 220,
      height: 220,
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  function statusLabel(status) {
    if (status === 'pendente') return 'Pague o PIX abaixo';
    if (status === 'aguardando_aprovacao') return 'Comprovante recebido. Esperando confirmação.';
    if (status === 'pago') return 'Pagamento confirmado!';
    if (status === 'expirado') return 'Reserva expirou. Faça um novo pedido.';
    if (status === 'cancelado') return 'Pedido cancelado.';
    return status;
  }

  function escolhidosLabel() {
    var list = selectedList();
    return list.length ? list.join(', ') : '—';
  }

  function renderPedido(pedido, statusInfo) {
    if (!pedido) return;
    saveLocal(pedido);
    selectedList().forEach(function (n) {
      if (lastStatus.reservadosLista.indexOf(n) === -1) lastStatus.reservadosLista.push(n);
    });
    $('pedido-id').textContent = pedido.id;
    $('pedido-valor').textContent = money(pedido.valor);
    $('pedido-status').textContent = statusLabel(pedido.status);
    $('pix-copia').value = pedido.pixPayload || '';
    $('pedido-escolhidos').textContent = escolhidosLabel();

    if (pedido.status === 'pago') {
      $('numeros-finais').textContent = pedido.numerosTexto || pedido.numeros.join(', ') || escolhidosLabel();
      show('step-done');
      renderBoard(
        statusInfo && statusInfo.vendidosLista,
        statusInfo && statusInfo.reservadosLista,
        pedido.numeros && pedido.numeros.length ? pedido.numeros : selectedList()
      );
      stopPoll();
      return;
    }
    if (pedido.status === 'aguardando_aprovacao') {
      show('step-wait');
      renderBoard(lastStatus.vendidosLista, lastStatus.reservadosLista, []);
      startPoll(pedido.id);
      return;
    }
    if (pedido.status === 'expirado' || pedido.status === 'cancelado') {
      setError(statusLabel(pedido.status));
      clearLocal();
      show('step-form');
      loadStatus().catch(function () {});
      stopPoll();
      return;
    }
    show('step-pay');
    renderBoard(lastStatus.vendidosLista, lastStatus.reservadosLista, []);
    if (pedido.pixPayload) renderQr(pedido.pixPayload);
    startPoll(pedido.id);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll(pedidoId) {
    stopPoll();
    pollTimer = setInterval(function () {
      jsonp({ action: 'consultar', pedidoId: pedidoId }).then(function (res) {
        if (res && res.ok && res.pedido) {
          if (res.pedido.status !== 'pendente') renderPedido(res.pedido, lastStatus);
        }
      }).catch(function () {});
    }, 8000);
  }

  async function loadStatus() {
    var res = await jsonp({ action: 'status' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Falha ao carregar a rifa.');
    PRECO = res.preco || PRECO;
    MAX = res.maxPorPedido || MAX;
    $('stat-vendidos').textContent = res.vendidos;
    $('stat-disponiveis').textContent = res.disponiveis;
    $('stat-preco').textContent = money(PRECO);
    lastStatus = res;
    renderBoard(res.vendidosLista, res.reservadosLista, pickingEnabled ? [] : selectedList());
    updateTotal();
    return res;
  }

  async function criarPedido(ev) {
    ev.preventDefault();
    setError('');
    var nome = $('nome').value.trim();
    var numeros = selectedList();
    if (nome.length < 2) return setError('Informe seu nome.');
    if (!numeros.length) return setError('Clique nos números que quer na grade.');
    $('btn-gerar').disabled = true;
    $('btn-gerar').textContent = 'Reservando números...';
    try {
      var requestId = uuid();
      var res = await postAndWait(
        { action: 'criarPedido', nome: nome, numeros: numeros, quantidade: numeros.length, requestId: requestId },
        function () { return jsonp({ action: 'consultarRequest', requestId: requestId }); }
      );
      if (!res.ok || !res.pedido) throw new Error((res && res.error) || 'Não deu para reservar.');
      renderPedido(res.pedido, lastStatus);
    } catch (err) {
      setError(err.message || 'Erro ao criar pedido.');
      loadStatus().catch(function () {});
    } finally {
      $('btn-gerar').disabled = selectedList().length < 1;
      $('btn-gerar').textContent = 'Gerar pagamento';
    }
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Não leu o arquivo.')); };
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 900;
          var w = img.width;
          var h = img.height;
          if (w > max || h > max) {
            if (w >= h) {
              h = Math.round(h * max / w);
              w = max;
            } else {
              w = Math.round(w * max / h);
              h = max;
            }
          }
          var canvas = document.createElement('canvas');
          var ctx = canvas.getContext('2d');
          function encode() {
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0, w, h);
            var q = 0.7;
            var dataUrl = canvas.toDataURL('image/jpeg', q);
            while (dataUrl.length > 45000 && q > 0.25) {
              q -= 0.1;
              dataUrl = canvas.toDataURL('image/jpeg', q);
            }
            return dataUrl;
          }
          var dataUrl = encode();
          while (dataUrl.length > 45000 && (w > 240 || h > 240)) {
            w = Math.round(w * 0.75);
            h = Math.round(h * 0.75);
            dataUrl = encode();
          }
          if (dataUrl.length > 45000) {
            reject(new Error('Foto grande demais. Envie um print da tela do PIX.'));
            return;
          }
          resolve(dataUrl);
        };
        img.onerror = function () { reject(new Error('Imagem inválida.')); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function enviarComprovante() {
    setError('');
    var file = $('comprovante').files[0];
    if (!file) return setError('Escolha a foto do comprovante.');
    var local = loadLocal();
    if (!local || !local.id) return setError('Pedido não encontrado. Recarregue.');
    $('btn-comprovante').disabled = true;
    $('btn-comprovante').textContent = 'Enviando...';
    try {
      var dataUrl = await compressImage(file);
      var res = await postAndWait(
        { action: 'enviarComprovante', pedidoId: local.id, comprovante: dataUrl },
        function () {
          return jsonp({ action: 'consultar', pedidoId: local.id }).then(function (r) {
            if (!r || !r.ok) return r;
            if (r.pedido && (r.pedido.status === 'aguardando_aprovacao' || r.pedido.status === 'pago')) return r;
            return { ok: true, pending: true };
          });
        }
      );
      if (!res.ok || !res.pedido) throw new Error((res && res.error) || 'Falha ao enviar.');
      renderPedido(res.pedido, lastStatus);
    } catch (err) {
      setError(err.message || 'Erro ao enviar comprovante.');
    } finally {
      $('btn-comprovante').disabled = false;
      $('btn-comprovante').textContent = 'Enviar comprovante';
    }
  }

  function copyPix() {
    var el = $('pix-copia');
    el.select();
    el.setSelectionRange(0, 99999);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.value).catch(function () {});
    } else {
      try { document.execCommand('copy'); } catch (e) {}
    }
    $('btn-copiar').textContent = 'Copiado!';
    setTimeout(function () { $('btn-copiar').textContent = 'Copiar código PIX'; }, 2000);
  }

  function novoPedido() {
    clearLocal();
    stopPoll();
    setError('');
    show('step-form');
    updateTotal();
    loadStatus().catch(function () {});
  }

  async function init() {
    $('form-rifa').addEventListener('submit', criarPedido);
    $('btn-copiar').addEventListener('click', copyPix);
    $('btn-comprovante').addEventListener('click', enviarComprovante);
    $('btn-novo').addEventListener('click', novoPedido);
    $('btn-novo-2').addEventListener('click', novoPedido);
    $('btn-limpar').addEventListener('click', function () {
      selected = {};
      setError('');
      updateTotal();
      renderBoard(lastStatus.vendidosLista, lastStatus.reservadosLista, []);
    });
    $('rifa-board').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.rifa-num');
      if (!btn || btn.disabled) return;
      togglePick(Number(btn.getAttribute('data-n')));
    });

    if (!configured()) {
      show('step-setup');
      return;
    }

    try {
      loadPicks();
      var status = await loadStatus();
      var local = loadLocal();
      if (local && local.id) {
        var res = await jsonp({ action: 'consultar', pedidoId: local.id });
        if (res && res.ok && res.pedido) {
          renderPedido(res.pedido, status);
          return;
        }
        clearLocal();
        show('step-form');
        await loadStatus();
        return;
      }
      show('step-form');
      updateTotal();
    } catch (err) {
      setError(err.message);
      show('step-form');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
