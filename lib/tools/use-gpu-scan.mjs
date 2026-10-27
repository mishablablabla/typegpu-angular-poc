// Shared by check-shader-bundle.mjs and typegpu-shaders.esbuild.mjs; dependency-free.
//
// `scanUseGpu(source)` finds the `'use gpu'` DIRECTIVES in JavaScript/TypeScript source: the string
// `'use gpu'` / `"use gpu"` as the first statement of a function body. Occurrences inside string literals,
// template literals, comments and regular expressions are not directives and are not reported. This is a
// small lexer, not a parser: it knows exactly enough JavaScript to tell code from text (strings, templates with
// nested `${}`, comments, regex-vs-division by the previous token).
//
// For every directive it also tells whether the function was wrapped by unplugin-typegpu, which emits
//   <ident>.f = <function expression>      (usually in parentheses: `$.f = (function name(t) {` /
// `$.f = ((value) => {`), inside `($ => ...set($.f = ..., { ast, externals }) && $.f)({})`. The wrapper is found by
// walking back from the directive's `{` over the parameter list to the `function` keyword (or the arrow), then
// over parentheses to `=` and `.f`.

const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const BLOCK_WORDS = new Set(['else', 'try', 'catch', 'finally', 'do']);
const isIdentChar = (c) => c !== undefined && (/[\w$]/.test(c) || c > '\u007f');
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿';

/**
 * @param {string} source
 * @returns {{ index: number, line: number, column: number, transformed: boolean, quote: string }[]}
 *   one entry per `'use gpu'` directive, in source order; `index` is the offset of the opening quote.
 */
