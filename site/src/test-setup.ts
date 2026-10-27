// Runs before every spec (angular.json: test.options.setupFiles).
import { installConsoleGate } from './app/testing/console-gate';

installConsoleGate();
