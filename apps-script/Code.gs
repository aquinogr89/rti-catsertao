/**
 * Backend do Cadastro de RTI (CAT Sertão) — Google Apps Script.
 * Implante como Web App (Executar como: Eu / Quem tem acesso: Qualquer pessoa)
 * e cole a URL /exec gerada na constante SHEETS_API_URL do app.js.
 */

var SHEET_NAME = 'RTI';
var HEADERS = [
  'timestamp', 'lat', 'lng', 'nome', 'capacidade_litros',
  'hidrante_fachada', 'hidrante_recalque', 'endereco'
];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var points = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var point = {};
    for (var c = 0; c < headers.length; c++) {
      point[headers[c]] = row[c];
    }
    points.push(point);
  }

  return jsonResponse_({ ok: true, points: points });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var lat = Number(data.lat);
    var lng = Number(data.lng);
    var nome = String(data.nome || '').trim();
    var capacidade = Number(data.capacidade_litros);

    if (!nome || isNaN(lat) || isNaN(lng) || isNaN(capacidade)) {
      return jsonResponse_({ ok: false, error: 'Campos obrigatórios ausentes ou inválidos.' });
    }

    var sheet = getSheet_();
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      lat,
      lng,
      nome,
      capacidade,
      data.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
      data.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
      data.endereco || ''
    ]);

    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}
