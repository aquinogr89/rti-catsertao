'use strict';

// ===================== Configuração =====================
// Cole a URL de implantação (/exec) do Apps Script (apps-script/Code.gs) aqui.
// Enquanto vazia, os cadastros ficam salvos no localStorage do navegador
// (modo teste) e não são compartilhados entre dispositivos.
const SHEETS_API_URL = "https://script.google.com/macros/s/AKfycbwQwjmNoPHYD0lOvqaAsOs9wQntZ24p68y9cAGn1yck7cUgmZia_-6aH2yv1dqPvmcIGQ/exec";

const DEFAULT_CENTER = { lat: -9.3891, lng: -40.5030 }; // Petrolina-PE
const LOCAL_STORAGE_KEY = 'rti_catsertao_points';

// Login é feito no site principal; os dois sites são publicados sob o mesmo
// domínio (aquinogr89.github.io), então sessionStorage é compartilhado desde
// que a navegação entre eles ocorra na mesma aba (link normal, sem target=_blank).
const CATSERTAO_URL = 'https://aquinogr89.github.io/catsertao/';
const CAT_SESSION_KEY = 'cat_session';
const RTI_ALLOWED_PROFILES = ['admin_master', 'admin', 'user1'];

let mapAdapter = null;
let currentCapture = null; // { lat, lng, endereco }

function getSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(CAT_SESSION_KEY) || 'null');
    return (session && session.token && session.perfil) ? session : null;
  } catch (e) {
    return null;
  }
}

// ===================== Utilitários =====================
function show(el) { el.classList.remove('u-hidden'); }
function hide(el) { el.classList.add('u-hidden'); }

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtCoord(n) {
  return typeof n === 'number' ? n.toFixed(6) : n;
}

