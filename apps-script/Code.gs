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
  'hidrante_fachada', 'hidrante_recalque', 'endereco', 'cadastrado_por'
];

function rtiSheet_() {
  var sheet = ensureSheet_(RTI_SHEET_NAME, RTI_HEADERS);
  // Migração: plantilhas criadas antes da coluna "cadastrado_por" ganham a
  // coluna automaticamente, sem afetar os dados já existentes.
  var headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  var headers = headerRange.getValues()[0];
  if (headers.indexOf('cadastrado_por') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('cadastrado_por');
  }
  return sheet;
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
      point[headers[c]] = row[c];
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

  rtiSheet_().appendRow([
    body.timestamp || new Date().toISOString(),
    lat,
    lng,
    nome,
    capacidade,
    body.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
    body.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
    body.endereco || '',
    sessao.login
  ]);

  registrarLog_(sessao.login, sessao.perfil, 'cadastro_rti', nome + ' (' + capacidade + ' L)');
  return { ok: true };
}
