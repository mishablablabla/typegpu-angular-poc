'use strict';
// Watching must agree with the official builder (options.js: `watch = options.watch ?? isTTY()`, and `ui` forces watch mode since Angular 21):
// a run it ends after one pass must get a one-shot shader build, which fails the command on a shader error.
const { isTTY, wrap } = require('./delegate.cjs');
module.exports = wrap({ stock: '@angular/build:unit-test', kind: 'test', schema: 'unit-test.json', watching: (options) => options.ui === true || (options.watch ?? isTTY()) });
