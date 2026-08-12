/**
 * Rifa Raquel & Tom — cole este arquivo no Apps Script da planilha.
 *
 * 1. Crie uma planilha Google nova (ex.: "Rifa Casamento").
 * 2. Extensões > Apps Script. Apague o código padrão. Cole este arquivo.
 * 3. Troque ADMIN_SENHA abaixo.
 * 4. Salve. No editor, escolha setupRifa e clique em Executar. Autorize.
 * 5. Implantar > Nova implantação > Tipo: App da Web.
 *    - Executar como: Eu
 *    - Quem tem acesso: Qualquer pessoa
 * 6. Copie a URL e cole em js/rifa-config.js (SCRIPT_URL).
 */

var CONFIG = {
  PRECO: 20,
  TOTAL_NUMEROS: 500,
  MAX_POR_PEDIDO: 20,
  RESERVA_MINUTOS: 30,
  PIX_CHAVE: '+5562999433035',
  PIX_NOME: 'RAQUEL E TOM',
  PIX_CIDADE: 'SAO PAULO',
  ADMIN_SENHA: 'troque-esta-senha',
  SPREADSHEET_ID: '1NBA3DBsZTyXVqUqsgbMcs8DB4VydK1OMMqewypaq0qs'
};

function getSpreadsheet() {
  if (CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

var SHEET_NUMEROS = 'numeros';
var SHEET_PEDIDOS = 'pedidos';
var SHEET_RESPOSTAS = 'respostas';
var FOLDER_NAME = 'Rifa Comprovantes';

function setupRifa() {
  var ss = getSpreadsheet();
  var numeros = ss.getSheetByName(SHEET_NUMEROS);
  if (!numeros) {
    numeros = ss.insertSheet(SHEET_NUMEROS);
  }
  numeros.clear();
  numeros.getRange(1, 1, 1, 5).setValues([['numero', 'status', 'pedido_id', 'nome', 'reservado_ate']]);
  var rows = [];
  for (var n = 1; n <= CONFIG.TOTAL_NUMEROS; n++) {
    rows.push([n, 'disponivel', '', '', '']);
  }
  numeros.getRange(2, 1, rows.length, 5).setValues(rows);
  numeros.setFrozenRows(1);

  var pedidos = ss.getSheetByName(SHEET_PEDIDOS);
  if (!pedidos) {
    pedidos = ss.insertSheet(SHEET_PEDIDOS);
  }
  pedidos.clear();
  pedidos.getRange(1, 1, 1, 11).setValues([[
    'id', 'request_id', 'nome', 'quantidade', 'valor_total', 'numeros',
    'status', 'comprovante_url', 'criado_em', 'pago_em', 'pix_payload'
  ]]);
  pedidos.setFrozenRows(1);

  var respostas = ss.getSheetByName(SHEET_RESPOSTAS);
  if (!respostas) {
    respostas = ss.insertSheet(SHEET_RESPOSTAS);
  }
  respostas.clear();
  respostas.getRange(1, 1, 1, 3).setValues([['request_id', 'json', 'criado_em']]);
  respostas.setFrozenRows(1);

  var extra = ss.getSheetByName('Sheet1');
  if (extra && ss.getSheets().length > 3) {
    ss.deleteSheet(extra);
  }
}

function doGet(e) {
  var result = dispatch(e.parameter || {}, 'GET');
  var output = JSON.stringify(result);
  var callback = e.parameter && e.parameter.callback;
  if (callback && /^[A-Za-z_][A-Za-z0-9_]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + output + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(output)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var payload = {};
  try {
    payload = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    payload = {};
  }
  var result = dispatch(payload, 'POST');
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatch(data, method) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return { ok: false, error: 'Sistema ocupado. Tente de novo em alguns segundos.' };
  }
  try {
    ensureSheets();
    expireReservas();
    var action = String(data.action || '');
    if (action === 'status') return actionStatus();
    if (action === 'criarPedido') return actionCriarPedido(data);
    if (action === 'consultar') return actionConsultar(data.pedidoId);
    if (action === 'consultarRequest') return actionConsultarRequest(data.requestId);
    if (action === 'enviarComprovante') return actionEnviarComprovante(data);
    if (action === 'adminListar') return actionAdminListar(data.senha);
    if (action === 'adminAprovar') return actionAdminAprovar(data);
    if (action === 'adminRecusar') return actionAdminRecusar(data);
    return { ok: false, error: 'Ação inválida.' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function ensureSheets() {
  var ss = getSpreadsheet();
  if (!ss.getSheetByName(SHEET_NUMEROS) || !ss.getSheetByName(SHEET_PEDIDOS) || !ss.getSheetByName(SHEET_RESPOSTAS)) {
    if (!ss.getSheetByName(SHEET_NUMEROS) || !ss.getSheetByName(SHEET_PEDIDOS)) {
      setupRifa();
      return;
    }
    var respostas = ss.insertSheet(SHEET_RESPOSTAS);
    respostas.getRange(1, 1, 1, 3).setValues([['request_id', 'json', 'criado_em']]);
    respostas.setFrozenRows(1);
  }
}

function getSheets() {
  var ss = getSpreadsheet();
  return {
    numeros: ss.getSheetByName(SHEET_NUMEROS),
    pedidos: ss.getSheetByName(SHEET_PEDIDOS)
  };
}

function expireReservas() {
  var sheets = getSheets();
  var now = new Date();
  var numData = sheets.numeros.getDataRange().getValues();
  var pedData = sheets.pedidos.getDataRange().getValues();
  var expiredIds = {};
  var i;

  for (i = 1; i < numData.length; i++) {
    if (numData[i][1] === 'reservado' && numData[i][4]) {
      var until = new Date(numData[i][4]);
      if (until < now) {
        expiredIds[String(numData[i][2])] = true;
        sheets.numeros.getRange(i + 1, 2, 1, 4).setValues([['disponivel', '', '', '']]);
      }
    }
  }

  for (i = 1; i < pedData.length; i++) {
    var status = pedData[i][6];
    var id = String(pedData[i][0]);
    if (expiredIds[id] && (status === 'pendente' || status === 'aguardando_aprovacao')) {
      sheets.pedidos.getRange(i + 1, 7).setValue('expirado');
    }
  }
}

function actionStatus() {
  var sheets = getSheets();
  var numData = sheets.numeros.getDataRange().getValues();
  var vendidos = 0;
  var reservados = 0;
  var disponiveis = 0;
  var vendidosLista = [];
  for (var i = 1; i < numData.length; i++) {
    var status = numData[i][1];
    var numero = Number(numData[i][0]);
    if (status === 'vendido') {
      vendidos++;
      vendidosLista.push(numero);
    } else if (status === 'reservado') {
      reservados++;
    } else {
      disponiveis++;
    }
  }
  return {
    ok: true,
    preco: CONFIG.PRECO,
    total: CONFIG.TOTAL_NUMEROS,
    maxPorPedido: CONFIG.MAX_POR_PEDIDO,
    reservaMinutos: CONFIG.RESERVA_MINUTOS,
    vendidos: vendidos,
    reservados: reservados,
    disponiveis: disponiveis,
    vendidosLista: vendidosLista
  };
}

function actionCriarPedido(data) {
  var nome = String(data.nome || '').trim();
  var quantidade = parseInt(data.quantidade, 10);
  var requestId = String(data.requestId || '').trim();

  if (nome.length < 2) return saveResposta_(requestId, { ok: false, error: 'Informe seu nome.' });
  if (!quantidade || quantidade < 1) return saveResposta_(requestId, { ok: false, error: 'Informe quantos números quer.' });
  if (quantidade > CONFIG.MAX_POR_PEDIDO) {
    return saveResposta_(requestId, { ok: false, error: 'Máximo de ' + CONFIG.MAX_POR_PEDIDO + ' números por vez.' });
  }
  if (!requestId) return { ok: false, error: 'Pedido inválido. Recarregue a página.' };

  var existing = findPedidoByRequestId(requestId);
  if (existing) return { ok: true, pedido: publicPedido_(existing) };
  var cached = readResposta_(requestId);
  if (cached) return cached;

  var picked = pickAvailableNumbers(quantidade);
  if (!picked) {
    return saveResposta_(requestId, { ok: false, error: 'Não há números suficientes disponíveis.' });
  }

  var pedidoId = Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
  var valor = quantidade * CONFIG.PRECO;
  var txid = ('RIFA' + pedidoId).substring(0, 25);
  var pix = buildPixPayload(CONFIG.PIX_CHAVE, CONFIG.PIX_NOME, CONFIG.PIX_CIDADE, valor, txid);
  var agora = new Date();
  var ate = new Date(agora.getTime() + CONFIG.RESERVA_MINUTOS * 60 * 1000);
  var numerosStr = picked.numeros.join(', ');

  var sheets = getSheets();
  for (var i = 0; i < picked.rows.length; i++) {
    var row = picked.rows[i];
    sheets.numeros.getRange(row, 2, 1, 4).setValues([['reservado', pedidoId, nome, ate]]);
  }

  sheets.pedidos.appendRow([
    pedidoId,
    requestId,
    nome,
    quantidade,
    valor,
    numerosStr,
    'pendente',
    '',
    agora,
    '',
    pix
  ]);

  var result = { ok: true, pedido: publicPedido_(formatPedido_(pedidoId, requestId, nome, quantidade, valor, numerosStr, 'pendente', '', agora, '', pix, ate)) };
  return saveResposta_(requestId, result);
}

function pickAvailableNumbers(quantidade) {
  var sheets = getSheets();
  var data = sheets.numeros.getDataRange().getValues();
  var available = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === 'disponivel') {
      available.push({ row: i + 1, numero: Number(data[i][0]) });
    }
  }
  if (available.length < quantidade) return null;
  for (var j = available.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var tmp = available[j];
    available[j] = available[k];
    available[k] = tmp;
  }
  var chosen = available.slice(0, quantidade);
  chosen.sort(function (a, b) { return a.numero - b.numero; });
  return {
    numeros: chosen.map(function (c) { return c.numero; }),
    rows: chosen.map(function (c) { return c.row; })
  };
}

function actionConsultar(pedidoId) {
  var pedido = findPedidoById(String(pedidoId || ''));
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  return { ok: true, pedido: publicPedido_(pedido) };
}

function actionConsultarRequest(requestId) {
  var pedido = findPedidoByRequestId(String(requestId || ''));
  if (pedido) return { ok: true, pedido: publicPedido_(pedido) };
  var cached = readResposta_(String(requestId || ''));
  if (cached) {
    if (cached.pedido) cached.pedido = publicPedido_(cached.pedido);
    return cached;
  }
  return { ok: true, pending: true };
}

function saveResposta_(requestId, result) {
  if (!requestId) return result;
  var sh = getSpreadsheet().getSheetByName(SHEET_RESPOSTAS);
  if (!sh) return result;
  sh.appendRow([requestId, JSON.stringify(result), new Date()]);
  return result;
}

function readResposta_(requestId) {
  if (!requestId) return null;
  var sh = getSpreadsheet().getSheetByName(SHEET_RESPOSTAS);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === requestId) {
      try { return JSON.parse(data[i][1]); } catch (err) { return null; }
    }
  }
  return null;
}

function actionEnviarComprovante(data) {
  var pedidoId = String(data.pedidoId || '');
  var dataUrl = String(data.comprovante || '');
  var sheets = getSheets();
  var found = findPedidoRow_(pedidoId);
  if (!found) return { ok: false, error: 'Pedido não encontrado.' };
  if (found.status === 'pago') return { ok: false, error: 'Este pedido já foi confirmado.' };
  if (found.status === 'expirado' || found.status === 'cancelado') {
    return { ok: false, error: 'Este pedido expirou. Faça um novo.' };
  }
  if (!dataUrl || dataUrl.indexOf('base64,') === -1) {
    return { ok: false, error: 'Envie a foto do comprovante.' };
  }

  var url = saveComprovante_(pedidoId, dataUrl);
  sheets.pedidos.getRange(found.row, 8).setValue(url);
  sheets.pedidos.getRange(found.row, 7).setValue('aguardando_aprovacao');
  var pedido = findPedidoById(pedidoId);
  return { ok: true, pedido: publicPedido_(pedido) };
}

function saveComprovante_(pedidoId, dataUrl) {
  var parts = dataUrl.split('base64,');
  var mime = 'image/jpeg';
  var header = parts[0] || '';
  if (header.indexOf('image/png') !== -1) mime = 'image/png';
  if (header.indexOf('image/webp') !== -1) mime = 'image/webp';
  var blob = Utilities.newBlob(Utilities.base64Decode(parts[1]), mime, 'comprovante-' + pedidoId + '.jpg');
  var folder = getComprovantesFolder_();
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function getComprovantesFolder_() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function requireAdmin_(senha) {
  if (!senha || senha !== CONFIG.ADMIN_SENHA) {
    throw new Error('Senha incorreta.');
  }
}

function actionAdminListar(senha) {
  requireAdmin_(senha);
  var sheets = getSheets();
  var data = sheets.pedidos.getDataRange().getValues();
  var pedidos = [];
  for (var i = 1; i < data.length; i++) {
    pedidos.push(rowToPedido_(data[i]));
  }
  pedidos.reverse();
  var status = actionStatus();
  return { ok: true, pedidos: pedidos, resumo: status };
}

function actionAdminAprovar(data) {
  requireAdmin_(data.senha);
  var pedidoId = String(data.pedidoId || '');
  var found = findPedidoRow_(pedidoId);
  if (!found) return { ok: false, error: 'Pedido não encontrado.' };
  if (found.status === 'pago') return { ok: true, pedido: findPedidoById(pedidoId) };
  if (found.status === 'expirado' || found.status === 'cancelado') {
    return { ok: false, error: 'Não dá para aprovar um pedido expirado ou cancelado.' };
  }

  var sheets = getSheets();
  var numData = sheets.numeros.getDataRange().getValues();
  for (var i = 1; i < numData.length; i++) {
    if (String(numData[i][2]) === pedidoId) {
      sheets.numeros.getRange(i + 1, 2).setValue('vendido');
      sheets.numeros.getRange(i + 1, 5).setValue('');
    }
  }
  sheets.pedidos.getRange(found.row, 7).setValue('pago');
  sheets.pedidos.getRange(found.row, 10).setValue(new Date());
  return { ok: true, pedido: findPedidoById(pedidoId) };
}

function actionAdminRecusar(data) {
  requireAdmin_(data.senha);
  var pedidoId = String(data.pedidoId || '');
  var found = findPedidoRow_(pedidoId);
  if (!found) return { ok: false, error: 'Pedido não encontrado.' };
  if (found.status === 'pago') return { ok: false, error: 'Pedido já pago. Não recuse por aqui.' };

  var sheets = getSheets();
  var numData = sheets.numeros.getDataRange().getValues();
  for (var i = 1; i < numData.length; i++) {
    if (String(numData[i][2]) === pedidoId) {
      sheets.numeros.getRange(i + 1, 2, 1, 4).setValues([['disponivel', '', '', '']]);
    }
  }
  sheets.pedidos.getRange(found.row, 7).setValue('cancelado');
  return { ok: true, pedido: findPedidoById(pedidoId) };
}

function findPedidoRow_(pedidoId) {
  if (!pedidoId) return null;
  var data = getSheets().pedidos.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === pedidoId) {
      return { row: i + 1, status: String(data[i][6]) };
    }
  }
  return null;
}

