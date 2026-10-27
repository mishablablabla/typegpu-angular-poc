import { type Rule, chain } from '@angular-devkit/schematics';
import { applyEdits, modify } from 'jsonc-parser';

/** The indentation a JSON file uses (the first indented line), two spaces when it has none. */
export const indentOf = (text: string) => /\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';

/** True for a file written with CRLF line endings throughout (the usual Windows checkout): it has some and no lone LF. */
export const isCrlf = (text: string) => text.includes('\r\n') && !/(^|[^\r])\n/.test(text);

type Json = unknown;
const isObject = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Sets `path` in a JSON text with the smallest possible edit: every other byte of the file (inline arrays, key order,
 * comments, line endings, indentation) stays as it was. A value `undefined` removes the key. `sorted`: a new key goes
 * to its alphabetical place among its siblings (dependency lists), not to the end.
 */
export function setJson(text: string, path: (string | number)[], value: Json, sorted = false): string {
  const indent = indentOf(text);
  const key = path[path.length - 1];
  const edits = modify(text, path, value, {
    formattingOptions: { insertSpaces: !indent.startsWith('\t'), tabSize: indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    ...(sorted && typeof key === 'string' ? { getInsertionIndex: (siblings: string[]) => { const at = siblings.findIndex((name) => name > key); return at < 0 ? siblings.length : at; } } : {}),
  });
  return applyEdits(text, edits);
}

/**
 * Re-applies the difference between two versions of a package.json to the ORIGINAL text. Angular's `addDependency` rewrites the
 * whole file with `JSON.stringify(manifest, null, 2)` (tabs and 4-space indentation become 2 spaces, inline arrays are
 * expanded, the final newline is dropped): the project's own formatting is kept instead, and the file changes where the setup changed it.
 */
function applyManifestChanges(original: string, current: string): string {
  let before: Json;
  let after: Json;
  try {
    before = JSON.parse(original);
    after = JSON.parse(current);
  } catch {
    return current;
  }
  if (!isObject(before) || !isObject(after)) return current;
  let text = original;
  const walk = (a: Record<string, Json>, b: Record<string, Json>, path: string[]) => {
    for (const [key, value] of Object.entries(b)) {
      if (!(key in a)) text = setJson(text, [...path, key], value, path.length === 1 && /ependencies$/.test(path[0]!));
      else if (JSON.stringify(a[key]) !== JSON.stringify(value)) {
        const old = a[key];
        if (path.length === 0 && isObject(old) && isObject(value)) walk(old, value, [key]);
        else text = setJson(text, [...path, key], value);
      }
    }
    for (const key of Object.keys(a)) if (!(key in b)) text = setJson(text, [...path, key], undefined);
  };
  walk(before, after, []);
  return text;
}

/**
 * The files a schematic edits by text keep their formatting: package.json keeps its indentation, inline arrays and final
 * newline (see applyManifestChanges), and a file that was CRLF before (the usual Windows checkout) is CRLF after: Angular's workspace
 * and dependency writers and our appends emit LF, which would leave mixed line endings (git shows the whole file changed, editors warn).
 */
const TRACKED = ['angular.json', 'package.json', '.gitignore'];

export function keepFormatting(rule: Rule): Rule {
  const crlf = new Set<string>();
  const noCr = new Set<string>();
  let manifest: string | undefined;
  const capture: Rule = (tree) => {
    crlf.clear();
    noCr.clear();
    manifest = tree.exists('package.json') ? tree.readText('package.json') : undefined;
    for (const file of TRACKED) {
      if (!tree.exists(file)) continue;
      const text = tree.readText(file);
      if (isCrlf(text)) crlf.add(file);
      else if (!text.includes('\r')) noCr.add(file);
    }
  };
  const restore: Rule = (tree) => {
    if (manifest !== undefined && tree.exists('package.json')) {
      const text = tree.readText('package.json');
      const kept = applyManifestChanges(manifest, text);
      if (kept !== text) tree.overwrite('package.json', kept);
    }
    for (const file of crlf) {
      if (!tree.exists(file)) continue;
      const text = tree.readText(file);
      const fixed = text.replace(/\r?\n/g, '\r\n');
      if (fixed !== text) tree.overwrite(file, fixed);
    }
    // A file without any CR stays without: Angular's workspace writer takes the platform's line ending (CRLF on Windows) when the file has
    // no line break to copy it from (a one-line angular.json), which would turn an LF file into a CRLF one.
    for (const file of noCr) {
      if (!tree.exists(file)) continue;
      const text = tree.readText(file);
      if (text.includes('\r\n')) tree.overwrite(file, text.replace(/\r\n/g, '\n'));
    }
  };
  return chain([capture, rule, restore]);
}
