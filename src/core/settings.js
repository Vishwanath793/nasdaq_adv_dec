/** User settings (persisted to .data/settings.json), merged over defaults and cleaned. */

import { readJson, writeJson } from './store.js';
import { PRESETS, DEFAULT_PRESET, FACTORS, GROUPS } from '../utils/conviction.js';
import { DEFAULT_RISK_SETTINGS, cleanRiskSettings } from '../utils/risk.js';
import { DEFAULT_STRATEGY_SETTINGS, strategySettings } from '../utils/strategies.js';
import { DEFAULT_GATES } from '../utils/tradeability.js';
import { DEFAULT_SCHEDULE } from '../utils/clock.js';
import { DEFAULT_DECISION_SETTINGS } from '../utils/decision.js';

export const DEFAULT_SETTINGS = {
  preset: DEFAULT_PRESET,
  groupWeights: null, // null = the preset's weights
  factorsOff: [],
  risk: DEFAULT_RISK_SETTINGS,
  strategies: DEFAULT_STRATEGY_SETTINGS,
  gates: DEFAULT_GATES,
  decision: DEFAULT_DECISION_SETTINGS,
  schedule: { final: DEFAULT_SCHEDULE.final, confirmGraceMs: DEFAULT_SCHEDULE.confirmGraceMs },
  universe: { includeAdrs: true, minPrice: 2 },
  live: { maxCandidates: 30 },
  sectorMap: {},
};

const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

export function cleanSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  const preset = PRESETS[input.preset] ? input.preset : d.preset;
  let groupWeights = null;
  if (input.groupWeights && typeof input.groupWeights === 'object') {
    groupWeights = {};
    for (const g of Object.keys(GROUPS)) if (input.groupWeights[g] != null) groupWeights[g] = num(input.groupWeights[g], 0, 100, 0);
  }
  const keys = new Set(FACTORS.map((f) => f.key));
  const gates = { ...DEFAULT_GATES };
  for (const k of Object.keys(DEFAULT_GATES)) if (input.gates?.[k] != null) gates[k] = num(input.gates[k], 0, 1e12, DEFAULT_GATES[k]);
  const final = /^09:29:[0-5]\d$|^09:2[89]:[0-5]\d$/.test(input.schedule?.final ?? '') ? input.schedule.final : d.schedule.final;
  return {
    preset, groupWeights,
    factorsOff: (input.factorsOff ?? []).filter((k) => keys.has(k)),
    risk: cleanRiskSettings(input.risk),
    strategies: strategySettings(input.strategies),
    gates,
    decision: { minConfirmScore: num(input.decision?.minConfirmScore, 0, 100, d.decision.minConfirmScore), watchScore: num(input.decision?.watchScore, 0, 100, d.decision.watchScore) },
    schedule: { final, confirmGraceMs: num(input.schedule?.confirmGraceMs, 0, 30_000, d.schedule.confirmGraceMs) },
    universe: { includeAdrs: input.universe?.includeAdrs !== false, minPrice: num(input.universe?.minPrice, 0, 1000, 2) },
    live: { maxCandidates: Math.round(num(input.live?.maxCandidates, 1, 30, 30)) },
    sectorMap: input.sectorMap && typeof input.sectorMap === 'object' ? Object.fromEntries(Object.entries(input.sectorMap).filter(([k, v]) => /^[A-Z.]{1,6}$/.test(k) && /^[A-Z]{2,5}$/.test(v))) : {},
  };
}

export const loadSettings = () => cleanSettings(readJson('settings.json', {}));
export function saveSettings(input) { const s = cleanSettings(input); writeJson('settings.json', s); return s; }
