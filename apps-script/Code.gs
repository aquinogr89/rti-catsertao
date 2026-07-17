/**
 * Backend do Cadastro de RTI (CAT Sertão) — Google Apps Script.
 * Implante como Web App (Executar como: Eu / Quem tem acesso: Qualquer pessoa)
 * e cole a URL /exec gerada em SHEETS_API_URL (rti-catsertao/app.js) e em
 * APPS_SCRIPT_URL (catsertao/index.html) — os dois sites usam o MESMO backend.
 *
 * Autenticação, usuários e auditoria estão em Auth.gs, no mesmo projeto.
 */

var RTI_SHEET_NAME = 'RTI';
var RTI_HEADERS = [
  'timestamp', 'lat', 'lng', 'nome', 'capacidade_litros',
  'hidrante_fachada', 'hidrante_recalque', 'endereco',
  'possui_avcb', 'data_validade_avcb', 'quantidade_pavimentos',
  'area_construida', 'altura_edificacao', 'cadastrado_por'
];

function rtiSheet_() {
  var sheet = ensureSheet_(RTI_SHEET_NAME, RTI_HEADERS);
  // Migração: planilhas criadas antes de alguma dessas colunas ganham a(s)
  // coluna(s) que faltarem automaticamente, sem afetar os dados já existentes.
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  RTI_HEADERS.forEach(function (h) {
    if (headers.indexOf(h) === -1) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(h);
      headers.push(h);
    }
  });
  return sheet;
}

// Datas gravadas como texto (ex.: "2026-12-31") às vezes são convertidas
// automaticamente pelo Google Sheets em células do tipo Date. Normaliza de
// volta para 'YYYY-MM-DD' antes de responder, já que o front-end compara
// essa data como texto.
function normalizarDataCelula_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'GMT-3', 'yyyy-MM-dd');
  }
  return value;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// O mapa é público: qualquer pessoa pode consultar os pontos de RTI, sem login.
// "cadastrado_por" não entra na resposta pública — é um dado interno (ver LOG).
function doGet(e) {
  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var points = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var point = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c] === 'cadastrado_por') continue;
      point[headers[c]] = headers[c] === 'data_validade_avcb' ? normalizarDataCelula_(row[c]) : row[c];
    }
    points.push(point);
  }

  return jsonResponse_({ ok: true, points: points });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'JSON inválido.' });
  }

  switch (body.action) {
    case 'login': return jsonResponse_(handleLogin_(body));
    case 'logout': return jsonResponse_(handleLogout_(body));
    case 'validarToken': return jsonResponse_(handleValidarToken_(body));
    case 'listarUsuarios': return jsonResponse_(handleListarUsuarios_(body));
    case 'criarUsuario': return jsonResponse_(handleCriarUsuario_(body));
    case 'desativarUsuario': return jsonResponse_(handleDesativarUsuario_(body));
    case 'reativarUsuario': return jsonResponse_(handleReativarUsuario_(body));
    case 'excluirUsuario': return jsonResponse_(handleExcluirUsuario_(body));
    case 'alterarSenha': return jsonResponse_(handleAlterarSenha_(body));
    case 'obterTermo': return jsonResponse_(handleObterTermo_(body));
    case 'listarLog': return jsonResponse_(handleListarLog_(body));
    case 'cadastrarRTI': return jsonResponse_(handleCadastrarRTI_(body));
    default: return jsonResponse_({ ok: false, error: 'Ação inválida.' });
  }
}

function handleCadastrarRTI_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin', 'user1']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var nome = String(body.nome || '').trim();
  var capacidade = Number(body.capacidade_litros);

  if (!nome || isNaN(lat) || isNaN(lng) || isNaN(capacidade)) {
    return { ok: false, error: 'Campos obrigatórios ausentes ou inválidos.' };
  }

  var possuiAvcb = body.possui_avcb === 'SIM';
  var dataValidadeAvcb = String(body.data_validade_avcb || '').trim();
  if (possuiAvcb && !/^\d{4}-\d{2}-\d{2}$/.test(dataValidadeAvcb)) {
    return { ok: false, error: 'Informe a data de validade do AVCB (formato inválido).' };
  }

  var pavimentos = body.quantidade_pavimentos === '' || body.quantidade_pavimentos == null
    ? '' : Number(body.quantidade_pavimentos);
  if (pavimentos !== '' && (isNaN(pavimentos) || pavimentos < 1)) {
    return { ok: false, error: 'Quantidade de pavimentos inválida.' };
  }

  var area = body.area_construida === '' || body.area_construida == null
    ? '' : Number(body.area_construida);
  if (area !== '' && (isNaN(area) || area < 0)) {
    return { ok: false, error: 'Área construída inválida.' };
  }

  var altura = body.altura_edificacao === '' || body.altura_edificacao == null
    ? '' : Number(body.altura_edificacao);
  if (altura !== '' && (isNaN(altura) || altura < 0)) {
    return { ok: false, error: 'Altura da edificação inválida.' };
  }

  rtiSheet_().appendRow([
    body.timestamp || new Date().toISOString(),
    lat,
    lng,
    nome,
    capacidade,
    body.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
    body.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
    body.endereco || '',
    possuiAvcb ? 'SIM' : 'NAO',
    possuiAvcb ? dataValidadeAvcb : '',
    pavimentos,
    area,
    altura,
    sessao.login
  ]);

  registrarLog_(sessao.login, sessao.perfil, 'cadastro_rti', nome + ' (' + capacidade + ' L)');
  return { ok: true };
}