function fmtDateBR(isoDate) {
  // Espera 'YYYY-MM-DD'. Monta a data em UTC para não perder um dia por
  // causa do fuso horário local (new Date('YYYY-MM-DD') é interpretado
  // como meia-noite UTC pelo navegador).
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function fmtNumberBR(n, decimals) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function showGeoWarning() {
  show(document.getElementById('geo-warning'));
}

// Verde: possui AVCB e a validade é hoje ou no futuro. Vermelho: não possui
// AVCB, ou a data informada já passou. Recalculado a cada renderização do
// marcador (não fica salvo pronto), comparando sempre com a data atual.
function getAvcbStatus(point) {
  if (point.possui_avcb !== 'SIM' || !point.data_validade_avcb) {
    return { cor: '#C1121F', valido: false, label: 'Não possui AVCB' };
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const [ano, mes, dia] = String(point.data_validade_avcb).split('-').map(Number);
  const validade = new Date(ano, mes - 1, dia);

  if (isNaN(validade.getTime())) {
    return { cor: '#C1121F', valido: false, label: 'Data de validade do AVCB inválida' };
  }
  if (validade >= hoje) {
    return { cor: '#1E8E4E', valido: true, label: 'Válido até ' + fmtDateBR(point.data_validade_avcb) };
  }
  return { cor: '#C1121F', valido: false, label: 'Vencido desde ' + fmtDateBR(point.data_validade_avcb) };
}

function buildPopupHtml(point) {
  const fachadaYes = point.hidrante_fachada === 'SIM';
  const recalqueYes = point.hidrante_recalque === 'SIM';
  const avcb = getAvcbStatus(point);

  let detalhesHtml = '';
  if (point.quantidade_pavimentos != null) {
    detalhesHtml += '<div class="row"><span class="label">Pavimentos:</span><span>' + point.quantidade_pavimentos + ' pavimento(s)</span></div>';
  }
  if (point.area_construida != null) {
    detalhesHtml += '<div class="row"><span class="label">Área construída:</span><span>' + fmtNumberBR(point.area_construida, 2) + ' m²</span></div>';
  }
  if (point.altura_edificacao != null) {
    detalhesHtml += '<div class="row"><span class="label">Altura:</span><span>' + fmtNumberBR(point.altura_edificacao, 2) + ' m</span></div>';
  }

  return (
    '<div class="rti-popup">' +
      '<strong>' + escapeHtml(point.nome) + '</strong>' +
      '<div class="row"><span class="label">Endereço:</span><span>' + escapeHtml(point.endereco || '—') + '</span></div>' +
      '<div class="row"><span class="label">Coordenadas:</span><span>' + fmtCoord(point.lat) + ', ' + fmtCoord(point.lng) + '</span></div>' +
      '<div class="row"><span class="label">Capacidade:</span><span>' + escapeHtml(point.capacidade_litros) + ' L</span></div>' +
      detalhesHtml +
      '<div class="chips">' +
        '<span class="chip' + (fachadaYes ? ' yes' : '') + '">Hidrante de fachada: ' + (fachadaYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (recalqueYes ? ' yes' : '') + '">Hidrante de recalque: ' + (recalqueYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (avcb.valido ? ' yes' : '') + '">AVCB: ' + escapeHtml(avcb.label) + '</span>' +
      '</div>' +
    '</div>'
  );
}

function normalizePoint(raw) {
  return {
    lat: parseFloat(raw.lat),
    lng: parseFloat(raw.lng),
    nome: raw.nome || '',
    capacidade_litros: raw.capacidade_litros || 0,
    hidrante_fachada: raw.hidrante_fachada === 'SIM' ? 'SIM' : 'NAO',
    hidrante_recalque: raw.hidrante_recalque === 'SIM' ? 'SIM' : 'NAO',
    endereco: raw.endereco || '',
    timestamp: raw.timestamp || new Date().toISOString(),
    possui_avcb: raw.possui_avcb === 'SIM' ? 'SIM' : 'NAO',
    data_validade_avcb: raw.data_validade_avcb || null,
    quantidade_pavimentos: toNullableNumber(raw.quantidade_pavimentos),
    area_construida: toNullableNumber(raw.area_construida),
    altura_edificacao: toNullableNumber(raw.altura_edificacao)
  };
}

// ===================== Geocodificação reversa =====================
function reverseGeocode(lat, lng, cb) {
  fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=18&addressdetails=1')
    .then(function (r) { return r.json(); })
    .then(function (data) { cb(data.display_name || 'Endereço não encontrado'); })
    .catch(function () { cb('Endereço indisponível'); });
}

// ===================== Mapa: Leaflet (OpenStreetMap) =====================
function initLeafletMap() {
  const map = L.map('map', { zoomControl: true }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  mapAdapter = {
    setCenter: function (lat, lng, zoom) {
      map.setView([lat, lng], zoom || map.getZoom());
    },
    addMarker: function (point) {
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: getAvcbStatus(point).cor, fillOpacity: 1
      }).addTo(map);
      marker.bindPopup(buildPopupHtml(point));
      return marker;
    }
  };

  startApp();
}
window.initLeafletMap = initLeafletMap;

// ===================== Fluxo comum da aplicação =====================
function determineInitialLocation(cb) {
  if (!navigator.geolocation) {
    showGeoWarning();
    mapAdapter.setCenter(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 13);
    if (cb) cb(null);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      mapAdapter.setCenter(lat, lng, 15);
      if (cb) cb({ lat: lat, lng: lng });
    },
    function () {
      showGeoWarning();
      mapAdapter.setCenter(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 13);
      if (cb) cb(null);
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function getLocalPoints() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveLocalPoint(point) {
  const points = getLocalPoints();
  points.push(point);
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(points));
  return Promise.resolve(point);
}

function loadPoints() {
  if (SHEETS_API_URL) {
    fetch(SHEETS_API_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.points || data || []).forEach(function (raw) {
          mapAdapter.addMarker(normalizePoint(raw));
        });
      })
      .catch(function () { /* mapa continua utilizável mesmo sem pontos */ });
  } else {
    show(document.getElementById('badge-test'));
    getLocalPoints().forEach(function (raw) {
      mapAdapter.addMarker(normalizePoint(raw));
    });
  }
}

function savePoint(record, token) {
  if (SHEETS_API_URL) {
    const payload = Object.assign({ action: 'cadastrarRTI', token: token }, record);
    return fetch(SHEETS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error(res.error || 'Falha ao salvar.'));
      return res;
    });
  }
  return saveLocalPoint(record);
}

function startApp() {
  determineInitialLocation();
  loadPoints();

  document.getElementById('btn-locate').addEventListener('click', function () {
    determineInitialLocation(function (loc) { if (loc) mapAdapter.setCenter(loc.lat, loc.lng, 16); });
  });

  wireCadastroModal();
}