function findPedidoById(pedidoId) {
  if (!pedidoId) return null;
  var data = getSheets().pedidos.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === pedidoId) return rowToPedido_(data[i]);
  }
  return null;
}

function findPedidoByRequestId(requestId) {
  if (!requestId) return null;
  var data = getSheets().pedidos.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) === requestId) return rowToPedido_(data[i]);
  }
  return null;
}

function rowToPedido_(row) {
  var ate = null;
  if (row[6] === 'pendente' || row[6] === 'aguardando_aprovacao') {
    ate = new Date(new Date(row[8]).getTime() + CONFIG.RESERVA_MINUTOS * 60 * 1000);
  }
  return formatPedido_(
    String(row[0]),
    String(row[1]),
    String(row[2]),
    Number(row[3]),
    Number(row[4]),
    String(row[5]),
    String(row[6]),
    String(row[7] || ''),
    row[8],
    row[9],
    String(row[10] || ''),
    ate
  );
}

function formatPedido_(id, requestId, nome, quantidade, valor, numeros, status, comprovanteUrl, criadoEm, pagoEm, pix, reservadoAte) {
  var numerosArr = String(numeros || '')
    .split(',')
    .map(function (n) { return parseInt(String(n).trim(), 10); })
    .filter(function (n) { return !!n; });
  return {
    id: id,
    requestId: requestId,
    nome: nome,
    quantidade: quantidade,
    valor: valor,
    numeros: numerosArr,
    numerosTexto: numeros,
    status: status,
    comprovanteUrl: comprovanteUrl,
    criadoEm: criadoEm ? new Date(criadoEm).toISOString() : '',
    pagoEm: pagoEm ? new Date(pagoEm).toISOString() : '',
    pixPayload: pix,
    reservadoAte: reservadoAte ? new Date(reservadoAte).toISOString() : '',
    mostraNumeros: status === 'pago'
  };
}

