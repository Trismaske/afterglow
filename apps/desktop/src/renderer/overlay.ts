/**
 * The path/date overlay: subtle, TV-legible, bottom-left (inset for
 * overscan). Three fixed child elements are reused for every slide —
 * nothing accumulates over a long show.
 */

import type { ItemInfo } from '../shared/api';
import { overlayDateLine, splitPath } from './format';

export class Overlay {
  private readonly nameEl: HTMLElement;
  private readonly dirEl: HTMLElement;
  private readonly dateEl: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    const mk = (className: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = className;
      root.appendChild(el);
      return el;
    };
    this.nameEl = mk('overlay-name');
    this.dirEl = mk('overlay-dir');
    this.dateEl = mk('overlay-date');
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /** Update the text; null (metadata unavailable) clears it. */
  update(info: ItemInfo | null): void {
    if (!info) {
      this.nameEl.textContent = '';
      this.dirEl.textContent = '';
      this.dateEl.textContent = '';
      return;
    }
    const { dir, name } = splitPath(info.path);
    this.nameEl.textContent = name;
    this.dirEl.textContent = dir;
    this.dateEl.textContent = overlayDateLine(info.captureDateMs, info.fileDateMs);
  }
}