export function scanUseGpu(source) {
  const found = [];
  const length = source.length;
  /** @type {('b' | 't')[]} brace stack: 'b' = `{` of code, 't' = `${` of a template literal */
  const braces = [];
  /** the token before each open `{` (parallel to `braces`): a `}` that closes a `{` after `:` may end a TypeScript type literal, not a block */
  const openedAfter = [];
  let closedTypeLiteral = false; // the `}` just seen closed a `{` that followed `:`
  let i = 0;
  let prev = ''; // kind of the previous significant token: 'word:<w>', 'num', 'str', 'regex', 'tpl', or the punctuator
  let prologue = false; // the previous tokens are `{` and zero or more directives with their `;`
  let sawDirective = false; // the token just before is a string in the prologue

  if (source.startsWith('#!')) while (i < length && source[i] !== '\n') i++;

  const nextSignificant = (from) => {
    let j = from;
    while (j < length) {
      const c = source[j];
      if (isSpace(c)) j++;
      else if (c === '/' && source[j + 1] === '/') while (j < length && source[j] !== '\n') j++;
      else if (c === '/' && source[j + 1] === '*') {
        const end = source.indexOf('*/', j + 2);
        j = end < 0 ? length : end + 2;
      } else break;
    }
    return j;
  };

  /** Reads template characters from `i` (just after a backtick or a closing `}` of `${}`) up to the end or the next `${`. */
  const readTemplate = () => {
    while (i < length) {
      const c = source[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        return;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        braces.push('t');
        openedAfter.push('${');
        return;
      } else i++;
    }
  };

  /**
   * The `{` at `at` follows the `)` of `if (...)`, `for (...)`, `while (...)`, `switch (...)`, `with (...)` or `catch (...)`: a block, not a
   * function body.
   */
  const isControlHead = (at) => {
    let j = at - 1;
    while (j > 0 && isSpace(source[j])) j--;
    if (source[j] !== ')') return false;
    let depth = 0;
    for (let steps = 0; j >= 0 && steps < 50_000; j--, steps++) {
      if (source[j] === ')') depth++;
      else if (source[j] === '(' && --depth === 0) break;
    }
    if (depth !== 0) return false;
    j--;
    while (j >= 0 && isSpace(source[j])) j--;
    const end = j + 1;
    while (j >= 0 && isIdentChar(source[j])) j--;
    return /^(?:if|for|while|switch|with|catch)$/.test(source.slice(j + 1, end));
  };

  while (i < length) {
    const c = source[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < length && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      const end = i;
      if (source[i] === c) i++;
      const text = source.slice(start + 1, end);
      if (prologue && text === 'use gpu' && source[end] === c) {
        const after = nextSignificant(i);
        // `;`, `}` or the end of the line (ASI) end the statement; `:` / `,` / `.` / operators mean it is not one
        const newline = /\n/.test(source.slice(i, after));
        if (after >= length || source[after] === ';' || source[after] === '}' || (newline && !/[.,:?=+\-*/%<>&|^([]/.test(source[after]))) {
          found.push({ index: start, quote: c, ...position(source, start) });
        }
      }
      sawDirective = prologue;
      prev = 'str';
      continue;
    }
    if (c === '`') {
      i++;
      readTemplate();
      prev = 'tpl';
      prologue = sawDirective = false;
      continue;
    }
    if (c === '{') {
      braces.push('b');
      openedAfter.push(prev);
      // A directive prologue exists only at the start of a FUNCTION body. A block is not one: the `{` of `if (x) {`, `for (...) {`,
      // `else {`, `try {`, `catch {`, `finally {`, `do {`, a labelled or `case` block, a bare block after `;`, `{`, a block's `}` or at the start of
      // the text. Everything else (`) {` of a parameter list, `=> {`, `): number {`, a class member) may be a function body, and is one here:
      // missing a directive would be silent, reporting one that is not a function's is not.
      const block =
        prev === '' || prev === '{' || prev === ';' || prev === ':' || (prev === '}' && !closedTypeLiteral) || (prev === ')' && isControlHead(i)) || (prev.startsWith('word:') && BLOCK_WORDS.has(prev.slice(5)));
      i++;
      prev = '{';
      prologue = !block;
      sawDirective = false;
      continue;
    }
    if (c === '}') {
      i++;
      closedTypeLiteral = openedAfter.pop() === ':';
      if (braces.pop() === 't') {
        readTemplate();
        prev = 'tpl';
      } else prev = '}';
      prologue = sawDirective = false;
      continue;
    }
    if (c === ';') {
      i++;
      // a `;` right after a directive keeps the prologue open; any other `;` closes it
      prologue = sawDirective;
      sawDirective = false;
      prev = ';';
      continue;
    }
    if (c === '/') {
      // regex literal or division: by the previous token, and a regex never spans lines
      const isDivision =
        prev === 'num' || prev === 'str' || prev === 'tpl' || prev === 'regex' || prev === ')' || prev === ']' || prev === '}' ||
        (prev.startsWith('word:') && !REGEX_AFTER_WORD.has(prev.slice(5))) ||
        ((prev === '+' || prev === '-') && source[i - 1] === prev && /[+-]/.test(source[i - 2] ?? ''));
      let regexEnd = -1;
      if (!isDivision) {
        let j = i + 1;
        let inClass = false;
        for (; j < length && source[j] !== '\n'; j++) {
          const r = source[j];
          if (r === '\\') j++;
          else if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) {
            regexEnd = j;
            break;
          }
        }
      }
      if (regexEnd >= 0) {
        i = regexEnd + 1;
        while (isIdentChar(source[i])) i++;
        prev = 'regex';
      } else {
        i++;
        prev = '/';
      }
      prologue = sawDirective = false;
      continue;
    }
    if (isIdentChar(c)) {
      let j = i + 1;
      while (isIdentChar(source[j])) j++;
      const word = source.slice(i, j);
      prev = /^\d/.test(word) ? 'num' : `word:${word}`;
      i = j;
      prologue = sawDirective = false;
      continue;
    }
    prev = c;
    i++;
    prologue = sawDirective = false;
  }

  for (const directive of found) directive.transformed = isWrapped(source, directive.index);
  return found;
}

function position(source, index) {
  let line = 1;
  let lineStart = 0;
  for (let at = source.indexOf('\n'); at >= 0 && at < index; at = source.indexOf('\n', at + 1)) {
    line++;
    lineStart = at + 1;
  }
  return { line, column: index - lineStart + 1 };
}

/** Is the function whose body starts with the directive at `index` the right-hand side of `<ident>.f = ...`? */
function isWrapped(source, index) {
  const skipSpaceBack = (from) => {
    let j = from;
    while (j > 0 && isSpace(source[j - 1])) j--;
    return j;
  };
  const wordBefore = (from) => {
    let j = from;
    while (j > 0 && isIdentChar(source[j - 1])) j--;
    return [source.slice(j, from), j];
  };
  /** `from` is just after a `)`: returns the index of its matching `(` (strings in default values are not understood). */
  const matchParenBack = (from) => {
    let depth = 0;
    for (let j = from - 1, steps = 0; j >= 0 && steps < 50_000; j--, steps++) {
      if (source[j] === ')') depth++;
      else if (source[j] === '(' && --depth === 0) return j;
    }
    return -1;
  };

  let at = skipSpaceBack(index);
  if (source[at - 1] !== '{') return false;
  at = skipSpaceBack(at - 1);

  let head; // index where the function head (`async function f(...)` / `async (...) =>`) starts
  if (source[at - 1] === '>' && source[at - 2] === '=') {
    // arrow: `(a, b) =>` or `a =>`
    at = skipSpaceBack(at - 2);
    if (source[at - 1] === ')') {
      const open = matchParenBack(at);
      if (open < 0) return false;
      head = open;
    } else {
      const [word, start] = wordBefore(at);
      if (!word) return false;
      head = start;
    }
    const before = skipSpaceBack(head);
    const [word, start] = wordBefore(before);
    if (word === 'async') head = start;
  } else if (source[at - 1] === ')') {
    // `function name(params)` / `function (params)` / `function* name(params)`
    const open = matchParenBack(at);
    if (open < 0) return false;
    at = skipSpaceBack(open);
    let [word, start] = wordBefore(at);
    if (word !== 'function') {
      at = skipSpaceBack(start); // `word` was the function's name
      if (source[at - 1] === '*') at = skipSpaceBack(at - 1);
      [word, start] = wordBefore(at);
      if (word !== 'function') return false;
    }
    head = start;
    const before = skipSpaceBack(head);
    const [prefix, prefixStart] = wordBefore(before);
    if (prefix === 'async') head = prefixStart;
  } else {
    return false;
  }

  at = skipSpaceBack(head);
  while (source[at - 1] === '(') at = skipSpaceBack(at - 1); // `$.f = (function ...` / `$.f = ((x) => ...`
  if (source[at - 1] !== '=' || source[at - 2] === '=' || source[at - 2] === '!' || source[at - 2] === '<' || source[at - 2] === '>') return false;
  at = skipSpaceBack(at - 1);
  return /[\w$]\s*\.\s*f$/.test(source.slice(Math.max(0, at - 80), at));
}
