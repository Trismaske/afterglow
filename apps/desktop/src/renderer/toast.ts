/**
 * One reused toast element — unobtrusive confirmation for flag actions.
 * Soak-safe: no DOM nodes or listeners accumulate; a single timer is
 * cleared and replaced on every show().
 */

export class Toast {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly durationMs: number,
  ) {}

  show(message: string): void {
    this.el.textContent = message;
    this.el.classList.add('visible');
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.classList.remove('visible');
      this.timer = null;
    }, this.durationMs);
  }
}
