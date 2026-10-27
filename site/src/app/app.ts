import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SearchDialog } from './shell/search-dialog';
import { SiteHeader } from './shell/site-header';
import { MAIN_ID, focusMain } from './shared/focus';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SiteHeader, SearchDialog],
  template: `
    <a class="skip-link" [href]="'#' + mainId" (click)="skip($event)">Skip to content</a>
    <app-site-header />
    <router-outlet />
    <app-search-dialog />
  `,
})
export class App {
  protected readonly mainId = MAIN_ID;

  /** A plain `#id` link would be resolved against the base href and leave the page: move focus (and the view) there instead. */
  protected skip(event: Event): void {
    event.preventDefault();
    focusMain({});
  }
}
