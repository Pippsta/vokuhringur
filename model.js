// model.js — period-and-phase prediction model for Vökuhringur.
//
// Public API:
//   collapseSessions(observations, gapMs?)  -> events[]
//   fitTau(events, queryTime?, opts?)       -> { tau, R }
//   predict(events, tau, queryTime)         -> { pAwake, confidence, debug }
//
// Conventions:
//   observations: [{ ts: Date, source: "chess" | "friend" }, ...]
//   events: collapsed observations [{ t: ms, source, size }]
//   tau: circadian period in hours
//   queryTime: ms since epoch (Number) — typically Date.now() or +Date

const HOUR = 3_600_000;
const DAY  = 86_400_000;

// ---------- session collapsing ----------

// Walk observations sorted by time; consecutive *chess* observations within
// gapMs of each other are one session. Each session collapses to its median
// timestamp. Friend observations always pass through as size-1 events.
export function collapseSessions(observations, gapMs = 30 * 60 * 1000) {
  const sorted = observations
    .map(o => ({ t: +o.ts, source: o.source }))
    .sort((a, b) => a.t - b.t);

  const out = [];
  let session = null;

  const flush = () => {
    if (!session) return;
    const med = session.times[Math.floor(session.times.length / 2)];
    out.push({ t: med, source: "chess", size: session.times.length });
    session = null;
  };

  for (const o of sorted) {
    if (o.source !== "chess") {
      flush();
      out.push({ t: o.t, source: o.source, size: 1 });
      continue;
    }
    if (session && o.t - session.lastT <= gapMs) {
      session.times.push(o.t);
      session.lastT = o.t;
    } else {
      flush();
      session = { times: [o.t], lastT: o.t };
    }
  }
  flush();
  return out;
}

// ---------- phase math ----------

const phaseOf = (tMs, tauMs) => {
  const r = (tMs % tauMs) / tauMs;
  return r < 0 ? r + 1 : r;
};

// Weighted Rayleigh R over a set of phases (∈ [0,1)). R ∈ [0,1].
function weightedR(phases, weights) {
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < phases.length; i++) {
    const a = 2 * Math.PI * phases[i];
    sx += weights[i] * Math.cos(a);
    sy += weights[i] * Math.sin(a);
    sw += weights[i];
  }
  if (sw === 0) return 0;
  return Math.sqrt(sx * sx + sy * sy) / sw;
}

// ---------- period fit ----------

// Search tau in [tauMin, tauMax] hours by step. For each candidate tau,
// score by recency-weighted Rayleigh R of phases. Pick max R. Restricted
// to events within fitWindowDays of queryTime — fitting on stale data
// would lock in an outdated phase.
export function fitTau(events, queryTime, opts = {}) {
  const tauMin = opts.tauMin ?? 22.0;
  const tauMax = opts.tauMax ?? 27.0;
  const step   = opts.step   ?? 0.02;
  const fitWindowDays = opts.fitWindowDays ?? 365;
  const recencyDays   = opts.recencyDays   ?? 90;

  const cutoff = queryTime - fitWindowDays * DAY;
  const recent = events.filter(e => e.t >= cutoff && e.t <= queryTime);

  if (recent.length < 10) {
    // Not enough recent data — fall back to a sensible literature value
    // (the user's friend has non-24-hour cycle; ~24.5 h is a reasonable
    // default until more data accumulates).
    return { tau: 24.5, R: 0, fitN: recent.length };
  }

  const weights = recent.map(e =>
    Math.exp(-(queryTime - e.t) / (recencyDays * DAY))
  );

  let best = { tau: 24.5, R: -Infinity };
  for (let tau = tauMin; tau <= tauMax + 1e-9; tau += step) {
    const tauMs = tau * HOUR;
    const phases = recent.map(e => phaseOf(e.t, tauMs));
    const R = weightedR(phases, weights);
    if (R > best.R) best = { tau, R };
  }
  return { tau: best.tau, R: best.R, fitN: recent.length };
}

// ---------- predict ----------

