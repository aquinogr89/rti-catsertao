/**
 * Autenticação, autorização e auditoria — CAT Sertão.
 *
 * Todas as senhas e tokens são validados aqui, no servidor. O front-end (nos
 * dois sites, publicados no GitHub Pages, portanto públicos) nunca recebe
 * nem guarda hash de senha — apenas o token de sessão, que expira sozinho.
 *
 * Perfis e o que cada um pode fazer:
 *   admin_master — tudo: cadastrar OCI, ver termo, gerenciar QUALQUER usuário
 *                  (inclusive outros admins), ver o LOG de auditoria.
 *   admin        — cadastrar OCI, ver termo, criar/desativar apenas
 *                  user1/user2 (nunca admin ou admin_master).
 *   user1        — apenas cadastrar OCI.
 *   user2        — apenas navegação básica do site (sem OCI, sem termo).
 */

var SESSAO_HORAS = 8;
var LOGIN_MAX_TENTATIVAS = 5;
var LOGIN_BLOQUEIO_MINUTOS = 15;

// Planilha de respostas do formulário "Termo de Compromisso" (n8n). É uma
// planilha diferente da planilha de dados da RTI/usuários/log.
var TERMO_SHEET_ID = '1A4IRvGccm9qdg8uwPdsEBO1VnGjXqld4fcY0TEMFhPI';
var TERMO_SHEET_NAME = '';

var PERFIS_VALIDOS = ['admin_master', 'admin', 'user1', 'user2'];

// ===================== Planilhas auxiliares =====================
function ensureSheet_(nome, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(nome);
  if (!sheet) sheet = ss.insertSheet(nome);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function sheetRowsAsObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function (row, idx) {
    var obj = { _row: idx + 2 }; // linha real na planilha (1-based, +1 pelo cabeçalho)
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

// ===================== Hash de senha =====================
function gerarSalt_() {
  return Utilities.getUuid();
}

// Milhares de rodadas de SHA-256 (mesma ideia de PBKDF2, sem depender de uma
// lib externa que o Apps Script não tem nativamente) — encarece um ataque de
// força bruta offline caso os hashes algum dia vazem. Usado para toda senha
// nova ou alterada a partir de agora.
//
// 3000 é uma estimativa conservadora: cada rodada é uma chamada a
// Utilities.computeDigest, que tem um custo fixo por chamada (não é só o
// SHA-256 em si) — não foi possível medir o tempo real de execução no Apps
// Script antes de publicar. Se o login ficar perceptivelmente lento depois
// do deploy, baixe esse número; se quiser mais margem e o login continuar
// rápido, pode subir.
var HASH_ITERACOES = 3000;

function hashSenha_(senha, salt) {
  var valor = salt + senha;
  for (var i = 0; i < HASH_ITERACOES; i++) {
    valor = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, valor));
  }
  return valor;
}

// Formato antigo (uma rodada só), anterior ao reforço acima. Mantido só para
// autenticar contas criadas antes dessa mudança — handleLogin_ tenta esse
// formato como fallback e, se bater, regrava o hash no formato novo na hora
// (autoatualização silenciosa no próximo login com a senha certa; ninguém
// precisa resetar senha por causa disso).
function hashSenhaLegado_(senha, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + senha);
  return Utilities.base64Encode(digest);
}

// ===================== Log de auditoria =====================
function registrarLog_(login, perfil, acao, detalhe) {
  var sheet = ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']);
  sheet.appendRow([new Date().toISOString(), login || '', perfil || '', acao, detalhe || '']);
}

// ===================== Sessões =====================
function criarSessao_(login, perfil) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  limparSessoesExpiradas_(sheet);
  var token = Utilities.getUuid();
  var agora = new Date();
  var expira = new Date(agora.getTime() + SESSAO_HORAS * 3600 * 1000);
  sheet.appendRow([token, login, perfil, agora.toISOString(), expira.toISOString()]);
  return token;
}

function limparSessoesExpiradas_(sheet) {
  var values = sheet.getDataRange().getValues();
  var agora = new Date();
  for (var i = values.length - 1; i >= 1; i--) {
    var expiraEm = new Date(values[i][4]);
    if (isNaN(expiraEm.getTime()) || expiraEm < agora) {
      sheet.deleteRow(i + 1);
    }
  }
}

function obterSessao_(token) {
  if (!token) return null;
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  var agora = new Date();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].token === token) {
      var expiraEm = new Date(rows[i].expira_em);
      if (isNaN(expiraEm.getTime()) || expiraEm < agora) return null;
      return { login: rows[i].login, perfil: rows[i].perfil, _row: rows[i]._row };
    }
  }
  return null;
}

