import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installGpuProbe } from './browser-probe';

if (new URLSearchParams(location.search).has('probe')) {
  installGpuProbe();
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
