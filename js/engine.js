// IEPMP physics engine – murni JavaScript, tanpa dependensi (bisa diuji di Node).
// Level 5: Air Dispersion Solver (Gaussian plume) & Groundwater Transport Solver (FDM ADR).

const G = 9.81;

// ---------- Level 2/4: persamaan dasar & parameterisasi turbulensi ----------
export function sigma(cls, x, urban) {
  x = Math.max(x, 1);
  const a = (k) => 1 / Math.sqrt(1 + k * x);
  if (!urban) { // Briggs, tipe pedesaan
    const t = { A: [.22, .0001, .20, 0, 0], B: [.16, .0001, .12, 0, 0], C: [.11, .0001, .08, .0002, -.5],
                D: [.08, .0001, .06, .0015, -.5], E: [.06, .0001, .03, .0003, -1], F: [.04, .0001, .016, .0003, -1] }[cls];
    return [t[0] * x * a(t[1]), t[2] * x * (t[3] ? Math.pow(1 + t[3] * x, t[4]) : 1)];
  }
  // McElroy–Pooler, tipe perkotaan
  const u = { A: [.32, .24, 1e-3, .5], B: [.32, .24, 1e-3, .5], C: [.22, .20, 0, 0],
              D: [.16, .14, 3e-4, -.5], E: [.11, .08, 1.5e-3, -.5], F: [.11, .08, 1.5e-3, -.5] }[cls];
  return [u[0] * x * Math.pow(1 + 4e-4 * x, -.5), u[1] * x * (u[2] ? Math.pow(1 + u[2] * x, u[3]) : 1)];
}

// Kenaikan plume (Briggs final rise)
export function plumeRise(src, u, cls, Ta = 300) {
  const F = G * src.vs * src.d * src.d / 4 * Math.max(src.Ts - Ta, 0) / src.Ts;
  if (F <= 0) return 0;
  if (cls === 'E' || cls === 'F') {
    const s = G / Ta * (cls === 'E' ? 0.02 : 0.035);
    return 2.6 * Math.cbrt(F / (u * s));
  }
  return F < 55 ? 21.425 * Math.pow(F, .75) / u : 38.71 * Math.pow(F, .6) / u;
}

// Konsentrasi permukaan (ug/m3) dari satu sumber, satu titik (xd, yc) dalam sistem angin.
export function plumePoint(Q, H, u, cls, urban, xd, yc, kLoss) {
  if (xd <= 10) return 0;
  const [sy, sz] = sigma(cls, xd, urban);
  const deplete = Math.exp(-kLoss * xd / u);       // deposisi kering+basah+peluruhan
  const c = Q / (Math.PI * u * sy * sz) * Math.exp(-yc * yc / (2 * sy * sy)) * Math.exp(-H * H / (2 * sz * sz));
  return c * 1e6 * deplete;                         // g/m3 -> ug/m3
}

// ---------- Level 5a: Air Dispersion Solver ----------
export function solveAir({ sumber, polutan, u, dirFrom, cls, urban, kLoss, luasM, n, background = 0 }) {
  const to = ((dirFrom + 180) % 360) * Math.PI / 180;
  const sx = Math.sin(to), cy = Math.cos(to);
  const grid = new Float32Array(n * n);
  const half = luasM / 2, dx = luasM / n;
  const eff = sumber.map(s => ({ s, H: s.H + plumeRise(s, u, cls), Q: s.Q[polutan] }));
  let max = 0;
  for (let j = 0; j < n; j++) {
    const N = half - (j + .5) * dx;                 // baris 0 = utara
    for (let i = 0; i < n; i++) {
      const E = -half + (i + .5) * dx;
      let c = 0;
      for (const { s, H, Q } of eff) {
        const re = E - s.e, rn = N - s.n;
        c += plumePoint(Q, H, u, cls, urban, re * sx + rn * cy, re * cy - rn * sx, kLoss);
      }
      c += background;
      grid[j * n + i] = c;
      if (c > max) max = c;
    }
  }
  return { grid, n, max, luasM, dx, plume: eff.map(e => e.H) };
}

export function sampleGrid(res, e, nn) {
  const half = res.luasM / 2;
  const i = Math.floor((e + half) / res.dx), j = Math.floor((half - nn) / res.dx);
  if (i < 0 || j < 0 || i >= res.n || j >= res.n) return NaN;
  return res.grid[j * res.n + i];
}

