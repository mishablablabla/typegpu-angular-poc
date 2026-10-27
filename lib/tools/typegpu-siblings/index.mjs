// Programmatic API of the sibling generator (used by the Angular wrapper builders, builders/delegate.cjs, and by the command).
import { generate, inspect, verify } from './generate.mjs';
import { resolveConfig } from './config.mjs';
import { watchSiblings } from './watch.mjs';

export { formatDiagnostic } from './generate.mjs';
export { resolveConfig, generate, inspect, verify };

/** Same shape the wrapper builders use for any shader tool: bring the generated files up to date (once). */
export const ensureShaders = (options = {}) => generate(resolveConfig(options));

/** Watch mode for a dev server: regenerate on every change; nothing is an error before the first shader exists. */
export const watchEnsure = (options = {}, hooks = {}) => watchSiblings(resolveConfig(options), hooks);

/** Stateless check that every generated file is current: `[]` when it is. The wrapper runs it before and after the official builder. */
export const verifyShaders = (options = {}) => verify(resolveConfig(options));
