(function () {
  var cfg = window.RIFA_CONFIG || {};
  var SCRIPT_URL = (cfg.SCRIPT_URL || '').trim();
  var SENHA_KEY = 'rifaAdminSenha';

  function $(id) { return document.getElementById(id); }

  function money(n) {
    return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
  }

  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = 'rifaAdm' + Date.now() + Math.floor(Math.random() * 1000);
      var timeout = setTimeout(function () {
        cleanup();
        reject(new Error('Demorou demais.'));
      }, 25000);
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
        reject(new Error('Google ainda não liberou o sistema. Abra o link abaixo com willkulminare@gmail.com, clique em Permitir, e tente de novo.'));
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

  function senha() {
    return sessionStorage.getItem(SENHA_KEY) || '';
  }

  function setMsg(text, isError) {
    var el = $('admin-msg');
    el.textContent = text || '';
    el.classList.toggle('is-hidden', !text);
    el.classList.toggle('is-error', !!isError);
  }

  function statusPt(s) {
    return {
      pendente: 'Aguardando pagamento',
      aguardando_aprovacao: 'Aguardando sua aprovação',
      pago: 'Pago',
      expirado: 'Expirado',
      cancelado: 'Cancelado'
    }[s] || s;
  }

  function drivePreview(url) {
    if (!url) return '';
    var m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w800';
    return url;
  }

  function render(res) {
    var r = res.resumo || {};
    $('resumo').innerHTML =
      '<strong>' + (r.vendidos || 0) + '</strong> vendidos · ' +
      '<strong>' + (r.reservados || 0) + '</strong> reservados · ' +
      '<strong>' + (r.disponiveis || 0) + '</strong> livres';

    var list = $('lista');
    var pedidos = res.pedidos || [];
    if (!pedidos.length) {
      list.innerHTML = '<p>Nenhum pedido ainda.</p>';
      return;
    }
    list.innerHTML = pedidos.map(function (p) {
      var actions = '';
      if (p.status === 'aguardando_aprovacao' || p.status === 'pendente') {
        actions =
          '<button class="btn btn-primary btn-sm" data-act="aprovar" data-id="' + p.id + '">Aprovar</button> ' +
          '<button class="btn btn-outline btn-sm" data-act="recusar" data-id="' + p.id + '">Recusar</button>';
      }
      var img = p.comprovanteUrl
        ? '<p><a href="' + p.comprovanteUrl + '" target="_blank" rel="noopener">Ver comprovante</a></p>' +
          '<img class="comprovante-img" alt="Comprovante" src="' + drivePreview(p.comprovanteUrl) + '">'
        : '<p class="muted">Sem comprovante</p>';
      return (
        '<article class="pedido-card status-' + p.status + '">' +
          '<header><strong>#' + p.id + '</strong> · ' + statusPt(p.status) + '</header>' +
          '<p>' + p.nome + ' · ' + p.quantidade + ' número(s) · ' + money(p.valor) + '</p>' +
          '<p>Números: ' + (p.numerosTexto || '—') + '</p>' +
          img +
          '<div class="pedido-actions">' + actions + '</div>' +
        '</article>'
      );
    }).join('');
  }

  async function carregar() {
    setMsg('Carregando...');
    var res = await jsonp({ action: 'adminListar', senha: senha() });
    if (!res.ok) throw new Error(res.error || 'Falha ao listar.');
    setMsg('');
    render(res);
  }

  async function agir(act, pedidoId) {
    setMsg(act === 'aprovar' ? 'Aprovando...' : 'Recusando...');
    await postNoCors({ action: act === 'aprovar' ? 'adminAprovar' : 'adminRecusar', senha: senha(), pedidoId: pedidoId });
    var last = null;
    for (var i = 0; i < 12; i++) {
      await sleep(700);
      last = await jsonp({ action: 'adminListar', senha: senha() });
      if (last && last.ok) {
        var p = (last.pedidos || []).filter(function (x) { return x.id === pedidoId; })[0];
        if (p && act === 'aprovar' && p.status === 'pago') {
          render(last);
          setMsg('Pedido ' + pedidoId + ' aprovado.');
          return;
        }
        if (p && act === 'recusar' && p.status === 'cancelado') {
          render(last);
          setMsg('Pedido ' + pedidoId + ' recusado. Números liberados.');
          return;
        }
      }
    }
    if (last && last.ok) render(last);
    setMsg('Atualizado. Confira o status.', false);
  }

  function init() {
    var liberar = $('link-liberar');
    if (liberar && SCRIPT_URL) {
      liberar.href = SCRIPT_URL + '?action=status';
    }
    if (!SCRIPT_URL) {
      $('login').classList.add('is-hidden');
      $('painel').classList.add('is-hidden');
      setMsg('Cole a URL do Apps Script em js/rifa-config.js', true);
      return;
    }

    $('form-login').addEventListener('submit', function (ev) {
      ev.preventDefault();
      sessionStorage.setItem(SENHA_KEY, $('senha').value);
      $('login').classList.add('is-hidden');
      $('painel').classList.remove('is-hidden');
      carregar().catch(function (err) {
        setMsg(err.message, true);
        $('login').classList.remove('is-hidden');
        $('painel').classList.add('is-hidden');
        sessionStorage.removeItem(SENHA_KEY);
      });
    });

    $('btn-atualizar').addEventListener('click', function () {
      carregar().catch(function (err) { setMsg(err.message, true); });
    });

    $('lista').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      agir(btn.getAttribute('data-act'), btn.getAttribute('data-id'))
        .catch(function (err) { setMsg(err.message, true); });
    });

    if (senha()) {
      $('login').classList.add('is-hidden');
      $('painel').classList.remove('is-hidden');
      carregar().catch(function (err) {
        setMsg(err.message, true);
        $('login').classList.remove('is-hidden');
        $('painel').classList.add('is-hidden');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