// ---------- Level 5b: Groundwater Transport Solver (FDM, ADR, upwind + koreksi dispersi numerik) ----------
export function solveGW(p) {
  const { n, luasM, K, grad, ne, aL, rhoB, Kd, lambda, arah, C0, hari, nSnap = 24, sourceMask, probes = [] } = p;
  const dx = luasM / n;
  const v = K * grad / ne;                          // m/hari (Darcy: q = K i, v = q/ne)
  const th = arah * Math.PI / 180;                  // arah aliran menuju (derajat dari utara)
  const vx = v * Math.sin(th), vy = v * Math.cos(th); // vy positif = utara
  const R = 1 + rhoB * Kd / ne;
  const Dm = 1e-4;                                  // difusi molekuler efektif (m2/hari)
  const Dx = Math.max(aL * Math.abs(v) * Math.abs(Math.sin(th)) + aL / 10 * Math.abs(v) * Math.abs(Math.cos(th)) + Dm - Math.abs(vx) * dx / 2, 0);
  const Dy = Math.max(aL / 10 * Math.abs(v) * Math.abs(Math.sin(th)) + aL * Math.abs(v) * Math.abs(Math.cos(th)) + Dm - Math.abs(vy) * dx / 2, 0);
  const dt = 0.45 / ((Math.abs(vx) + Math.abs(vy)) / (dx * R) + 2 * (Dx + Dy) / (dx * dx * R) + lambda);
  const steps = Math.ceil(hari / dt), every = Math.max(1, Math.floor(steps / nSnap));
  let c = new Float64Array(n * n), c2 = new Float64Array(n * n);
  const mask = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) mask[j * n + i] = sourceMask(i, j) ? 1 : 0;
  const snaps = [], series = probes.map(() => []);
  const cell = (e, nn) => { const h = luasM / 2; return [Math.floor((e + h) / dx), Math.floor((h - nn) / dx)]; };
  for (let k = 0; k <= steps; k++) {
    if (k % every === 0 || k === steps) {
      snaps.push({ t: k * dt, grid: Float32Array.from(c) });
      probes.forEach((pr, q) => { const [i, j] = cell(pr.e, pr.n); series[q].push(c[j * n + i]); });
    }
    if (k === steps) break;
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const id = j * n + i, cc = c[id];
      const adv = (vx >= 0 ? vx * (cc - c[id - 1]) : vx * (c[id + 1] - cc)) / dx
                + (vy >= 0 ? vy * (cc - c[id + n]) : vy * (c[id - n] - cc)) / dx; // j+1 = selatan
      const dif = Dx * (c[id + 1] - 2 * cc + c[id - 1]) / (dx * dx) + Dy * (c[id + n] - 2 * cc + c[id - n]) / (dx * dx);
      c2[id] = cc + dt * ((dif - adv) / R - lambda * cc);
    }
    for (let id = 0; id < n * n; id++) if (mask[id]) c2[id] = C0;
    // batas terbuka: salin tetangga
    for (let a = 0; a < n; a++) { c2[a] = c2[a + n]; c2[(n - 1) * n + a] = c2[(n - 2) * n + a]; c2[a * n] = c2[a * n + 1]; c2[a * n + n - 1] = c2[a * n + n - 2]; }
    [c, c2] = [c2, c];
  }
  return { n, luasM, dx, v, R, Dx, Dy, dt, snaps, series, hari, probes };
}

// ---------- Level 7/8: kepatuhan baku mutu & risiko ----------
export function evaluasi(max, bm) {
  return { rasio: max / bm, status: max > bm ? 'Melebihi' : 'Memenuhi' };
}

export function luasPopulasi(res, bm, perm) {
  let area = 0, pop = 0, hi = 0;
  const half = res.luasM / 2, a = res.dx * res.dx;
  for (let j = 0; j < res.n; j++) for (let i = 0; i < res.n; i++) {
    const c = res.grid[j * res.n + i];
    if (c <= bm) continue;
    const E = -half + (i + .5) * res.dx, N = half - (j + .5) * res.dx;
    let dens = 0;                                    // jiwa/m2 dari permukiman Gaussian sintetis
    for (const p of perm) dens += p.pop / (2 * Math.PI * p.s * p.s) * Math.exp(-((E - p.e) ** 2 + (N - p.n) ** 2) / (2 * p.s * p.s));
    area += a; pop += dens * a; hi = Math.max(hi, c / bm);
  }
  return { areaKm2: area / 1e6, pop: Math.round(pop), hiMax: hi };
}
