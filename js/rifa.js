(function () {
  var cfg = window.RIFA_CONFIG || {};
  var SCRIPT_URL = (cfg.SCRIPT_URL || '').trim();
  var PRECO = cfg.PRECO || 20;
  var MAX = cfg.MAX_POR_PEDIDO || 20;
  var STORAGE_KEY = 'rifaPedidoAtual';
  var qrcode = null;
  var pollTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function money(n) {
    return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
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
    for (var i = 0; i < 16; i++) {
      await sleep(700);
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

  function clearLocal() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function updateTotal() {
    var q = parseInt($('quantidade').value, 10) || 0;
    $('total-valor').textContent = money(q * PRECO);
  }

  function renderBoard(vendidos, meus) {
    var board = $('rifa-board');
    if (!board) return;
    var sold = {};
    (vendidos || []).forEach(function (n) { sold[n] = true; });
    var mine = {};
    (meus || []).forEach(function (n) { mine[n] = true; });
    var html = '';
    for (var n = 1; n <= 500; n++) {
      var cls = 'rifa-num';
      if (mine[n]) cls += ' is-mine';
      else if (sold[n]) cls += ' is-sold';
      html += '<span class="' + cls + '">' + n + '</span>';
    }
    board.innerHTML = html;
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

  function renderPedido(pedido, statusInfo) {
    if (!pedido) return;
    saveLocal(pedido);
    $('pedido-id').textContent = pedido.id;
    $('pedido-valor').textContent = money(pedido.valor);
    $('pedido-status').textContent = statusLabel(pedido.status);
    $('pix-copia').value = pedido.pixPayload || '';

    if (pedido.status === 'pago') {
      $('numeros-finais').textContent = pedido.numerosTexto || pedido.numeros.join(', ');
      show('step-done');
      renderBoard(statusInfo && statusInfo.vendidosLista, pedido.numeros);
      stopPoll();
      return;
    }
    if (pedido.status === 'aguardando_aprovacao') {
      show('step-wait');
      startPoll(pedido.id);
      return;
    }
    if (pedido.status === 'expirado' || pedido.status === 'cancelado') {
      setError(statusLabel(pedido.status));
      clearLocal();
      show('step-form');
      stopPoll();
      return;
    }
    show('step-pay');
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
          if (res.pedido.status !== 'pendente') renderPedido(res.pedido);
        }
      }).catch(function () {});
    }, 8000);
  }

  async function loadStatus() {
    var res = await jsonp({ action: 'status' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Falha ao carregar a rifa.');
    PRECO = res.preco || PRECO;
    MAX = res.maxPorPedido || MAX;
    $('quantidade').max = MAX;
    $('stat-vendidos').textContent = res.vendidos;
    $('stat-disponiveis').textContent = res.disponiveis;
    $('stat-preco').textContent = money(PRECO);
    renderBoard(res.vendidosLista, []);
    return res;
  }

  async function criarPedido(ev) {
    ev.preventDefault();
    setError('');
    var nome = $('nome').value.trim();
    var quantidade = parseInt($('quantidade').value, 10);
    if (nome.length < 2) return setError('Informe seu nome.');
    if (!quantidade || quantidade < 1) return setError('Informe a quantidade.');
    $('btn-gerar').disabled = true;
    $('btn-gerar').textContent = 'Reservando números...';
    try {
      var requestId = uuid();
      var res = await postAndWait(
        { action: 'criarPedido', nome: nome, quantidade: quantidade, requestId: requestId },
        function () { return jsonp({ action: 'consultarRequest', requestId: requestId }); }
      );
      if (!res.ok || !res.pedido) throw new Error((res && res.error) || 'Não deu para reservar.');
      renderPedido(res.pedido);
    } catch (err) {
      setError(err.message || 'Erro ao criar pedido.');
    } finally {
      $('btn-gerar').disabled = false;
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
          var max = 1200;
          var w = img.width;
          var h = img.height;
          if (w > max) {
            h = Math.round(h * max / w);
            w = max;
          }
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
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
        function () { return jsonp({ action: 'consultar', pedidoId: local.id }); }
      );
      if (!res.ok || !res.pedido) throw new Error((res && res.error) || 'Falha ao enviar.');
      renderPedido(res.pedido);
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
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.value).then(function () { ok = true; }).catch(function () {});
    }
    $('btn-copiar').textContent = 'Copiado!';
    setTimeout(function () { $('btn-copiar').textContent = 'Copiar código PIX'; }, 2000);
  }

  function novoPedido() {
    clearLocal();
    stopPoll();
    setError('');
    show('step-form');
    loadStatus().catch(function () {});
  }

  async function init() {
    $('quantidade').addEventListener('input', updateTotal);
    $('form-rifa').addEventListener('submit', criarPedido);
    $('btn-copiar').addEventListener('click', copyPix);
    $('btn-comprovante').addEventListener('click', enviarComprovante);
    $('btn-novo').addEventListener('click', novoPedido);
    $('btn-novo-2').addEventListener('click', novoPedido);
    updateTotal();

    if (!configured()) {
      show('step-setup');
      return;
    }

    try {
      var status = await loadStatus();
      var local = loadLocal();
      if (local && local.id) {
        var res = await jsonp({ action: 'consultar', pedidoId: local.id });
        if (res && res.ok && res.pedido) {
          renderPedido(res.pedido, status);
          return;
        }
        clearLocal();
      }
      show('step-form');
    } catch (err) {
      setError(err.message);
      show('step-form');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