// ===================== Modal de cadastro =====================
function wireCadastroModal() {
  const overlay = document.getElementById('modal-overlay');
  const form = document.getElementById('rti-form');
  const formError = document.getElementById('form-error');
  const latEl = document.getElementById('loc-lat');
  const lngEl = document.getElementById('loc-lng');
  const addrEl = document.getElementById('loc-addr');
  const btnSalvar = document.getElementById('btn-salvar');

  function captureLocation() {
    latEl.textContent = '...';
    lngEl.textContent = '...';
    addrEl.textContent = 'Obtendo localização...';
    currentCapture = null;

    if (!navigator.geolocation) {
      latEl.textContent = 'Indisponível';
      lngEl.textContent = 'Indisponível';
      addrEl.textContent = '—';
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        currentCapture = { lat: lat, lng: lng, endereco: '' };
        latEl.textContent = fmtCoord(lat);
        lngEl.textContent = fmtCoord(lng);
        addrEl.textContent = 'Obtendo endereço...';
        reverseGeocode(lat, lng, function (addr) {
          if (currentCapture && currentCapture.lat === lat && currentCapture.lng === lng) {
            currentCapture.endereco = addr;
            addrEl.textContent = addr;
          }
        });
      },
      function () {
        latEl.textContent = 'Indisponível';
        lngEl.textContent = 'Indisponível';
        addrEl.textContent = 'Permita o acesso à localização e tente novamente.';
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  const checkAvcb = document.getElementById('check-avcb');
  const campoDataAvcb = document.getElementById('campo-data-avcb');
  const inputDataAvcb = document.getElementById('input-data-avcb');

  function toggleCampoDataAvcb() {
    if (checkAvcb.checked) {
      show(campoDataAvcb);
    } else {
      hide(campoDataAvcb);
      inputDataAvcb.value = '';
    }
  }
  checkAvcb.addEventListener('change', toggleCampoDataAvcb);

  function openModal() {
    const session = getSession();
    if (!session || RTI_ALLOWED_PROFILES.indexOf(session.perfil) === -1) {
      window.location.href = CATSERTAO_URL;
      return;
    }
    form.reset();
    hide(formError);
    hide(campoDataAvcb); // form.reset() não dispara 'change', então esconde manualmente
    show(overlay);
    captureLocation();
  }

  function closeModal() {
    hide(overlay);
  }

  document.getElementById('btn-cadastrar').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
  document.getElementById('btn-atualizar-loc').addEventListener('click', captureLocation);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hide(formError);

    const nome = document.getElementById('input-nome').value.trim();
    const capacidade = document.getElementById('input-capacidade').value;

    const session = getSession();
    if (!session || RTI_ALLOWED_PROFILES.indexOf(session.perfil) === -1) {
      formError.textContent = 'Sua sessão expirou. Você será redirecionado para o login.';
      show(formError);
      setTimeout(function () { window.location.href = CATSERTAO_URL; }, 1500);
      return;
    }
    if (!currentCapture || typeof currentCapture.lat !== 'number') {
      formError.textContent = 'Não foi possível obter sua localização. Toque em "Atualizar localização" e tente novamente.';
      show(formError);
      return;
    }
    if (!nome) {
      formError.textContent = 'Informe o nome do edifício ou empresa.';
      show(formError);
      return;
    }
    if (!capacidade || Number(capacidade) <= 0) {
      formError.textContent = 'Informe a capacidade da RTI em litros.';
      show(formError);
      return;
    }

    const possuiAvcb = checkAvcb.checked;
    const dataValidadeAvcb = inputDataAvcb.value;
    if (possuiAvcb && !dataValidadeAvcb) {
      formError.textContent = 'Informe a data de validade do AVCB, ou desmarque "Possui AVCB válido".';
      show(formError);
      return;
    }

    const pavimentos = document.getElementById('input-pavimentos').value;
    if (pavimentos && Number(pavimentos) < 1) {
      formError.textContent = 'A quantidade de pavimentos deve ser 1 ou mais.';
      show(formError);
      return;
    }
    const area = document.getElementById('input-area').value;
    if (area && Number(area) < 0) {
      formError.textContent = 'A área construída não pode ser negativa.';
      show(formError);
      return;
    }
    const altura = document.getElementById('input-altura').value;
    if (altura && Number(altura) < 0) {
      formError.textContent = 'A altura da edificação não pode ser negativa.';
      show(formError);
      return;
    }

    const record = {
      timestamp: new Date().toISOString(),
      lat: currentCapture.lat,
      lng: currentCapture.lng,
      nome: nome,
      capacidade_litros: Number(capacidade),
      hidrante_fachada: document.getElementById('check-fachada').checked ? 'SIM' : 'NAO',
      hidrante_recalque: document.getElementById('check-recalque').checked ? 'SIM' : 'NAO',
      endereco: currentCapture.endereco || '',
      possui_avcb: possuiAvcb ? 'SIM' : 'NAO',
      data_validade_avcb: possuiAvcb ? dataValidadeAvcb : '',
      quantidade_pavimentos: pavimentos ? Number(pavimentos) : '',
      area_construida: area ? Number(area) : '',
      altura_edificacao: altura ? Number(altura) : ''
    };

    btnSalvar.disabled = true;
    btnSalvar.textContent = 'Salvando...';

    savePoint(record, session.token)
      .then(function () {
        mapAdapter.addMarker(normalizePoint(record));
        closeModal();
      })
      .catch(function (err) {
        formError.textContent = (err && err.message) || 'Não foi possível salvar agora. Verifique sua conexão e tente novamente.';
        show(formError);
      })
      .finally(function () {
        btnSalvar.disabled = false;
        btnSalvar.textContent = 'Salvar cadastro';
      });
  });
}
