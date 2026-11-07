/* FANTASUITE FUSION ENGINE 30.0
 * Fusione di: MAX-21.0 (indice 7 nov, moltiplicativo: ap*st*minuti = tripla penalità, weights/match mai usati, tattica = codice morto)
 * e storico v16.3 (voto atteso/fantavoto atteso con regressione prudenziale, runtime v118-v166).
 * SCELTE: i valori di fonte (expected_vote, expected_fantasy_vote) sono l'ANCORA (storico v16.3);
 * MAX-21.0 contribuisce modello a componenti, floor/ceiling, tattica esplicita. Ogni parametro entra UNA sola volta:
 *  - presenza/voto -> solo vp (probabilità di voto, già <= presenza) nell'utilità
 *  - minuti -> solo scala le frequenze gol/assist (minuti condizionati alla presenza)
 *  - titolarità -> solo rischio/panchina (non moltiplica il punteggio)
 *  - infortunio/rientro -> solo flag di rischio (già incorporati in ap e minuti)
 *  - data quality -> solo ampiezza intervallo (mai il valore atteso)
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FFE = factory(); })(this, function () {
  'use strict';
  const VERSION = 'FANTASUITE FUSION ENGINE 30.0';
  // COEFFICIENTI (tutti documentati nel README)
  const COEF = {
    noVoteValue: 5.5,                       // valore di un posto senza voto (sostituto medio)
    homeDelta: 0.02,                        // prior casa/trasferta sul voto puro (+/-)
    sdVote: { P: 0.80, D: 0.62, C: 0.58, A: 0.62 }, // deviazione std del voto puro per ruolo
    z: 1.28,                                // quantile ~90% per floor/ceiling
    uncertaintyInflation: 0.5,              // sd *= 1 + 0.5*(1-confidenza)
    tacticalShare: 0.5, tacticalCap: [0.92, 1.08], // la valorizzazione agisce solo sulla parte bonus
    formWeights: [0.35, 0.25, 0.2, 0.12, 0.08], formShrink: 0.25, formCap: 0.2,
    strategies: { prudent: { up: 0, down: 0.5 }, balanced: { up: 0.15, down: 0.15 }, aggressive: { up: 0.5, down: 0 } },
    surprise: { minVoteProb: 0.6, minConfidence: 0.5, topShareExcluded: 0.1 },
    mcSamples: 200, seed: 30
  };
  const DEFAULT_RULES = {
    mode: 'classic', modules: ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-3-2', '5-4-1'],
    goalPts: 3, assistPts: 1, benchSize: 7, maxSubs: 5, rosterSize: 25,
    modifier: { enabled: false, bestDefenders: 3, minDefenders: 4, thresholds: [[6, 1], [6.25, 2], [6.5, 3], [6.75, 4], [7, 5]] },
    cleanSheetKeeperBonus: 1, strategy: 'balanced'
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const num = x => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);
  const fin = (x, d = 0) => Number.isFinite(x) ? x : d;
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w ]/g, '').toLowerCase().trim();
  const sanitize = s => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').slice(0, 120);
  function rng(seed) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const parseModule = m => { const a = String(m).split('-').map(Number); return { P: 1, D: a[0], C: a[1], A: a[2] }; };

  // A. Data Normalization Engine
  function normalize(p) {
    const miss = [];
    const g = (k) => { const v = num(p[k]); if (v === null) miss.push(k); return v; };
    const ap = g('appearance_probability'), st = g('starter_probability'), vp0 = num(p.vote_probability);
    const apv = ap === null ? 0.5 : clamp(ap, 0, 1);
    const vp = clamp(vp0 === null ? apv : vp0, 0, apv);
    const mRaw = g('expected_minutes');
    // minuti: se coincidono con 90*ap sono non condizionati -> si riconvertono in condizionati (una sola volta)
    let cond = mRaw === null ? null : (apv < 0.99 && Math.abs(mRaw - 90 * apv) < 1 ? mRaw / apv : mRaw);
    cond = cond === null ? null : clamp(cond, 0, 95);
    return {
      id: p.id, name: sanitize(p.name), club: p.club, role: p.role, status: p.status || 'unknown',
      ap: apv, apKnown: ap !== null, st: st === null ? null : clamp(st, 0, apv), vp,
      minCond: cond, minUncond: cond === null ? null : apv * cond,
      ev: num(p.expected_vote) ?? num(p.mean_vote) ?? num(p.base_vote), efvSrc: num(p.expected_fantasy_vote),
      xg: g('xg90'), xa: g('xa90'), fvm: num(p.fvm), obs: num(p.observed_fantasy_average),
      inj: num(p.injury_risk), dq: num(p.data_quality), ret: p.return_stage || null,
      tacMult: num(p.coach_valorization), recent: Array.isArray(p.recent_votes) ? p.recent_votes.map(Number).filter(Number.isFinite) : null,
      penaltyRank: num(p.penalty_taker_rank), missing: miss, raw: p
    };
  }
  // L. Form Engine (solo con serie recente reale)
  function formScore(v) { if (!v || !v.length) return null; const w = COEF.formWeights; let s = 0, ws = 0; for (let i = 0; i < Math.min(5, v.length); i++) { s += w[i] * v[i]; ws += w[i]; } return s / ws; }

  // E,F,G,H,I,M + explainability: metriche di un giocatore
  function metrics(p, ctx = {}) {
    const n = p.ap !== undefined ? p : normalize(p), rules = ctx.rules || DEFAULT_RULES, strat = COEF.strategies[ctx.strategy || rules.strategy] || COEF.strategies.balanced;
    const flags = [];
    if (n.status === 'unavailable' || n.status === 'suspended') return { id: n.id, name: n.name, role: n.role, available: false, score: 0, utility: 0, efv: 0, ev: 0, vp: 0, confidence: fin(n.dq, 0.3), floor: 0, ceiling: 0, contributions: [], flags: ['indisponibile'], norm: n };
    if (n.ev === null || n.efvSrc === null) flags.push('voto atteso mancante');
    const evSrc = n.ev ?? (n.role === 'P' ? 5.9 : 6.0), efvSrc = n.efvSrc ?? evSrc;
    const m = n.minCond === null ? 90 : n.minCond; if (n.minCond === null) flags.push('minuti mancanti');
    const gp = this_pts(rules);
    const goal0 = n.xg === null ? 0 : gp.goal * n.xg * m / 90, ass0 = n.xa === null ? 0 : gp.assist * n.xa * m / 90;
    const srcNet = efvSrc - evSrc;
    const other = srcNet - goal0 - ass0; // cartellini, clean sheet, subiti, rigori e residuo di fonte (non scomponibile: dato non disponibile)
    const tm = n.tacMult === null ? 1 : clamp(n.tacMult, COEF.tacticalCap[0], COEF.tacticalCap[1]);
    const tac = (tm - 1) * COEF.tacticalShare * Math.max(0, goal0 + ass0);
    let home = 0; if (ctx.fixture && ctx.fixture.home !== undefined) home = (ctx.fixture.home ? 1 : -1) * COEF.homeDelta; else flags.push('matchup neutro (dati non strutturati)');
    let form = 0; const fs = formScore(n.recent); if (fs !== null) form = clamp((fs - evSrc) * COEF.formShrink, -COEF.formCap, COEF.formCap); else flags.push('forma recente non disponibile');
    const efv = evSrc + goal0 + ass0 + other + tac + home + form;
    const contributions = [['voto base', evSrc], ['probabilità gol', goal0], ['probabilità assist', ass0], ['altri bonus/malus netti (fonte)', other], ['valorizzazione allenatore', tac], ['casa/trasferta', home], ['forma', form]].map(([k, v]) => ({ k, v: fin(v) }));
    const nv = rules.noVoteValue ?? COEF.noVoteValue;
    const utility = n.vp * efv + (1 - n.vp) * nv;
    const dq = n.dq === null ? 0.5 : n.dq; if (n.dq === null) flags.push('data quality mancante');
    const conf = clamp(dq * (1 - 0.05 * n.missing.length), 0, 1);
    const infl = 1 + COEF.uncertaintyInflation * (1 - conf);
    const sdV = COEF.sdVote[n.role] * infl;
    const pg = clamp((n.xg || 0) * m / 90, 0, 1), pa = clamp((n.xa || 0) * m / 90, 0, 1);
    const sdUp = Math.sqrt(sdV * sdV + gp.goal * gp.goal * pg * (1 - pg) + gp.assist * gp.assist * pa * (1 - pa));
    const floorV = n.vp * (efv - COEF.z * sdV) + (1 - n.vp) * nv, ceilV = n.vp * (efv + COEF.z * sdUp) + (1 - n.vp) * nv;
    const score = utility + strat.up * (ceilV - utility) - strat.down * (utility - floorV);
    if (n.ret === 'RIENTRO_GRADUALE') flags.push('rientro graduale');
    if (n.status === 'doubt') flags.push('in dubbio');
    if (n.st !== null && n.st < 0.45) flags.push('rischio panchina/subentro');
    if (n.inj !== null && n.inj >= 0.25) flags.push('rischio infortunio alto');
    const r = x => Math.round(x * 1e4) / 1e4;
    return { id: n.id, name: n.name, club: n.club, role: n.role, available: true, score: fin(score), utility: fin(utility), efv: fin(efv), ev: evSrc, vp: n.vp, st: n.st, minutesCond: n.minCond, minutesUncond: n.minUncond,
      floor: fin(floorV), ceiling: fin(ceilV), sd: fin(sdV), volatility: fin(sdUp), confidence: conf, contributions, contributionsSum: r(contributions.reduce((a, c) => a + c.v, 0)),
      bonusPotential: fin(goal0 + ass0), flags, fixture: ctx.fixture || null, norm: n };
  }
  const this_pts = r => ({ goal: r.goalPts ?? 3, assist: r.assistPts ?? 1 });
  function explain(mt) { const pos = mt.contributions.filter(c => c.v > 0.005 && c.k !== 'voto base').map(c => c.k), neg = mt.contributions.filter(c => c.v < -0.005).map(c => c.k); return { positive: pos, negative: neg.concat(mt.flags), sumOk: Math.abs(mt.contributionsSum - mt.efv) < 1e-3 }; }

  // N. Defensive Modifier Engine (valore atteso su campionamento deterministico)
  function modifierPoints(avg, th) { let pts = 0; for (const [t, p] of th) if (avg >= t) pts = p; return pts; }
  function expectedModifier(gk, defs, rules, benchD = []) {
    const mod = rules.modifier; if (!mod || !mod.enabled) return { expected: 0, pAny: 0 };
    const r = rng(COEF.seed), N = COEF.mcSamples; let tot = 0, any = 0;
    for (let s = 0; s < N; s++) {
      const draw = m => (r() < m.vp) ? m.ev + COEF.sdVote[m.role] * gauss(r) : null;
      const gv = draw(gk); if (gv === null) continue;
      let votes = defs.map(draw).filter(v => v !== null), bi = 0;
      while (votes.length < defs.length && bi < benchD.length) { const v = draw(benchD[bi++]); if (v !== null) votes.push(v); }
      if (votes.length < mod.minDefenders) continue;
      votes.sort((a, b) => b - a); const avg = (gv + votes.slice(0, mod.bestDefenders).reduce((a, b) => a + b, 0)) / (1 + mod.bestDefenders);
      const pts = modifierPoints(avg, mod.thresholds); tot += pts; if (pts > 0) any++;
    }
    return { expected: tot / N, pAny: any / N };
  }
  const combos = (a, k) => { const out = []; (function f(s, c) { if (c.length === k) { out.push(c.slice()); return; } for (let i = s; i < a.length; i++) { c.push(a[i]); f(i + 1, c); c.pop(); } })(0, []); return out; };

  // P. Formation Optimizer
  function optimize(pool, rules = DEFAULT_RULES, opts = {}) {
    const ctxFor = opts.ctxFor || (() => ({})), res = [];
    const M = pool.map(p => metrics(p, Object.assign({ rules, strategy: opts.strategy || rules.strategy }, ctxFor(p)))).filter(m => m.available);
    const by = r => M.filter(m => m.role === r).sort((a, b) => b.score - a.score);
    const G = by('P'), D = by('D'), C = by('C'), A = by('A');
    for (const mod of (opts.modules || rules.modules)) {
      const need = parseModule(mod); if (G.length < 1 || D.length < need.D || C.length < need.C || A.length < need.A) continue;
      const mid = C.slice(0, need.C), att = A.slice(0, need.A), base = mid.concat(att).reduce((a, m) => a + m.score, 0);
      let best = null;
      const gkC = G.slice(0, 2), dC = D.slice(0, Math.min(D.length, need.D + 2));
      const dCombos = rules.modifier.enabled ? combos(dC, need.D) : [D.slice(0, need.D)];
      for (const g of gkC) for (const ds of dCombos) {
        const rest = D.filter(x => !ds.includes(x)).slice(0, 3);
        const em = expectedModifier(metricAsVote(g), ds.map(metricAsVote), rules, rest.map(metricAsVote));
        const tot = base + g.score + ds.reduce((a, m) => a + m.score, 0) + em.expected;
        if (!best || tot > best.total) best = { total: tot, gk: g, defs: ds, modifier: em };
        if (!rules.modifier.enabled) break;
      }
      res.push({ module: mod, total: best.total, xi: [best.gk].concat(best.defs, mid, att), modifier: best.modifier, gk: best.gk });
    }
    res.sort((a, b) => b.total - a.total);
    return { best: res[0] || null, ranking: res.map(r => ({ module: r.module, total: r.total, modifier: r.modifier.expected })) };
  }
  const metricAsVote = m => ({ vp: m.vp, ev: m.ev, role: m.role });

  // Q. Bench and Substitution Engine
  function pbDist(ps) { let d = [1]; for (const p of ps) { const n = new Array(d.length + 1).fill(0); d.forEach((v, i) => { n[i] += v * (1 - p); n[i + 1] += v * p; }); d = n; } return d; }
  function bench(pool, xi, rules = DEFAULT_RULES, opts = {}) {
    const used = new Set(xi.map(m => m.id)), ctxFor = opts.ctxFor || (() => ({}));
    let cand = pool.map(p => metrics(p, Object.assign({ rules, strategy: opts.strategy || rules.strategy }, ctxFor(p)))).filter(m => m.available && !used.has(m.id));
    const need = {}; for (const r of ['P', 'D', 'C', 'A']) need[r] = 1 - xi.filter(m => m.role === r).reduce((a, m) => a * m.vp, 1);
    const order = [], nv = rules.noVoteValue ?? COEF.noVoteValue;
    if (cand.some(m => m.role === 'P')) { const k = cand.filter(m => m.role === 'P').sort((a, b) => b.vp - a.vp)[0]; order.push(k); cand = cand.filter(m => m !== k); need.P *= (1 - k.vp); }
    while (order.length < rules.benchSize && cand.length) {
      cand.sort((a, b) => (b.vp * (b.efv - nv) * need[b.role]) - (a.vp * (a.efv - nv) * need[a.role]));
      const k = cand.shift(); order.push(k); need[k.role] *= (1 - k.vp);
    }
    let covered = 1;
    for (const r of ['P', 'D', 'C', 'A']) { const K = pbDist(xi.filter(m => m.role === r).map(m => 1 - m.vp)), B = pbDist(order.filter(m => m.role === r).map(m => m.vp)); let pc = 0; K.forEach((pk, k) => { for (let b = 0; b < B.length; b++) if (b >= k) pc += pk * B[b]; }); covered *= Math.min(1, pc); }
    return { order, riskTenMen: clamp(1 - covered, 0, 1) };
  }

  // Surprise Engine (dinamico: dipende da punteggi/ceiling del contesto)
  function surprises(pool, rules = DEFAULT_RULES, opts = {}) {
    const ctxFor = opts.ctxFor || (() => ({})), cs = COEF.surprise;
    const M = pool.map(p => metrics(p, Object.assign({ rules, strategy: 'aggressive' }, ctxFor(p)))).filter(m => m.available);
    const pct = (arr, v) => arr.length < 2 ? 0.5 : arr.filter(x => x < v).length / (arr.length - 1);
    const out = [];
    for (const r of ['P', 'D', 'C', 'A']) {
      const g = M.filter(m => m.role === r), U = g.map(m => m.utility), UP = g.map(m => m.ceiling - m.utility), F = g.map(m => m.norm.fvm ?? 0), V = g.map(m => m.vp);
      for (const m of g) {
        const pu = pct(U, m.utility);
        if (m.vp < cs.minVoteProb || m.confidence < cs.minConfidence || m.norm.fvm === null || (!opts.includeTop && pu > 1 - cs.topShareExcluded)) continue;
        out.push(Object.assign({}, m, { surprise: 100 * (0.35 * pct(UP, m.ceiling - m.utility) + 0.25 * pu + 0.25 * (1 - pct(F, m.norm.fvm)) + 0.15 * pct(V, m.vp)) }));
      }
    }
    return out.sort((a, b) => b.surprise - a.surprise);
  }

  // R/S. Multi-fanta + aggiornamenti (ID master = chiave primaria)
  const mkId = () => 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function createLeague(name, rules) { return { id: mkId(), name: sanitize(name), rules: Object.assign({}, DEFAULT_RULES, rules || {}), teams: [] }; }
  function addTeam(league, name) { const t = { id: mkId(), name: sanitize(name), playerIds: [] }; league.teams.push(t); return t; }
  function assign(league, teamId, playerId, ds) {
    if (!ds.players.some(p => p.id === playerId)) return { ok: false, reason: 'ID non nel listone' };
    if (league.teams.some(t => t.playerIds.includes(playerId))) return { ok: false, reason: 'già assegnato in questo fantacalcio' };
    const t = league.teams.find(x => x.id === teamId); if (!t) return { ok: false, reason: 'squadra inesistente' }; t.playerIds.push(playerId); return { ok: true };
  }
  function importRosterCSV(text, ds) {
    const found = [], unknown = [];
    String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => {
      const c = l.split(/[;,\t]/).map(x => x.trim()); if (/^\d+$/.test(c[0])) { const p = ds.players.find(x => x.id === Number(c[0])); p ? found.push(p.id) : unknown.push(l); return; }
      const nm = norm(c[0]), club = c[1] ? c[1].toUpperCase() : null; const m = ds.players.filter(p => norm(p.name) === nm && (!club || p.club === club));
      m.length === 1 ? found.push(m[0].id) : unknown.push(l + (m.length > 1 ? ' (ambiguo: usa ID)' : ''));
    });
    return { ids: [...new Set(found)], duplicates: found.length - new Set(found).size, unknown };
  }
  function validateUpdate(u) { const err = []; if (!u || typeof u !== 'object') return ['JSON non valido']; if (!Array.isArray(u.players)) err.push('players mancante'); else u.players.forEach((p, i) => { if (!Number.isInteger(p.id)) err.push('ID mancante riga ' + i); if (!['P', 'D', 'C', 'A'].includes(p.role)) err.push('ruolo non valido id ' + p.id); if (!p.name) err.push('nome mancante id ' + p.id); }); return err; }
  function applyUpdate(ds, u) {
    const err = validateUpdate(u); if (err.length) return { ok: false, errors: err };
    const old = new Map(ds.players.map(p => [p.id, p])), seen = new Set(), log = { added: [], removed: [], changed: [], unrecognized: [] };
    const players = u.players.map(p => { seen.add(p.id); const o = old.get(p.id); if (!o) { log.added.push(p.id); return p; } const prev = { efv: o.expected_fantasy_vote, status: o.status }; const np = Object.assign({}, o, p, { previous: prev }); if (prev.efv !== np.expected_fantasy_vote || prev.status !== np.status) log.changed.push(p.id); return np; });
    ds.players.forEach(p => { if (!seen.has(p.id)) { log.removed.push(p.id); players.push(p); } }); // mai rimossi senza consenso: restano nel listone
    return { ok: true, dataset: Object.assign({}, ds, { players, updated_at: u.generated_at || new Date().toISOString() }), log };
  }
  function diagnostics(ds) {
    const ids = ds.players.map(p => p.id), bad = [];
    ds.players.forEach(p => Object.entries(p).forEach(([k, v]) => { if (typeof v === 'number' && !Number.isFinite(v)) bad.push(p.id + ':' + k); }));
    return { count: ids.length, uniqueIds: new Set(ids).size === ids.length, nonFinite: bad, missingByField: ['xg90', 'xa90', 'data_quality', 'expected_minutes'].map(k => [k, ds.players.filter(p => num(p[k]) === null).length]) };
  }
  return { VERSION, COEF, DEFAULT_RULES, normalize, metrics, explain, formScore, expectedModifier, modifierPoints, optimize, bench, surprises, parseModule, createLeague, addTeam, assign, importRosterCSV, validateUpdate, applyUpdate, diagnostics, norm, sanitize };
});
