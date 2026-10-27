// One shape for everything that can go wrong (Babel / unplugin-typegpu, esbuild, TypeScript), a printable form, and the replacement module
// written in place of a shader that failed to transform in watch mode.
import { relative, resolve } from 'node:path';

/**
 * @typedef {{ source: 'transform' | 'syntax' | 'types' | 'config', file?: string, line?: number, column?: number, text: string, lineText?: string, notes?: string[] }} Diagnostic
 * `file` is relative to the project root; `line` is 1-based, `column` 0-based.
 */

const stripFile = (text, path) => String(text).split('\n\n')[0].replace(path + ': ', '').replace(/ \(\d+:\d+\)(:)?$/, '');

/** A Babel / unplugin-typegpu failure. unplugin errors carry no position, so the candidate 'use gpu' lines are listed instead of invented. */
export function fromTransform(error, path, code, root) {
  const file = relative(root, path);
  const text = stripFile(error?.message ?? error, path);
  const loc = error?.loc;
  if (loc && typeof loc.line === 'number') {
    return { source: 'syntax', file, line: loc.line, column: loc.column, text, lineText: code.split(/\r?\n/)[loc.line - 1] ?? '' };
  }
  const lines = code.split(/\r?\n/).flatMap((line, i) => (/['"]use gpu['"]/.test(line) ? [i + 1] : []));
  return {
    source: 'transform',
    file,
    text,
    notes: [`Raised by unplugin-typegpu while transpiling a 'use gpu' function in this file${lines.length ? ` ('use gpu' directives at line ${lines.join(', ')})` : ''}.`],
  };
}

export function fromEsbuild(message, root) {
  const location = message.location;
  return {
    source: 'syntax',
    file: location ? relative(root, resolve(root, location.file)) : undefined,
    line: location?.line,
    column: location?.column,
    text: message.text,
    lineText: location?.lineText,
  };
}

export function fromTypeScript(ts, diagnostic, root) {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file) return { source: 'types', text: `TS${diagnostic.code}: ${text}` };
  const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start ?? 0);
  return {
    source: 'types',
    file: relative(root, diagnostic.file.fileName),
    line: line + 1,
    column: character,
    text: `TS${diagnostic.code}: ${text}`,
    lineText: diagnostic.file.text.split(/\r?\n/)[line] ?? '',
  };
}

export function formatDiagnostic(d) {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}${d.column !== undefined ? `:${d.column + 1}` : ''}` : ''}` : '';
  const lines = [`${where ? where + ' - ' : ''}error: ${d.text}`];
  if (d.lineText !== undefined && d.line) {
    const gutter = String(d.line);
    lines.push(`  ${gutter} | ${d.lineText}`);
    if (d.column !== undefined) lines.push(`  ${' '.repeat(gutter.length)} | ${' '.repeat(d.column)}^`);
  }
  for (const note of d.notes ?? []) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

/**
 * The value names a module exports, found by parsing its source (TypeScript's parser recovers from syntax errors, so this works for the
 * module that is being typed): `export const|let|var|function|class|enum|namespace`, `export { a, b as c }`, `export * as ns`, `export default`.
 * Type-only exports are left out (they have no value to import); `export * from` cannot be resolved here and is left out too.
 */
export function exportNames(ts, code, fileName = 'module.ts') {
  const names = new Set();
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const bindings = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindings(element.name);
  };
  for (const statement of sourceFile.statements) {
    const modifiers = (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined) ?? [];
    const has = (kind) => modifiers.some((m) => m.kind === kind);
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) if (!element.isTypeOnly) names.add(element.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) names.add(clause.name.text);
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) names.add('default');
    } else if (has(ts.SyntaxKind.ExportKeyword) && !has(ts.SyntaxKind.DeclareKeyword)) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindings(declaration.name);
      else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
        if (has(ts.SyntaxKind.DefaultKeyword)) names.add('default');
        else if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
      }
    }
  }
  return [...names];
}

/**
 * Written in place of a module whose transformation failed (watch/dev mode): it prints the message and, where there is a page (`document`),
 * shows it in a banner and throws when imported, so the failure is visible at once and the previous output is not silently used.
 *
 * On a server (no `document`: an SSR dev server) it only prints and does not throw: a dev server that has evaluated a module that throws on
 * import stays broken after the module is fixed (Vite/Angular SSR keep the failed evaluation), so the server would need a restart. There the
 * module exports every name the real one did (`names`), each a placeholder that throws the message when it is used; so the server renders
 * everything that does not use the broken shader, and nothing imports a name that is "always undefined" (which bundlers warn about).
 *
 * The next successful build replaces it.
 */
/** The id of the banner element: in the stub as written, and in the stub after esbuild has printed it (which drops its comments). */
const STUB_ID = 'typegpu-shaders-error';

/** Whether a generated module (as written to the output folder) is the stub of a failed one. */
export const isStub = (text) => text.includes(`"${STUB_ID}"`) && text.includes('TypeGPU shader build failed');

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function stubModule(message, names = []) {
  const exported = [...new Set(names)].filter((name) => name === 'default' || IDENTIFIER.test(name));
  const declarations = exported.map((name, i) => `var __e${i} = __failed(${JSON.stringify(name)});`);
  const specifiers = exported.filter((name) => name !== 'default').map((name) => `__e${exported.indexOf(name)} as ${name}`);
  const defaultIndex = exported.indexOf('default');
  return `// Generated by typegpu-shaders: the transformation of this module failed. It is replaced by the next successful build.
var message = ${JSON.stringify(message)};
console.error(message);
// What this module exported before is still importable; using it throws the message (a plain value would be undefined, silently wrong).
function __failed(name) {
  var fail = function () {
    throw new Error("TypeGPU shader build failed: cannot use \\"" + name + "\\".\\n\\n" + message);
  };
  return new Proxy(function () {}, {
    get: function (_, key) { return typeof key === "symbol" || key === "then" ? undefined : fail(); },
    apply: fail,
    construct: fail,
    set: fail,
    has: fail,
    deleteProperty: fail,
    defineProperty: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
  });
}
${declarations.join('\n')}
${specifiers.length ? `export { ${specifiers.join(', ')} };` : ''}
${defaultIndex >= 0 ? `export default __e${defaultIndex};` : ''}
if (typeof document !== "undefined") {
  var show = function () {
    var id = "${STUB_ID}";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("pre");
      el.id = id;
      el.setAttribute("role", "alert");
      el.style.cssText = "position:fixed;z-index:2147483647;left:0;right:0;top:0;margin:0;padding:16px 20px;max-height:50vh;overflow:auto;background:#7f1d1d;color:#fff;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,.4)";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = "TypeGPU shader build failed\\n\\n" + message + "\\n\\nFix the shader; the page reloads when the build succeeds.";
  };
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
  throw new Error(message);
}
`;
}
