// The union of the option schemas of one Angular builder across Angular majors (used by sync-builder-schemas.mjs and by the tests that
// guard the committed copies).
//
// The wrapper builders carry ONE schema for Angular 20, 21 and 22. The CLI fills defaults from that schema, and the official builder
// that then runs validates the filled options against ITS OWN (installed) schema. So a default that exists in only some majors is wrong:
// it would be filled for a major that rejects it (`ssr.platform` is Angular 22's name for 20/21's `ssr.experimentalPlatform`; filling
// `platform: 'node'` made every Angular 20/21 SSR build fail). Therefore, at every depth: properties are united; a property that is not
// in every major, or whose default differs, loses its default; `required` is the intersection.

/** Options the wrapper accepts but the official builder does not know, so that `ng generate web-worker` does not break `ng test` (see delegate.cjs). */
export const ACCEPTED = {
  'unit-test': { webWorkerTsConfig: { type: 'string', description: 'Accepted and ignored: the web worker TypeScript configuration is read from the build target.' } },
};
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Remove `default` from a node and everything below it. */
function stripDefaults(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(stripDefaults);
  delete node.default;
  for (const value of Object.values(node)) stripDefaults(value);
}

/** Fold `older` (a schema node of another major) into `united` (the accumulated node). */
function fold(united, older) {
  if (!united || !older || typeof united !== 'object' || typeof older !== 'object') return;
  if (!same(united.default, older.default)) delete united.default;
  if (united.properties || older.properties) {
    united.properties ??= {};
    const theirs = older.properties ?? {};
    for (const key of Object.keys(united.properties)) {
      if (key in theirs) fold(united.properties[key], theirs[key]);
      else stripDefaults(united.properties[key]); // only in the newer major
    }
    for (const key of Object.keys(theirs)) {
      if (key in united.properties) continue;
      united.properties[key] = clone(theirs[key]); // only in the older major
      stripDefaults(united.properties[key]);
    }
  }
  if (united.required || older.required) {
    const required = (united.required ?? []).filter((key) => (older.required ?? []).includes(key));
    if (required.length) united.required = required;
    else delete united.required;
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    if (!united[keyword] || !older[keyword]) continue;
    for (const alternative of older[keyword]) {
      const match = united[keyword].find((candidate) => candidate.type === alternative.type && (candidate.const ?? null) === (alternative.const ?? null) && (!!candidate.properties === !!alternative.properties));
      if (match) fold(match, alternative);
      else {
        const added = clone(alternative);
        stripDefaults(added);
        united[keyword].push(added);
      }
    }
  }
  if (united.items && older.items && !Array.isArray(united.items)) fold(united.items, older.items);
}

/**
 * @param {object[]} schemas the schemas of one builder, OLDEST FIRST (the newest is the base: its texts and definitions win)
 * @param {{ noDefaults?: boolean, accept?: Record<string, object> }} options `noDefaults`: no defaults at all and nothing required (unit-test,
 *   whose majors differ too much); `accept`: extra top-level options the wrapper takes although the official builder does not (it drops them)
 */
export function unionOf(schemas, { noDefaults = false, accept = {} } = {}) {
  const united = clone(schemas.at(-1));
  for (const older of schemas.slice(0, -1).reverse()) {
    // a property taken from an older major may point to a definition the newest schema no longer has
    for (const [key, definition] of Object.entries(older.definitions ?? {})) (united.definitions ??= {})[key] ??= clone(definition);
    fold(united, older);
  }
  if (noDefaults) {
    stripDefaults(united);
    const strip = (node) => {
      if (!node || typeof node !== 'object') return;
      delete node.required;
      Object.values(node).forEach(strip);
    };
    strip(united);
  }
  for (const [name, definition] of Object.entries(accept)) united.properties[name] ??= clone(definition);
  return united;
}
