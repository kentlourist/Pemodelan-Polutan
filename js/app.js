import { BAKU_MUTU_UDARA as BMU, BAKU_MUTU_AIRTANAH as BMG, SKENARIO_UDARA as SU, SKENARIO_TANAH as ST, BASEMAPS } from './config.js';
import { solveAir, solveGW, sampleGrid, luasPopulasi, evaluasi } from './engine.js';

const $ = (s) => document.querySelector(s);
const fmt = (x, d = 1) => (x >= 1000 ? x.toFixed(0) : x >= 10 ? x.toFixed(d) : x >= 0.1 ? x.toFixed(2) : x.toPrecision(2));
const toLL = (c, e, n) => [c[0] + n / 111320, c[1] + e / (111320 * Math.cos(c[0] * Math.PI / 180))];
const toEN = (c, ll) => [(ll.lng - c[1]) * 111320 * Math.cos(c[0] * Math.PI / 180), (ll.lat - c[0]) * 111320];
const boundsOf = (c, half) => [toLL(c, -half, -half), toLL(c, half, half)];

// ---------- Peta: Leaflet + Google Street Map / Satelit ----------
const map = L.map('map', { preferCanvas: true }).setView(SU.pusat, 12);
const bases = {};
for (const [k, v] of Object.entries(BASEMAPS)) bases[k] = L.tileLayer(v.url, { subdomains: v.sub, attribution: v.attr, maxZoom: 20 });
bases['Google Street Map'].addTo(map);
L.control.scale({ imperial: false }).addTo(map);
let layerCtl, mode = 'air';
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => { const d = L.DomUtil.create('div', 'legend'); legend._d = d; return d; };
legend.addTo(map);
const setLegend = (title, a, b, bmTxt) => { legend._d.innerHTML = `<b>${title}</b><i></i><div><span>${a}</span><span>${b}</span></div>${bmTxt ? `<div style="color:#d7261e"><span>${bmTxt}</span></div>` : ''}`; };

const RAMP = [[27, 63, 166], [31, 160, 216], [47, 191, 113], [242, 213, 31], [242, 138, 31], [215, 38, 30]];
function ramp(t) {
  t = Math.min(1, Math.max(0, t)); const x = t * (RAMP.length - 1), i = Math.min(Math.floor(x), RAMP.length - 2), f = x - i;
  return RAMP[i].map((v, k) => v + (RAMP[i + 1][k] - v) * f);
}
function paint(grid, n, fn) {
  const cv = document.createElement('canvas'); cv.width = cv.height = n;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(n, n);
  for (let k = 0; k < n * n; k++) { const [t, a] = fn(grid[k]); const [r, g, b] = ramp(t); img.data.set([r, g, b, a * 255], k * 4); }
  ctx.putImageData(img, 0, 0); return cv.toDataURL();
}
const clickPop = (txt) => (e) => { const v = txt(e.latlng); if (v) L.popup().setLatLng(e.latlng).setContent(v).openOn(map); };