function encerrarSessao_(token) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].token === token) {
      sheet.deleteRow(rows[i]._row);
      return;
    }
  }
}

// Usado ao desativar um usuário: sem isso, um token já emitido continuaria
// válido até expirar sozinho (até 8h depois), mesmo com o usuário desativado.
function encerrarSessoesDoUsuario_(login) {
  var sheet = ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  var rows = sheetRowsAsObjects_(sheet);
  var loginNorm = String(login || '').trim().toLowerCase();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].login).trim().toLowerCase() === loginNorm) {
      sheet.deleteRow(rows[i]._row);
    }
  }
}

/**
 * Exige uma sessão válida e, opcionalmente, um dos perfis em perfisPermitidos.
 * Retorna { erro: '...' } ou { login, perfil }.
 */
function exigirSessao_(token, perfisPermitidos) {
  var sessao = obterSessao_(token);
  if (!sessao) return { erro: 'Sessão inválida ou expirada. Faça login novamente.' };
  if (perfisPermitidos && perfisPermitidos.indexOf(sessao.perfil) === -1) {
    return { erro: 'Você não tem permissão para essa ação.' };
  }
  return sessao;
}

// ===================== Usuários =====================
function usuariosSheet_() {
  return ensureSheet_('USUARIOS', ['login', 'hash_senha', 'salt', 'perfil', 'criado_por', 'criado_em', 'ativo']);
}

function buscarUsuario_(login) {
  var rows = sheetRowsAsObjects_(usuariosSheet_());
  var loginNorm = String(login || '').trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].login).trim().toLowerCase() === loginNorm) return rows[i];
  }
  return null;
}

function usuarioAtivo_(usuario) {
  return usuario && (usuario.ativo === true || String(usuario.ativo).toUpperCase() === 'TRUE');
}

// admin_master pode criar/gerenciar qualquer perfil, inclusive outro admin.
// admin só pode criar/gerenciar user1 e user2. Nunca cria admin/admin_master.
function podeGerenciarPerfil_(perfilAtor, perfilAlvo) {
  if (perfilAtor === 'admin_master') return true;
  if (perfilAtor === 'admin') return perfilAlvo === 'user1' || perfilAlvo === 'user2';
  return false;
}

// ===================== Handlers (chamados pelo doPost em Code.gs) =====================

function handleLogin_(body) {
  var login = String(body.login || '').trim().toLowerCase();
  var senha = String(body.senha || '');

  if (!login || !senha) {
    return { ok: false, error: 'Informe usuário e senha.' };
  }

  var cache = CacheService.getScriptCache();
  var chaveTentativas = 'login_tentativas_' + login;
  var tentativas = Number(cache.get(chaveTentativas) || 0);
  if (tentativas >= LOGIN_MAX_TENTATIVAS) {
    return { ok: false, error: 'Muitas tentativas incorretas. Tente novamente em alguns minutos.' };
  }

  var usuario = buscarUsuario_(login);
  if (!usuario || !usuarioAtivo_(usuario)) {
    cache.put(chaveTentativas, String(tentativas + 1), LOGIN_BLOQUEIO_MINUTOS * 60);
    registrarLog_(login, '', 'login_falho', 'usuário inexistente ou inativo');
    return { ok: false, error: 'Usuário ou senha incorretos.' };
  }

  var senhaConfere = hashSenha_(senha, usuario.salt) === usuario.hash_senha;
  var eraFormatoLegado = false;
  if (!senhaConfere && hashSenhaLegado_(senha, usuario.salt) === usuario.hash_senha) {
    senhaConfere = true;
    eraFormatoLegado = true;
  }
  if (!senhaConfere) {
    cache.put(chaveTentativas, String(tentativas + 1), LOGIN_BLOQUEIO_MINUTOS * 60);
    registrarLog_(login, usuario.perfil, 'login_falho', 'senha incorreta');
    return { ok: false, error: 'Usuário ou senha incorretos.' };
  }

  if (eraFormatoLegado) {
    usuariosSheet_().getRange(usuario._row, 2).setValue(hashSenha_(senha, usuario.salt)); // hash_senha
  }

  cache.remove(chaveTentativas);
  var token = criarSessao_(usuario.login, usuario.perfil);
  registrarLog_(usuario.login, usuario.perfil, 'login', '');
  return { ok: true, token: token, login: usuario.login, perfil: usuario.perfil };
}

function handleLogout_(body) {
  var sessao = obterSessao_(body.token);
  if (sessao) registrarLog_(sessao.login, sessao.perfil, 'logout', '');
  encerrarSessao_(body.token);
  return { ok: true };
}

