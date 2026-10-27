'use strict';
module.exports = require('./delegate.cjs').wrap({ stock: '@angular/build:karma', kind: 'test', schema: 'karma.json', watching: (options) => options.watch !== false });
