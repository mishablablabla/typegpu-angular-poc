import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from './icons';
import { SearchService } from './search.service';
import { ThemeService } from './theme.service';
import { ANGULAR_DOCS_ROUTE } from '../docs/docs-nav';
import { MobileNav } from './mobile-nav';
import { REPOSITORY_URL } from '../examples/repository';

@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive, Icon, MobileNav],
  host: { '(document:keydown.escape)': 'closeMenu()' },
  template: `
    <header class="header">
      <a class="logo" routerLink="/" aria-label="TypeGPU, home">
        <img class="mark dark" src="brand/typegpu-logomark-dark.svg" alt="" />
        <img class="mark light" src="brand/typegpu-logomark-light.svg" alt="" />
        <img class="full dark" src="brand/typegpu-logo-dark.svg" alt="TypeGPU" />
        <img class="full light" src="brand/typegpu-logo-light.svg" alt="TypeGPU" />
      </a>

      <nav class="nav" aria-label="Main navigation">
        <button type="button" class="search" (click)="search.show()" aria-label="Search">
          <app-icon name="search" class="search-icon" />
          <span class="search-label">Search</span>
          <kbd class="search-kbd">{{ shortcut }}</kbd>
        </button>
        <a class="link wide" [routerLink]="docsRoute" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }">Docs</a>
        <a class="link wide" routerLink="/examples" routerLinkActive="active">Examples</a>
        <a class="icon-link wide" [href]="repository" target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
          <app-icon name="github" />
        </a>
        <div class="theme wide" role="group" aria-label="Color theme">
          <button type="button" [class.on]="theme.theme() === 'light'" (click)="theme.set('light')" [attr.aria-pressed]="theme.theme() === 'light'" aria-label="Light theme"><app-icon name="sun" /></button>
          <button type="button" [class.on]="theme.theme() === 'dark'" (click)="theme.set('dark')" [attr.aria-pressed]="theme.theme() === 'dark'" aria-label="Dark theme"><app-icon name="moon" /></button>
        </div>
        <button type="button" class="menu-button" #menuButton (click)="menuOpen.set(!menuOpen())" [attr.aria-expanded]="menuOpen()" aria-controls="mobile-nav" aria-label="Navigation menu">
          <span class="burger" [class.open]="menuOpen()"></span>
        </button>
      </nav>
    </header>
    @if (menuOpen()) {
      <app-mobile-nav id="mobile-nav" (navigated)="menuOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: block;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      height: var(--sl-nav-height);
      padding-inline: 1rem;
      background: var(--header-bg);
      border-bottom: 1px solid var(--header-border);
      backdrop-filter: blur(24px);
    }
    @media (min-width: 601px) {
      .header { padding-inline: 1.875rem; }
    }
    @media (min-width: 1025px) {
      .header { padding-inline: 2.5rem; }
    }
    @media (min-width: 1441px) {
      .header { padding-inline: 3.125rem; }
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      color: var(--sl-color-white);
      text-decoration: none;
      flex: none;
    }
    .logo img { display: none; height: 2.25rem; width: auto; }
    .logo .full { height: 2rem; }
    :host-context([data-theme='dark']) .logo .dark, :host-context([data-theme='light']) .logo .light { display: block; }
    .logo .full { display: none !important; }
    @media (min-width: 800px) {
      .logo .mark { display: none !important; }
      :host-context([data-theme='dark']) .logo .full.dark, :host-context([data-theme='light']) .logo .full.light { display: block !important; }
    }
    .nav {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-left: auto;
      min-width: 0;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 2.5rem;
      height: 2.5rem;
      justify-content: center;
      padding: 0;
      border: 1px solid color-mix(in srgb, #33488e 24%, transparent);
      background: color-mix(in srgb, #f8f9ff 82%, transparent);
      color: #33488e;
      cursor: pointer;
      font-size: 0.875rem;
      transition: border-color 160ms ease, background-color 160ms ease;
    }
    :host-context([data-theme='dark']) .search {
      border-color: color-mix(in srgb, #c3c4f1 22%, transparent);
      background: color-mix(in srgb, #1b1f2c 70%, transparent);
      color: #edeff6;
    }
    .search:hover {
      border-color: var(--accent-600);
      background: #fff;
    }
    :host-context([data-theme='dark']) .search:hover {
      border-color: #c3c4f1;
      background: #1f2330;
    }
    .search-icon { font-size: 1rem; }
    .search-label, .search-kbd { display: none; }
    @media (min-width: 601px) {
      .search { width: 12rem; justify-content: flex-start; padding-inline: 0.75rem; }
      .search-label { display: inline; }
      .search-kbd { display: inline; margin-left: auto; }
    }
    @media (min-width: 1025px) {
      .search { width: 16rem; }
    }
    .search-kbd {
      font-family: var(--sl-font);
      font-size: 0.75rem;
      letter-spacing: 0.05em;
      opacity: 0.8;
    }
    .link {
      color: var(--link-header);
      font-weight: 500;
      padding-inline: 0.5rem;
      text-decoration: none;
      transition: color 150ms;
    }
    .link:hover, .link.active { color: var(--link-header-hover); }
    .icon-link {
      display: grid;
      place-items: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 9999px;
      color: var(--link-header);
      font-size: 1.25rem;
      transition: color 150ms;
    }
    .icon-link:hover { color: var(--link-header-hover); }
    .theme {
      display: grid;
      grid-template-columns: 1fr 1fr;
      width: 5rem;
      height: 2.5rem;
      margin-left: 0.75rem;
      overflow: hidden;
      border: 1px solid var(--link-header);
    }
    :host-context([data-theme='dark']) .theme { border-color: #f8f9ff; }
    :host-context([data-theme='light']) .theme { border-color: #001a72; }
    .theme button {
      display: grid;
      place-items: center;
      border: 0;
      background: transparent;
      cursor: pointer;
      font-size: 1.125rem;
      color: #001a72;
    }
    :host-context([data-theme='dark']) .theme button { color: #f8f9ff; }
    :host-context([data-theme='dark']) .theme button.on { background: #f8f9ff; color: #232736; }
    :host-context([data-theme='light']) .theme button.on { background: #001a72; color: #fff; }
    .menu-button {
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--link-header);
    }
    .burger, .burger::before, .burger::after {
      display: block;
      width: 1.25rem;
      height: 1px;
      background: currentColor;
      transition: transform 160ms ease;
    }
    .burger { position: relative; }
    .burger::before, .burger::after { position: absolute; content: ''; }
    .burger::before { transform: translateY(-0.375rem); }
    .burger::after { transform: translateY(0.375rem); }
    .burger.open { background: transparent; }
    .burger.open::before { transform: rotate(45deg); }
    .burger.open::after { transform: rotate(-45deg); }
    .wide { display: none; }
    @media (min-width: 800px) {
      .link.wide { display: block; }
      .icon-link.wide { display: grid; }
      .theme.wide { display: grid; }
      .menu-button { display: none; }
    }
  `,
})
export class SiteHeader {
  protected readonly search = inject(SearchService);
  protected readonly theme = inject(ThemeService);
  protected readonly menuOpen = signal(false);
  private readonly menuButton = viewChild<ElementRef<HTMLButtonElement>>('menuButton');
  protected readonly docsRoute = ANGULAR_DOCS_ROUTE;
  protected readonly repository = REPOSITORY_URL;
  protected readonly shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

  /** Escape closes the navigation drawer and gives focus back to the button that opened it. */
  protected closeMenu(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuButton()?.nativeElement.focus();
  }
}
