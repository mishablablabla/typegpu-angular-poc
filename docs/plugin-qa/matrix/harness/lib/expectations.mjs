// PRE-REGISTERED EXPECTATIONS (MATRIX-BRIEF.md). Written before the first full run; sha256 of this file is recorded in results/.
// Value: a category, or a list of acceptable categories, or a function (mode, angular) => category | list.
// Categories: CORRECT | LOUD | SILENT-WRONG | UNSUPPORTED | N/A | ERROR.  A row passes when the observed category is in the list.
// SILENT-WRONG and ERROR are never acceptable. Where the brief says "LOUD where documented" or "CORRECT or LOUD", both are listed.
const C = 'CORRECT', L = 'LOUD';
export const EXPECT = {
  S01: C,
  S02: C,
  S03: C, S03d: C,
  S04a: C, S04b: C, S04c: C,
  S05a: [C, L], S05b: [C, L],
  S06a: C, S06b: C, S06c: C,
  S07: C, // 3 shader modules + shared helper + shader importing a shader, each transformed exactly once
  'S07-relative': (m) => (m === 'prebuild' ? L : C),
  'S07-js': (m) => (m === 'prebuild' ? [C, L] : C), // prebuild: the `.js` form is not documented either way
  'S07-alias': (m) => (m === 'prebuild' ? L : C),
  'S07-barrel': C,
  'S07-dynamic': C,
  S08: (m, a) => (m === 'plugin' && a === 20 ? 'UNSUPPORTED' : C), // plugin + Angular 20 (Karma) is a documented UNSUPPORTED; Karma 20 without CHROME_BIN is N/A
  S09: C,
  S10a: C, S10b: C,
  S11a: C, S11b: C, S11c: C,
  S12: C,
  S13: C,
  S14a: (m) => (m === 'prebuild' ? 'N/A' : L), // prebuild: a builder is per target, not per configuration
  S14b: L,
  S14c: L,
  S15: L, // a stale or raw artifact built by a swapped-in stock builder should be reported by the build or the bundle check
  S16: C,
  S16b: (m) => (m === 'prebuild' ? [C, L] : 'N/A'),
  S17a: C, S17b: C, S17c: C,
  S18a: C, S18b: C,
  S19a: [L, C], S19b: [L, C], S19c: [L, C], S19d: [L, C],
  S20a: (m) => (m === 'prebuild' ? [L, 'UNSUPPORTED'] : C), // plugin README: a shader file inside node_modules is transformed by ng build
  S20b: [L, 'UNSUPPORTED'], // sloppy-mode .cjs: not a matched extension; an untransformed directive must not ship silently
  S20c: (m) => (m === 'prebuild' ? [L, 'UNSUPPORTED'] : C),
  S21: 'N/A',
  'S22-space': [C, L], 'S22-hash': [C, L], 'S22-squote': [C, L], 'S22-dquote': [C, L], 'S22-unicode': [C, L], 'S22-suffix': [C, L],
  S23: L,
  S24: C,
};
export function expected(id, mode, angular) {
  const e = EXPECT[id];
  const v = typeof e === 'function' ? e(mode, angular) : e;
  return Array.isArray(v) ? v : [v];
}
