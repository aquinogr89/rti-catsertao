'use strict';

// ===================== Configuração =====================
// Cole a URL de implantação (/exec) do Apps Script (apps-script/Code.gs) aqui.
// Enquanto vazia, os cadastros ficam salvos no localStorage do navegador
// (modo teste) e não são compartilhados entre dispositivos.
const SHEETS_API_URL = "";

const DEFAULT_CENTER = { lat: -9.3891, lng: -40.5030 }; // Petrolina-PE
const LOCAL_STORAGE_KEY = 'rti_catsertao_points';

let mapAdapter = null;
let currentCapture = null; // { lat, lng, endereco }

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

function showGeoWarning() {
  show(document.getElementById('geo-warning'));
}

function buildPopupHtml(point) {
  const fachadaYes = point.hidrante_fachada === 'SIM';
  const recalqueYes = point.hidrante_recalque === 'SIM';
  return (
    '<div class="rti-popup">' +
      '<strong>' + escapeHtml(point.nome) + '</strong>' +
      '<div class="row"><span class="label">Endereço:</span><span>' + escapeHtml(point.endereco || '—') + '</span></div>' +
      '<div class="row"><span class="label">Coordenadas:</span><span>' + fmtCoord(point.lat) + ', ' + fmtCoord(point.lng) + '</span></div>' +
      '<div class="row"><span class="label">Capacidade:</span><span>' + escapeHtml(point.capacidade_litros) + ' L</span></div>' +
      '<div class="chips">' +
        '<span class="chip' + (fachadaYes ? ' yes' : '') + '">Hidrante de fachada: ' + (fachadaYes ? 'SIM' : 'NÃO') + '</span>' +
        '<span class="chip' + (recalqueYes ? ' yes' : '') + '">Hidrante de recalque: ' + (recalqueYes ? 'SIM' : 'NÃO') + '</span>' +
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
    timestamp: raw.timestamp || new Date().toISOString()
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
        radius: 9, color: '#ffffff', weight: 2, fillColor: '#C1121F', fillOpacity: 1
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

function savePoint(payload) {
  if (SHEETS_API_URL) {
    return fetch(SHEETS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }
  return saveLocalPoint(payload);
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

  function openModal() {
    form.reset();
    hide(formError);
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

    const payload = {
      timestamp: new Date().toISOString(),
      lat: currentCapture.lat,
      lng: currentCapture.lng,
      nome: nome,
      capacidade_litros: Number(capacidade),
      hidrante_fachada: document.getElementById('check-fachada').checked ? 'SIM' : 'NAO',
      hidrante_recalque: document.getElementById('check-recalque').checked ? 'SIM' : 'NAO',
      endereco: currentCapture.endereco || ''
    };

    btnSalvar.disabled = true;
    btnSalvar.textContent = 'Salvando...';

    savePoint(payload)
      .then(function () {
        mapAdapter.addMarker(normalizePoint(payload));
        closeModal();
      })
      .catch(function () {
        formError.textContent = 'Não foi possível salvar agora. Verifique sua conexão e tente novamente.';
        show(formError);
      })
      .finally(function () {
        btnSalvar.disabled = false;
        btnSalvar.textContent = 'Salvar cadastro';
      });
  });
}