function handleValidarToken_(body) {
  var sessao = obterSessao_(body.token);
  if (!sessao) return { ok: false };
  return { ok: true, login: sessao.login, perfil: sessao.perfil };
}

function handleListarUsuarios_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var rows = sheetRowsAsObjects_(usuariosSheet_());
  var usuarios = rows.map(function (u) {
    return {
      login: u.login,
      perfil: u.perfil,
      criado_por: u.criado_por,
      criado_em: u.criado_em,
      ativo: usuarioAtivo_(u)
    };
  });
  return { ok: true, usuarios: usuarios };
}

function handleCriarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var login = String(body.login || '').trim().toLowerCase();
  var senha = String(body.senha || '');
  var perfil = String(body.perfil || '');

  if (!login || !senha || !perfil) {
    return { ok: false, error: 'Preencha login, senha e perfil.' };
  }
  if (PERFIS_VALIDOS.indexOf(perfil) === -1) {
    return { ok: false, error: 'Perfil inválido.' };
  }
  if (senha.length < 6) {
    return { ok: false, error: 'A senha deve ter pelo menos 6 caracteres.' };
  }
  if (!podeGerenciarPerfil_(sessao.perfil, perfil)) {
    return { ok: false, error: 'Você não tem permissão para criar um usuário com esse perfil.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (buscarUsuario_(login)) {
      return { ok: false, error: 'Já existe um usuário com esse login.' };
    }
    var salt = gerarSalt_();
    var hash = hashSenha_(senha, salt);
    usuariosSheet_().appendRow([login, hash, salt, perfil, sessao.login, new Date().toISOString(), true]);
  } finally {
    lock.releaseLock();
  }

  registrarLog_(sessao.login, sessao.perfil, 'criacao_usuario', 'criou "' + login + '" (' + perfil + ')');
  return { ok: true };
}

function handleDesativarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  if (loginAlvo === sessao.login) {
    return { ok: false, error: 'Você não pode desativar sua própria conta.' };
  }
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para desativar esse usuário.' };
  }

  usuariosSheet_().getRange(usuario._row, 7).setValue(false); // coluna "ativo"
  encerrarSessoesDoUsuario_(loginAlvo);
  registrarLog_(sessao.login, sessao.perfil, 'desativacao_usuario', 'desativou "' + loginAlvo + '"');
  return { ok: true };
}

function handleReativarUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para reativar esse usuário.' };
  }

  usuariosSheet_().getRange(usuario._row, 7).setValue(true); // coluna "ativo"
  registrarLog_(sessao.login, sessao.perfil, 'reativacao_usuario', 'reativou "' + loginAlvo + '"');
  return { ok: true };
}

// Exclusão definitiva. Só é permitida para usuários já desativados — força
// passar por "Desativar" antes, evitando remover por engano uma conta em uso
// (a sessão ativa, se houver, já foi encerrada no momento da desativação).
// Apagar a linha não quebra o LOG nem a coluna "cadastrado_por" da aba RTI:
// os dois guardam o login como texto (um retrato do momento), não uma
// referência viva ao cadastro do usuário.
function handleExcluirUsuario_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var loginAlvo = String(body.login || '').trim().toLowerCase();
  if (loginAlvo === sessao.login) {
    return { ok: false, error: 'Você não pode excluir sua própria conta.' };
  }
  var usuario = buscarUsuario_(loginAlvo);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (!podeGerenciarPerfil_(sessao.perfil, usuario.perfil)) {
    return { ok: false, error: 'Você não tem permissão para excluir esse usuário.' };
  }
  if (usuarioAtivo_(usuario)) {
    return { ok: false, error: 'Desative o usuário antes de excluí-lo definitivamente.' };
  }

  usuariosSheet_().deleteRow(usuario._row);
  registrarLog_(sessao.login, sessao.perfil, 'exclusao_usuario', 'excluiu "' + loginAlvo + '" (' + usuario.perfil + ')');
  return { ok: true };
}

