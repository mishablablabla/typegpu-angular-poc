'use strict';
// `ng extract-i18n` bundles the application itself (it does not schedule the build target), so without this wrapper it would extract
// from whatever shader output is on disk, or fail when there is none (a clean checkout). It never watches: one shader build, then one extraction.
module.exports = require('./delegate.cjs').wrap({ stock: '@angular/build:extract-i18n', kind: 'extract-i18n', schema: 'extract-i18n.json', watching: () => false });
