// POST-HOC NOTES (written after the first runs, kept apart from the pre-registered expectations). Key: "<id>|<mode>" or "<id>|*".
// A note never changes a category or a status; it says why a row failed or why the expectation was questionable.
export const NOTES = {
  'S03d|*': 'Not shader related: a development build with source maps writes `my-canvas.css.map` for both components of the generated file (MyCanvas and MyCanvasScene) under one name and the content depends on which finishes last. Reproduced on a stock Angular 22.2.4 app with two inline-styled components in one file and no TypeGPU (explore/t3). The production build (S03) is deterministic in both modes.',
  'S14c|prebuild': 'Better than the expectation: the stock unit-test builder runs the project\'s `build` target, which is the wrapper builder, so shaders are rebuilt anyway. The expectation assumed the wrapper would be bypassed.',
  'S14b|*': 'Equal in both modes and silent: the stock dev server ignores the plugin (plugin: raw shader served) or the wrapper (prebuild: stale shaders-dist served). `ng add` never produces this configuration; it needs a hand edit of angular.json.',
  'S15|prebuild': 'The stale-but-transformed bundle passes the bundle check by construction (the check looks for untransformed directives, not for stale ones). Plugin fails loudly here only because the swapped-in builder leaves the directive raw.',
  'S16|*': 'Control in the same build (a plain env.ts replaced by env.prod.ts) works in both modes: fileReplacements of a `*.gpu.ts` shader is the part that is ignored (plugin: the plugin redirects the import before Angular applies the replacement, hypothesis; prebuild: the application imports the generated module, not the source file).',
  'S17a|plugin': 'Control (plain module, same edit) is ignored too: the Angular watcher does not rebuild for an edit whose mtime was restored or is old. Prebuild follows because the shader tool has its own watcher keyed on content.',
  'S17b|plugin': 'Same as S17a: the control with a plain module fails identically.',
  'S18a|plugin': 'Control (a plain module deleted and recreated the same way) fails identically: Angular watcher behaviour, not plugin specific. Prebuild follows because the shader tool rebuilds the generated module itself.',
  'S18b|*': 'Control (a missing plain module created later) fails identically in both modes: documented plugin limit, and the same stock Angular behaviour in prebuild.',
  'S19a|*': 'A misspelled directive is an ordinary string statement: no build-time scan can see it (a lint rule could). Same result in both modes; the failure shows at runtime (TypeGPU: missing metadata).',
  'S06c|prebuild': 'Same bug as lane B finding B-05: on a case-insensitive file system the generated file keeps its old case, and Angular (which watches the new-case name) does not see later content changes. Reproduced by hand with explore/case.mjs (shaders-dist/app/x.gpu.js holds the new marker, the bundle does not).',
  'S22-dquote|prebuild': 'LOUD but wrong claim in lib/README.md ("file names with quotes or # work"): a double quote in the file name fails ("does not match a generated shader module"), single quote and # work.',
};
export const noteFor = (id, mode) => NOTES[`${id}|${mode}`] ?? NOTES[`${id}|*`];