// =====================================================================
// UDARA
// =====================================================================
const A = { pol: 'SO2', u: 3, dir: 260, cls: 'C', urban: 0, em: 1, rain: 0, op: .75, only: false };
const airLayers = { overlay: null, sumber: L.layerGroup(), titik: L.layerGroup(), perm: L.layerGroup(), angin: L.layerGroup(), domain: null };
let airRes = null, airVmax = 1;
const half = SU.luasKm * 500;
airLayers.domain = L.rectangle(boundsOf(SU.pusat, half), { color: '#16346b', weight: 1, fill: false, dashArray: '4 4' });
SU.sumber.forEach((s) => L.circleMarker(toLL(SU.pusat, s.e, s.n), { radius: 7, color: '#fff', weight: 2, fillColor: '#d7261e', fillOpacity: 1 }).bindTooltip(`${s.nama}<br>H=${s.H} m`).addTo(airLayers.sumber));
SU.sampling.forEach((s) => L.circleMarker(toLL(SU.pusat, s.e, s.n), { radius: 6, color: '#0d2547', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(s.nama).addTo(airLayers.titik));
SU.permukiman.forEach((p) => L.circle(toLL(SU.pusat, p.e, p.n), { radius: p.s, color: '#6b4fbb', weight: 1, fillColor: '#6b4fbb', fillOpacity: .12 }).bindTooltip(`${p.nama}: ±${p.pop.toLocaleString('id')} jiwa`).addTo(airLayers.perm));

const polSel = $('#a-pol');
for (const [k, v] of Object.entries(BMU)) polSel.add(new Option(`${v.label} (baku mutu ${v.bm} µg/m³ / ${v.avg})`, k, false, k === A.pol));

function runAir() {
  const kLoss = 1e-5 + 8e-5 * Math.pow(A.rain, .64);
  const sumber = SU.sumber.map((s) => ({ ...s, Q: Object.fromEntries(Object.entries(s.Q).map(([k, v]) => [k, v * A.em])) }));
  const base = { sumber, u: A.u, dirFrom: A.dir, cls: A.cls, urban: !!A.urban, kLoss, luasM: SU.luasKm * 1000 };
  const bm = BMU[A.pol].bm;
  airRes = solveAir({ ...base, polutan: A.pol, background: SU.background[A.pol], n: 200 });
  airVmax = Math.max(airRes.max, bm * 1.2);
  const bg = SU.background[A.pol];
  const url = paint(airRes.grid, airRes.n, (c) => {
    const ex = c - bg, t = Math.sqrt(Math.max(c, 0) / airVmax);
    let a = Math.min(1, Math.max(0, ex / (0.06 * airVmax)));
    if (A.only && c <= bm) a = 0;
    return [t, a];
  });
  const b = boundsOf(SU.pusat, half);
  if (airLayers.overlay) airLayers.overlay.setUrl(url).setOpacity(A.op);
  else { airLayers.overlay = L.imageOverlay(url, b, { opacity: A.op, interactive: false }); if (mode === 'air') { airLayers.overlay.addTo(map); buildControl(); } }
  // arah angin: garis dari sumber pertama ke arah hilir
  airLayers.angin.clearLayers();
  const to = ((A.dir + 180) % 360) * Math.PI / 180, s0 = SU.sumber[0], len = 2500;
  const p1 = toLL(SU.pusat, s0.e, s0.n), p2 = toLL(SU.pusat, s0.e + len * Math.sin(to), s0.n + len * Math.cos(to));
  L.polyline([p1, p2], { color: '#16346b', weight: 2, dashArray: '6 6' }).addTo(airLayers.angin);
  L.circleMarker(p2, { radius: 4, color: '#16346b', fillOpacity: 1 }).bindTooltip(`Angin ${A.u.toFixed(1)} m/s dari ${A.dir}°`).addTo(airLayers.angin);

  const ev = evaluasi(airRes.max, bm), ex = luasPopulasi(airRes, bm, SU.permukiman);
  $('#a-kpi').innerHTML = kpi(`${fmt(airRes.max)} µg/m³`, 'Konsentrasi maksimum') + kpi(`${bm} µg/m³`, `Baku mutu (${BMU[A.pol].avg})`)
    + kpi(`<span class="${ev.status === 'Melebihi' ? 'bad' : 'ok'}">${ev.status}</span>`, 'Status mutu')
    + kpi(ev.rasio.toFixed(2), 'Indeks bahaya relatif (C/BM)')
    + kpi(`${ex.areaKm2.toFixed(2)} km²`, 'Area melebihi baku mutu') + kpi(`${ex.pop.toLocaleString('id')} jiwa`, 'Populasi terpapar (sintetis)');
  // tabel semua polutan
  let rows = '<tr><th>Parameter</th><th>Maks</th><th>BM</th><th>Status</th></tr>';
  for (const [k, v] of Object.entries(BMU)) {
    const r = k === A.pol ? airRes : solveAir({ ...base, polutan: k, background: SU.background[k], n: 100 });
    const e = evaluasi(r.max, v.bm);
    rows += `<tr><td>${v.label} <small>(${v.avg})</small></td><td>${fmt(r.max)}</td><td>${v.bm}</td><td class="${e.status === 'Melebihi' ? 'bad' : 'ok'}">${e.status}</td></tr>`;
  }
  $('#a-tbl').innerHTML = rows;
  setLegend(`${BMU[A.pol].label} (µg/m³)`, '0', fmt(airVmax), `Baku mutu ${bm}`);
  $('#hud').innerHTML = `<span>Angin ${A.u.toFixed(1)} m/s dari ${A.dir}°</span><span>Stabilitas ${A.cls}</span><span>Tinggi efektif plume ${airRes.plume[0].toFixed(0)} m</span>`;
}
const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;

// =====================================================================
// TANAH & AIR TANAH
// =====================================================================
const GP = { pol: 'TDS', K: ST.param.K, grad: ST.param.grad, dir: ST.param.arah, Kd: ST.param.Kd, lam: ST.param.lambda, days: 3650, op: .8, idx: 0 };
const gwLayers = { overlay: null, sumber: L.layerGroup(), titik: L.layerGroup(), domain: L.rectangle(boundsOf(ST.pusat, ST.luasM / 2), { color: '#16346b', weight: 1, fill: false, dashArray: '4 4' }) };
L.rectangle([toLL(ST.pusat, ST.sumber.e - ST.sumber.lebar / 2, ST.sumber.n - ST.sumber.panjang / 2), toLL(ST.pusat, ST.sumber.e + ST.sumber.lebar / 2, ST.sumber.n + ST.sumber.panjang / 2)], { color: '#fff', weight: 2, fillColor: '#6b3b1e', fillOpacity: .9 }).bindTooltip('Sumber kontaminan (timbunan)').addTo(gwLayers.sumber);
ST.sumur.forEach((s) => L.circleMarker(toLL(ST.pusat, s.e, s.n), { radius: 6, color: '#0d2547', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(s.nama).addTo(gwLayers.titik));
const gSel = $('#g-pol'); for (const [k, v] of Object.entries(BMG)) gSel.add(new Option(`${v.label} (baku mutu contoh ${v.bm} ${v.unit})`, k));
let gwRes = null, playTimer = null;

function runGW() {
  const n = 150, dx = ST.luasM / n, S = ST.sumber, c = BMG[GP.pol];
  $('#g-run').textContent = 'Menghitung…';
  setTimeout(() => {
    gwRes = solveGW({ n, luasM: ST.luasM, ...ST.param, K: GP.K, grad: GP.grad, arah: GP.dir, Kd: GP.Kd, lambda: GP.lam, C0: c.c0, hari: GP.days, probes: ST.sumur,
      sourceMask: (i, j) => Math.abs(-ST.luasM / 2 + (i + .5) * dx - S.e) < S.lebar / 2 && Math.abs(ST.luasM / 2 - (j + .5) * dx - S.n) < S.panjang / 2 });
    const t = $('#g-t'); t.max = gwRes.snaps.length - 1; t.value = gwRes.snaps.length - 1; GP.idx = +t.value;
    $('#g-run').textContent = 'Jalankan simulasi';
    showGW(); drawChart();
  }, 20);
}
function showGW() {
  if (!gwRes) return;
  const c = BMG[GP.pol], snap = gwRes.snaps[GP.idx], vmin = c.bm / 100, vmax = c.c0, lg = Math.log10;
  const url = paint(snap.grid, gwRes.n, (v) => v < vmin ? [0, 0] : [(lg(v) - lg(vmin)) / (lg(vmax) - lg(vmin)), .92]);
  if (gwLayers.overlay) gwLayers.overlay.setUrl(url).setOpacity(GP.op);
  else gwLayers.overlay = L.imageOverlay(url, boundsOf(ST.pusat, ST.luasM / 2), { opacity: GP.op, interactive: false });
  if (mode === 'gw' && !map.hasLayer(gwLayers.overlay)) { gwLayers.overlay.addTo(map); buildControl(); }
  let cnt = 0, reach = 0; const h = ST.luasM / 2;
  for (let j = 0; j < gwRes.n; j++) for (let i = 0; i < gwRes.n; i++) if (snap.grid[j * gwRes.n + i] > c.bm) {
    cnt++; reach = Math.max(reach, Math.hypot(-h + (i + .5) * gwRes.dx - ST.sumber.e, h - (j + .5) * gwRes.dx - ST.sumber.n));
  }
  const tahun = snap.t / 365;
  $('#o-t').textContent = tahun < 2 ? `${snap.t.toFixed(0)} hari` : `${tahun.toFixed(1)} tahun`;
  const maxWell = Math.max(...gwRes.series.map((s) => s[GP.idx]));
  $('#g-kpi').innerHTML = kpi(`${gwRes.v.toFixed(2)} m/hari`, 'Kecepatan pori (v = K·i/nₑ)') + kpi(gwRes.R.toFixed(2), 'Faktor retardasi R')
    + kpi(`${(cnt * gwRes.dx * gwRes.dx / 1e4).toFixed(1)} ha`, 'Area di atas baku mutu') + kpi(`${reach.toFixed(0)} m`, 'Jangkauan dari pusat sumber')
    + kpi(`${fmt(maxWell)} ${c.unit}`, 'Maks. di sumur pantau') + kpi(`<span class="${maxWell > c.bm ? 'bad' : 'ok'}">${maxWell > c.bm ? 'Melebihi' : 'Memenuhi'}</span>`, 'Status sumur pantau');
  setLegend(`${c.label} (${c.unit}, skala log)`, fmt(vmin), fmt(vmax), `Baku mutu ${c.bm}`);
  $('#hud').innerHTML = `<span>Arah aliran ${GP.dir}°</span><span>K = ${GP.K} m/hari</span><span>t = ${$('#o-t').textContent}</span>`;
  drawChart();
}
function drawChart() {
  const cv = $('#chart'); if (!cv.offsetWidth || !gwRes) return;
  const r = devicePixelRatio || 1, W = cv.width = cv.offsetWidth * r, H = cv.height = 150 * r, x = cv.getContext('2d'); x.scale(r, r);
  const w = W / r, h = H / r, c = BMG[GP.pol], pad = { l: 38, r: 8, t: 8, b: 20 }, T = gwRes.snaps.map((s) => s.t), tm = T.at(-1) || 1;
  const ymax = c.c0, X = (t) => pad.l + t / tm * (w - pad.l - pad.r), Y = (v) => h - pad.b - Math.min(v, ymax) / ymax * (h - pad.t - pad.b);
  x.clearRect(0, 0, w, h); x.font = '10px sans-serif'; x.fillStyle = '#5d6b82'; x.strokeStyle = '#dbe2ec';
  [0, .5, 1].forEach((f) => { x.beginPath(); x.moveTo(pad.l, Y(f * ymax)); x.lineTo(w - pad.r, Y(f * ymax)); x.stroke(); x.fillText(fmt(f * ymax), 2, Y(f * ymax) + 3); });
  x.fillText('0', pad.l, h - 6); x.fillText(`${(tm / 365).toFixed(0)} th`, w - 30, h - 6);
  x.strokeStyle = '#d7261e'; x.setLineDash([4, 3]); x.beginPath(); x.moveTo(pad.l, Y(c.bm)); x.lineTo(w - pad.r, Y(c.bm)); x.stroke(); x.setLineDash([]);
  ['#1f6feb', '#2e9e6b', '#f28a1f'].forEach((col, q) => { x.strokeStyle = col; x.lineWidth = 2; x.beginPath(); gwRes.series[q].forEach((v, k) => k ? x.lineTo(X(T[k]), Y(v)) : x.moveTo(X(T[k]), Y(v))); x.stroke(); });
  x.strokeStyle = '#14223b'; x.lineWidth = 1; x.beginPath(); x.moveTo(X(T[GP.idx]), pad.t); x.lineTo(X(T[GP.idx]), h - pad.b); x.stroke();
}

// =====================================================================
// Kontrol, tab, interaksi
// =====================================================================
function buildControl() {
  if (layerCtl) map.removeControl(layerCtl);
  const ov = mode === 'air'
    ? { 'Sebaran polutan udara': airLayers.overlay, 'Sumber emisi': airLayers.sumber, 'Titik sampling': airLayers.titik, 'Permukiman (sintetis)': airLayers.perm, 'Arah angin': airLayers.angin, 'Batas domain': airLayers.domain }
    : { 'Sebaran kontaminan air tanah': gwLayers.overlay, 'Sumber kontaminan': gwLayers.sumber, 'Sumur pantau': gwLayers.titik, 'Batas domain': gwLayers.domain };
  for (const k of Object.keys(ov)) if (!ov[k]) delete ov[k];
  layerCtl = L.control.layers(bases, ov, { collapsed: true }).addTo(map);
}
function setMode(m) {
  mode = m; stopAll();
  const groups = [airLayers.overlay, airLayers.sumber, airLayers.titik, airLayers.perm, airLayers.angin, airLayers.domain, gwLayers.overlay, gwLayers.sumber, gwLayers.titik, gwLayers.domain];
  groups.forEach((g) => g && map.hasLayer(g) && map.removeLayer(g));
  const on = m === 'air' ? [airLayers.overlay, airLayers.sumber, airLayers.titik, airLayers.perm, airLayers.angin, airLayers.domain] : [gwLayers.overlay, gwLayers.sumber, gwLayers.titik, gwLayers.domain];
  on.forEach((g) => g && g.addTo(map));
  $('#tab-air').classList.toggle('on', m === 'air'); $('#tab-gw').classList.toggle('on', m === 'gw');
  $('#panel-air').hidden = m !== 'air'; $('#panel-gw').hidden = m !== 'gw';
  if (m === 'air') { map.fitBounds(boundsOf(SU.pusat, half * .6)); runAir(); } else { map.fitBounds(boundsOf(ST.pusat, ST.luasM * .42)); gwRes ? showGW() : runGW(); }
  buildControl();
}
$('#tab-air').onclick = () => setMode('air'); $('#tab-gw').onclick = () => setMode('gw');

let deb; const later = (f) => { clearTimeout(deb); deb = setTimeout(f, 60); };
function bind(id, key, obj, out, f = (v) => v, label = (v) => v) {
  const el = $(id), o = out && $(out);
  const upd = () => { obj[key] = f(el.value); if (o) o.textContent = label(obj[key]); };
  el.addEventListener('input', () => { upd(); if (obj === A) later(runAir); else if (key === 'op') showGW(); }); upd();
}
bind('#a-u', 'u', A, '#o-u', Number, (v) => `${v.toFixed(1)} m/s`);
bind('#a-dir', 'dir', A, '#o-dir', Number, (v) => `${v}°`);
bind('#a-em', 'em', A, '#o-em', Number, (v) => `×${v.toFixed(1)}`);
bind('#a-rain', 'rain', A, '#o-rain', Number, (v) => `${v} mm/jam`);
bind('#a-op', 'op', A, '#o-op', Number, (v) => `${Math.round(v * 100)}%`);
['#a-pol:pol', '#a-cls:cls', '#a-urb:urban'].forEach((s) => { const [id, k] = s.split(':'); $(id).addEventListener('change', (e) => { A[k] = k === 'urban' ? +e.target.value : e.target.value; runAir(); }); });
$('#a-only').addEventListener('change', (e) => { A.only = e.target.checked; runAir(); });

bind('#g-K', 'K', GP, '#o-K', Number, (v) => `${v} m/hari`);
bind('#g-i', 'grad', GP, '#o-i', Number, (v) => v.toFixed(3));
bind('#g-dir', 'dir', GP, '#o-gdir', Number, (v) => `${v}°`);
bind('#g-Kd', 'Kd', GP, '#o-Kd', Number, (v) => `${v} L/kg`);
bind('#g-lam', 'lam', GP, '#o-lam', Number, (v) => `${v}/hari`);
bind('#g-op', 'op', GP, '#o-gop', Number, (v) => `${Math.round(v * 100)}%`);
$('#g-t').addEventListener('input', (e) => { GP.idx = +e.target.value; showGW(); });
$('#g-pol').addEventListener('change', (e) => { GP.pol = e.target.value; gwRes = null; runGW(); });
$('#g-days').addEventListener('change', (e) => { GP.days = +e.target.value; });
$('#g-run').onclick = runGW;
$('#g-play').onclick = () => {
  if (playTimer) return stopAll();
  $('#g-play').textContent = 'Berhenti'; if (GP.idx >= gwRes.snaps.length - 1) GP.idx = 0;
  playTimer = setInterval(() => { GP.idx++; $('#g-t').value = GP.idx; showGW(); if (GP.idx >= gwRes.snaps.length - 1) stopAll(); }, 250);
};
// Animasi 24 jam: meteorologi sintetis harian (stabilitas, angin, arah berubah)
let animTimer = null;
const STAB = 'FFFFFEDCBBAAABBCCDEEFFFF'.split('');
$('#a-anim').onclick = () => {
  if (animTimer) return stopAll();
  let h = 0; $('#a-anim').textContent = 'Berhenti';
  animTimer = setInterval(() => {
    A.cls = STAB[h % 24]; A.u = Math.max(1.5, 2.8 + 1.8 * Math.sin(Math.PI * (h - 6) / 12)); A.dir = Math.round((260 + 40 * Math.sin(2 * Math.PI * h / 24) + 360) % 360);
    $('#a-cls').value = A.cls; $('#a-u').value = A.u; $('#a-dir').value = A.dir; $('#o-u').textContent = `${A.u.toFixed(1)} m/s`; $('#o-dir').textContent = `${A.dir}°`;
    runAir(); $('#hud').insertAdjacentHTML('beforeend', `<span><b>Pukul ${String(h % 24).padStart(2, '0')}:00</b></span>`); h++;
  }, 900);
};
function stopAll() { clearInterval(playTimer); clearInterval(animTimer); playTimer = animTimer = null; $('#g-play').textContent = 'Putar'; $('#a-anim').textContent = 'Animasi 24 jam'; }

map.on('click', (e) => {
  const [E, N] = toEN(mode === 'air' ? SU.pusat : ST.pusat, e.latlng); let html = '';
  if (mode === 'air' && airRes) { const v = sampleGrid(airRes, E, N); if (!isNaN(v)) html = `<b>${BMU[A.pol].label}</b>: ${fmt(v)} µg/m³<br>Baku mutu ${BMU[A.pol].bm} → <b class="${v > BMU[A.pol].bm ? 'bad' : 'ok'}">${v > BMU[A.pol].bm ? 'Melebihi' : 'Memenuhi'}</b>`; }
  if (mode === 'gw' && gwRes) { const h = ST.luasM / 2, i = Math.floor((E + h) / gwRes.dx), j = Math.floor((h - N) / gwRes.dx);
    if (i >= 0 && j >= 0 && i < gwRes.n && j < gwRes.n) { const v = gwRes.snaps[GP.idx].grid[j * gwRes.n + i], c = BMG[GP.pol]; html = `<b>${c.label}</b>: ${fmt(v)} ${c.unit}<br>Baku mutu ${c.bm} → <b class="${v > c.bm ? 'bad' : 'ok'}">${v > c.bm ? 'Melebihi' : 'Memenuhi'}</b>`; } }
  if (html) L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
});
addEventListener('resize', () => gwRes && drawChart());
setMode('air');
