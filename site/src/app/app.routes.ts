import { Routes } from '@angular/router';
import { ANGULAR_DOCS_ROUTE } from './docs/docs-nav';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: ANGULAR_DOCS_ROUTE.slice(1) },
  { path: 'docs', pathMatch: 'full', redirectTo: ANGULAR_DOCS_ROUTE.slice(1) },
  {
    path: ANGULAR_DOCS_ROUTE.slice(1),
    title: '@typegpu/angular | TypeGPU',
    loadComponent: () => import('./docs/pages/angular-docs').then((m) => m.AngularDocs),
  },
  {
    path: 'examples',
    loadComponent: () => import('./examples/examples-layout').then((m) => m.ExamplesLayout),
    children: [
      { path: '', title: 'Examples | TypeGPU', loadComponent: () => import('./examples/example-gallery').then((m) => m.ExampleGallery) },
      { path: ':id', loadComponent: () => import('./examples/example-page').then((m) => m.ExamplePage) },
    ],
  },
  { path: '**', title: 'Page not found | TypeGPU', loadComponent: () => import('./not-found').then((m) => m.NotFound) },
];