function publicPedido_(pedido) {
  if (!pedido) return pedido;
  if (pedido.status === 'pago') return pedido;
  var copy = {};
  for (var k in pedido) {
    if (Object.prototype.hasOwnProperty.call(pedido, k)) copy[k] = pedido[k];
  }
  copy.numeros = [];
  copy.numerosTexto = '';
  copy.mostraNumeros = false;
  return copy;
}

function tlv_(id, value) {
  var len = String(value.length).padStart(2, '0');
  return id + len + value;
}

function crc16_(str) {
  var crc = 0xFFFF;
  for (var i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (var j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return ('0000' + crc.toString(16).toUpperCase()).slice(-4);
}

function buildPixPayload(chave, nome, cidade, valor, txid) {
  nome = String(nome).substring(0, 25);
  cidade = String(cidade).substring(0, 15);
  txid = String(txid || '***').substring(0, 25);
  var amount = Number(valor).toFixed(2);
  var merchant = tlv_('00', 'BR.GOV.BCB.PIX') + tlv_('01', chave);
  var additional = tlv_('05', txid);
  var payload = tlv_('00', '01')
    + tlv_('26', merchant)
    + '52040000'
    + '5303986'
    + tlv_('54', amount)
    + '5802BR'
    + tlv_('59', nome)
    + tlv_('60', cidade)
    + tlv_('62', additional)
    + '6304';
  return payload + crc16_(payload);
}