function handleAlterarSenha_(body) {
  var sessao = exigirSessao_(body.token, null);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var senhaAtual = String(body.senhaAtual || '');
  var senhaNova = String(body.senhaNova || '');
  if (senhaNova.length < 6) {
    return { ok: false, error: 'A nova senha deve ter pelo menos 6 caracteres.' };
  }

  var usuario = buscarUsuario_(sessao.login);
  if (!usuario) return { ok: false, error: 'Usuário não encontrado.' };
  if (hashSenha_(senhaAtual, usuario.salt) !== usuario.hash_senha) {
    return { ok: false, error: 'Senha atual incorreta.' };
  }

  var novoSalt = gerarSalt_();
  var novoHash = hashSenha_(senhaNova, novoSalt);
  var sheet = usuariosSheet_();
  sheet.getRange(usuario._row, 2).setValue(novoHash); // hash_senha
  sheet.getRange(usuario._row, 3).setValue(novoSalt); // salt

  // Encerra QUALQUER sessão ativa desse login (inclusive a atual) — é o
  // comportamento certo para "esqueci a senha em algum lugar" ou "acho que
  // minha conta foi comprometida": trocar a senha derruba todo mundo. Na
  // sequência, emite um token novo só para este dispositivo, pra quem
  // acabou de trocar a própria senha de propósito não precisar logar de
  // novo na hora.
  encerrarSessoesDoUsuario_(sessao.login);
  var novoToken = criarSessao_(sessao.login, sessao.perfil);

  registrarLog_(sessao.login, sessao.perfil, 'alteracao_senha', 'encerrou sessoes em outros dispositivos');
  return { ok: true, token: novoToken };
}

function handleObterTermo_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master', 'admin']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var ss = SpreadsheetApp.openById(TERMO_SHEET_ID);
  var sheet = TERMO_SHEET_NAME ? ss.getSheetByName(TERMO_SHEET_NAME) : ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  var rows = [];

  if (values.length >= 2) {
    var headers = values[0].map(String);
    rows = values.slice(1)
      .filter(function (row) { return row.some(function (cell) { return cell !== '' && cell !== null; }); })
      .map(function (row) {
        var record = {};
        headers.forEach(function (h, i) { record[h] = formatarCelula_(row[i]); });
        return record;
      });
  }

  registrarLog_(sessao.login, sessao.perfil, 'acesso_termo', rows.length + ' registro(s) consultado(s)');
  return { ok: true, rows: rows };
}

function formatarCelula_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'GMT-3', 'dd/MM/yyyy HH:mm');
  }
  return value;
}

function handleListarLog_(body) {
  var sessao = exigirSessao_(body.token, ['admin_master']);
  if (sessao.erro) return { ok: false, error: sessao.erro };

  var rows = sheetRowsAsObjects_(ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']));
  var acaoFiltro = body.acao || '';
  var dataInicio = body.dataInicio ? new Date(body.dataInicio) : null;
  var dataFim = body.dataFim ? new Date(body.dataFim) : null;

  var filtrado = rows.filter(function (r) {
    if (acaoFiltro && r.acao !== acaoFiltro) return false;
    var ts = new Date(r.timestamp);
    if (dataInicio && ts < dataInicio) return false;
    if (dataFim && ts > dataFim) return false;
    return true;
  }).map(function (r) {
    return { timestamp: r.timestamp, login: r.login, perfil: r.perfil, acao: r.acao, detalhe: r.detalhe };
  }).reverse(); // mais recentes primeiro

  return { ok: true, log: filtrado };
}

/**
 * Rode esta função MANUALMENTE pelo editor do Apps Script (nunca é exposta via
 * doGet/doPost). Cria as abas necessárias e o admin_master inicial, cuja senha
 * vem da Script Property "SENHA_INICIAL_ADMIN" — nunca do código-fonte.
 */
function setupInicial() {
  var senhaInicial = PropertiesService.getScriptProperties().getProperty('SENHA_INICIAL_ADMIN');
  if (!senhaInicial) {
    throw new Error(
      'Defina a Script Property "SENHA_INICIAL_ADMIN" (Configurações do projeto > ' +
      'Propriedades do script) antes de rodar o setupInicial().'
    );
  }

  ensureSheet_('RTI', [
    'timestamp', 'lat', 'lng', 'nome', 'capacidade_litros',
    'hidrante_fachada', 'hidrante_recalque', 'endereco', 'cadastrado_por'
  ]);
  ensureSheet_('SESSOES', ['token', 'login', 'perfil', 'criado_em', 'expira_em']);
  ensureSheet_('LOG', ['timestamp', 'login', 'perfil', 'acao', 'detalhe']);
  var usuarios = usuariosSheet_();

  if (buscarUsuario_('geraldo.reis')) {
    Logger.log('Usuário "geraldo.reis" já existe — nada a fazer.');
    return;
  }

  var salt = gerarSalt_();
  var hash = hashSenha_(senhaInicial, salt);
  usuarios.appendRow(['geraldo.reis', hash, salt, 'admin_master', 'setupInicial', new Date().toISOString(), true]);
  registrarLog_('geraldo.reis', 'admin_master', 'setup_inicial', 'criação do admin_master inicial');
  Logger.log('admin_master "geraldo.reis" criado com sucesso. Troque a senha pelo painel após o primeiro login.');
}