export function predict(events, tau, queryTime, opts = {}) {
  const windowDays   = opts.windowDays   ?? 90;
  const recencyDays  = opts.recencyDays  ?? 30;
  const kappa        = opts.kappa        ?? 8;     // von Mises bandwidth
  const phaseGridN   = opts.phaseGridN   ?? 120;
  const lowEss       = opts.lowEss       ?? 5;
  const highEss      = opts.highEss      ?? 20;
  const lowR         = opts.lowR         ?? 0.3;
  const highR        = opts.highR        ?? 0.6;
  const staleLowDays = opts.staleLowDays ?? 30;
  const staleHighDays= opts.staleHighDays?? 7;

  const tauMs = tau * HOUR;
  const phaseQ = phaseOf(queryTime, tauMs);

  // Only events strictly at-or-before the query — so this works for both
  // live predictions (query in the future of all data) and calibration
  // (query in the middle of the data, only past events count).
  const past = events.filter(e => e.t <= queryTime);

  const within = past.filter(e => queryTime - e.t <= windowDays * DAY);

  if (within.length === 0) {
    return {
      pAwake: 0.5,
      confidence: "low",
      debug: { reason: "no recent events", phaseQ, tau, ess: 0, R: 0 },
    };
  }

  const weights = within.map(e =>
    Math.exp(-(queryTime - e.t) / (recencyDays * DAY))
  );
  const phases = within.map(e => phaseOf(e.t, tauMs));

  // Effective sample size = (Σw)² / Σw²
  let sw = 0, sw2 = 0;
  for (const w of weights) { sw += w; sw2 += w * w; }
  const ess = (sw * sw) / sw2;

  const R = weightedR(phases, weights);

  // Von Mises KDE at any query phase, normalised by max - min over a phase
  // grid, so we get a relative density in [0,1].
  const cosp = phases.map(p => Math.cos(2 * Math.PI * p));
  const sinp = phases.map(p => Math.sin(2 * Math.PI * p));

  const kdeAt = (phi) => {
    const a = 2 * Math.PI * phi;
    const c = Math.cos(a), s = Math.sin(a);
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      // exp(κ cos(a - φ_i)) = exp(κ (c·cosφ_i + s·sinφ_i))
      total += weights[i] * Math.exp(kappa * (c * cosp[i] + s * sinp[i]));
    }
    return total / sw;
  };

  let kdeMin = Infinity, kdeMax = -Infinity, kdeMean = 0;
  for (let i = 0; i < phaseGridN; i++) {
    const k = kdeAt(i / phaseGridN);
    if (k < kdeMin) kdeMin = k;
    if (k > kdeMax) kdeMax = k;
    kdeMean += k;
  }
  kdeMean /= phaseGridN;

  const kQ = kdeAt(phaseQ);

  // Map (KDE - mean) / max_abs_dev → [-1, 1], then scale by R so that low-R
  // (no clear wake cluster) gives pAwake ≈ 0.5 regardless of phase.
  const dev = Math.max(kdeMax - kdeMean, kdeMean - kdeMin) || 1;
  const norm = (kQ - kdeMean) / dev;          // ∈ [-1, 1]
  const pAwake = clamp(0.5 + 0.4 * R * norm, 0.05, 0.95);

  // Staleness from the latest event we used.
  const latestT = within[within.length - 1].t;  // events are sorted ascending
  const stalenessDays = Math.max(0, (queryTime - latestT) / DAY);

  let confidence;
  if (ess < lowEss || stalenessDays > staleLowDays || R < lowR) {
    confidence = "low";
  } else if (ess > highEss && stalenessDays < staleHighDays && R > highR) {
    confidence = "high";
  } else {
    confidence = "medium";
  }

  return {
    pAwake,
    confidence,
    debug: { tau, phaseQ, ess, R, stalenessDays, kQ, kdeMin, kdeMax, kdeMean, norm },
  };
}

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;

// ---------- baseline models, used in the eval panel ----------

export const flat50 = () => 0.5;

// "Awake during local daytime": Iceland local = UTC. 08:00–21:59 UTC inclusive
// → pAwake = 0.9, otherwise 0.1.
export function localDaytime(queryTime) {
  const h = new Date(queryTime).getUTCHours();
  return (h >= 8 && h < 22) ? 0.9 : 0.1;
}
