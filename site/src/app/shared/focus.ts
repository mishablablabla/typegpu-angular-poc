/** The id of the `<main>` landmark of every page: the target of the skip link and of "focus the page" after a search. */
export const MAIN_ID = 'main-content';

/** Moves focus to the page content (the `<main>` has `tabindex="-1"`), without scrolling. */
export function focusMain(options: FocusOptions = { preventScroll: true }): void {
  document.getElementById(MAIN_ID)?.focus(options);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `container`: from the last element it wraps to the first and the other way round. */
export function trapTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
