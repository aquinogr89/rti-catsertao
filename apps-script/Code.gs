/**
 * Backend do Mapa de SCI (CAT Sertão) — Google Apps Script.
 * Implante como Web App (Executar como: Eu / Quem tem acesso: Qualquer pessoa)
 * e cole a URL /exec gerada em SHEETS_API_URL (sci-catsertao/app.js) e em
 * APPS_SCRIPT_URL (catsertao/index.html) — os dois sites usam o MESMO backend.
 *
 * Autenticação, usuários e auditoria estão em Auth.gs, no mesmo projeto.
 */

var RTI_SHEET_NAME = 'RTI';
var RTI_HEADERS = [
  'timestamp', 'lat', 'lng', 'nome', 'capacidade_litros',
  'hidrante_fachada', 'hidrante_recalque', 'endereco',
  'possui_avcb', 'data_validade_avcb', 'quantidade_pavimentos',
  'area_construida', 'altura_edificacao', 'cadastrado_por',
  // Adicionados para permitir edição (id) e endereço estruturado (rua/número/
  // bairro/cidade), obrigatórios a partir desta versão. Ficam no final da
  // lista de propósito: rtiSheet_() só ADICIONA colunas que faltam, sempre no
  // final da planilha já existente — nunca reordena as colunas atuais.
  'id', 'rua', 'numero', 'bairro', 'cidade',
  // Campo Caldeira: mesmo padrão dos anteriores, adicionado no final para
  // não reordenar planilhas já em produção.
  'possui_caldeira'
];

// Quem pode cadastrar/listar RTI. Editar é mais restrito (ver handleEditarRTI_).
var RTI_PERFIS_CADASTRO = ['admin_master', 'admin', 'user1'];
var RTI_PERFIS_EDICAO = ['admin_master', 'admin'];

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

  // Backfill de "id": linhas cadastradas antes dessa coluna existir ficam sem
  // valor. Preenche com um UUID novo na primeira vez que a planilha é aberta
  // depois dessa atualização, para que toda linha tenha um identificador
  // estável usável por handleEditarRTI_.
  var idCol = headers.indexOf('id') + 1;
  var lastRow = sheet.getLastRow();
  if (idCol > 0 && lastRow > 1) {
    var idRange = sheet.getRange(2, idCol, lastRow - 1, 1);
    var idValues = idRange.getValues();
    var mudou = false;
    for (var i = 0; i < idValues.length; i++) {
      if (!idValues[i][0]) {
        idValues[i][0] = Utilities.getUuid();
        mudou = true;
      }
    }
    if (mudou) idRange.setValues(idValues);
  }

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
// "cadastrado_por" não entra na resposta pública — é um dado interno (ver LOG
// e handleListarRTIs_, que exige sessão). "id" é incluído: é só um
// identificador opaco, necessário no front-end para o botão de editar que
// aparece no popup do marcador para admin_master/admin.
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
    case 'listarRTIs': return jsonResponse_(handleListarRTIs_(body));
    case 'editarRTI': return jsonResponse_(handleEditarRTI_(body));
    default: return jsonResponse_({ ok: false, error: 'Ação inválida.' });
  }
}

// Validação compartilhada por handleCadastrarRTI_ e handleEditarRTI_. Retorna
// os dados já normalizados/prontos para gravar, ou { erro: '...' }.
function validarDadosRTI_(body) {
  var lat = Number(body.lat);
  var lng = Number(body.lng);
  var nome = String(body.nome || '').trim();
  var capacidade = Number(body.capacidade_litros);

  if (!nome || isNaN(lat) || isNaN(lng) || isNaN(capacidade)) {
    return { erro: 'Campos obrigatórios ausentes ou inválidos.' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { erro: 'Coordenadas inválidas.' };
  }
  if (capacidade <= 0) {
    return { erro: 'Informe a capacidade da RTI em litros.' };
  }

  // Endereço estruturado, obrigatório desde esta versão (tanto para cadastro
  // via GPS do vistoriador quanto para cadastro/edição manual do admin).
  // "numero" aceita explicitamente "NI" (Não Informado) quando não existir
  // numeração no local.
  var rua = String(body.rua || '').trim();
  var numero = String(body.numero || '').trim();
  var bairro = String(body.bairro || '').trim();
  var cidade = String(body.cidade || '').trim();
  if (!rua || !numero || !bairro || !cidade) {
    return { erro: 'Informe rua, número (ou "NI"), bairro e cidade.' };
  }

  var possuiAvcb = body.possui_avcb === 'SIM';
  var dataValidadeAvcb = String(body.data_validade_avcb || '').trim();
  if (possuiAvcb && !/^\d{4}-\d{2}-\d{2}$/.test(dataValidadeAvcb)) {
    return { erro: 'Informe a data de validade do AVCB (formato inválido).' };
  }

  var pavimentos = body.quantidade_pavimentos === '' || body.quantidade_pavimentos == null
    ? '' : Number(body.quantidade_pavimentos);
  if (pavimentos !== '' && (isNaN(pavimentos) || pavimentos < 1)) {
    return { erro: 'Quantidade de pavimentos inválida.' };
  }

  var area = body.area_construida === '' || body.area_construida == null
    ? '' : Number(body.area_construida);
  if (area !== '' && (isNaN(area) || area < 0)) {
    return { erro: 'Área construída inválida.' };
  }

  var altura = body.altura_edificacao === '' || body.altura_edificacao == null
    ? '' : Number(body.altura_edificacao);
  if (altura !== '' && (isNaN(altura) || altura < 0)) {
    return { erro: 'Altura da edificação inválida.' };
  }

  return {
    lat: lat, lng: lng, nome: nome, capacidade: capacidade,
    hidranteFachada: body.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
    hidranteRecalque: body.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
    possuiCaldeira: body.possui_caldeira === 'SIM' ? 'SIM' : 'NAO',
    rua: rua, numero: numero, bairro: bairro, cidade: cidade,
    endereco: rua + ', ' + numero + ' - ' + bairro + ', ' + cidade,
    possuiAvcb: possuiAvcb ? 'SIM' : 'NAO',
    dataValidadeAvcb: possuiAvcb ? dataValidadeAvcb : '',
    pavimentos: pavimentos, area: area, altura: altura
  };
}

function handleCadastrarRTI_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_CADASTRO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var d = validarDadosRTI_(body);
  if (d.erro) return { ok: false, error: d.erro };

  var id = Utilities.getUuid();
  rtiSheet_().appendRow([
    body.timestamp || new Date().toISOString(),
    d.lat, d.lng, d.nome, d.capacidade,
    d.hidranteFachada, d.hidranteRecalque, d.endereco,
    d.possuiAvcb, d.dataValidadeAvcb, d.pavimentos, d.area, d.altura,
    sessao.login,
    id, d.rua, d.numero, d.bairro, d.cidade,
    d.possuiCaldeira
  ]);

  registrarLog_(sessao.login, sessao.perfil, 'cadastro_rti', d.nome + ' (' + d.capacidade + ' L)');
  return { ok: true, id: id };
}

