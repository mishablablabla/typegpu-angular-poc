'use strict';
// `ng serve --no-watch` serves one build and rebuilds nothing, so the shaders are built once too (a failing shader then fails the command)
module.exports = require('./delegate.cjs').wrap({ stock: '@angular/build:dev-server', kind: 'serve', schema: 'dev-server.json', watching: (options) => options.watch !== false });
