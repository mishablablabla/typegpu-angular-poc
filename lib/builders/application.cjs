'use strict';
module.exports = require('./delegate.cjs').wrap({ stock: '@angular/build:application', kind: 'build', schema: 'application.json', watching: (options) => options.watch === true });