// Lista todos os SCIs cadastrados, incluindo quem cadastrou cada um — ao
// contrário do doGet (mapa público), que omite "cadastrado_por". Mesmos
// perfis que podem cadastrar (admin_master, admin, user1) podem consultar
// essa listagem; a edição em si é restrita a admin_master/admin (ver abaixo).
function handleListarRTIs_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_CADASTRO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var pontos = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var point = {};
    for (var c = 0; c < headers.length; c++) {
      point[headers[c]] = headers[c] === 'data_validade_avcb' ? normalizarDataCelula_(row[c]) : row[c];
    }
    pontos.push(point);
  }

  return { ok: true, points: pontos };
}

function encontrarLinhaRTIPorId_(id) {
  var sheet = rtiSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('id');
  if (idCol === -1) return null;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === id) {
      var valores = {};
      headers.forEach(function (h, c) { valores[h] = values[i][c]; });
      return { linha: i + 1, headers: headers, valores: valores };
    }
  }
  return null;
}

// Edição só para admin_master/admin (Reunião com o pedido original: o
// vistoriador — user1 — só cadastra, nunca edita). Preserva "timestamp"
// (data do cadastro original) e "cadastrado_por" (quem cadastrou de fato) —
// a edição não reescreve a autoria, só os dados do ponto. Loga separadamente
// quem editou, em qual RTI, sem apagar o rastro de quem criou.
function handleEditarRTI_(body) {
  var sessao = exigirSessao_(body.token, RTI_PERFIS_EDICAO);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'RTI não identificado.' };

  var achado = encontrarLinhaRTIPorId_(id);
  if (!achado) return { ok: false, error: 'RTI não encontrado.' };

  var d = validarDadosRTI_(body);
  if (d.erro) return { ok: false, error: d.erro };

  var novaLinha = achado.headers.map(function (h) {
    switch (h) {
      case 'id': return id;
      case 'timestamp': return achado.valores.timestamp;
      case 'lat': return d.lat;
      case 'lng': return d.lng;
      case 'nome': return d.nome;
      case 'capacidade_litros': return d.capacidade;
      case 'hidrante_fachada': return d.hidranteFachada;
      case 'hidrante_recalque': return d.hidranteRecalque;
      case 'endereco': return d.endereco;
      case 'rua': return d.rua;
      case 'numero': return d.numero;
      case 'bairro': return d.bairro;
      case 'cidade': return d.cidade;
      case 'possui_caldeira': return d.possuiCaldeira;
      case 'possui_avcb': return d.possuiAvcb;
      case 'data_validade_avcb': return d.dataValidadeAvcb;
      case 'quantidade_pavimentos': return d.pavimentos;
      case 'area_construida': return d.area;
      case 'altura_edificacao': return d.altura;
      case 'cadastrado_por': return achado.valores.cadastrado_por;
      default: return achado.valores[h];
    }
  });

  rtiSheet_().getRange(achado.linha, 1, 1, achado.headers.length).setValues([novaLinha]);

  registrarLog_(sessao.login, sessao.perfil, 'edicao_rti', 'editou "' + d.nome + '" (id ' + id + ')');
  return { ok: true };
}
