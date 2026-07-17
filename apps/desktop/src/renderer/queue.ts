/**
 * Queue window renderer: lists flagged photos (newest first) with per-row
 * Reveal / Open / Remove actions. The list is fully re-rendered on every
 * change — it's a small window over a small queue, simplicity wins.
 */

import type { QueueEntry } from '../shared/api';
import { formatDateTime, splitPath } from './format';

const listEl = document.getElementById('list') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;

function render(entries: QueueEntry[]): void {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  listEl.textContent = '';
  countEl.textContent =
    sorted.length === 0 ? '' : sorted.length === 1 ? '1 photo' : `${sorted.length} photos`;

  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'Nothing flagged yet. During the show, press D (delete), E (edit), M (move), R (review), N (rename) or T (date fix) to flag the photo on screen.';
    listEl.appendChild(empty);
    return;
  }

  for (const entry of sorted) {
    listEl.appendChild(row(entry));
  }
}

function row(entry: QueueEntry): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'row';

  const badge = document.createElement('span');
  badge.className = `badge badge-${entry.flagType}`;
  badge.textContent = entry.flagType;
  rowEl.appendChild(badge);

  const { dir, name } = splitPath(entry.path);
  const item = document.createElement('div');
  item.className = 'item';
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;
  nameEl.title = entry.path;
  const dirEl = document.createElement('div');
  dirEl.className = 'dir';
  dirEl.textContent = dir;
  item.append(nameEl, dirEl);
  rowEl.appendChild(item);

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = formatDateTime(entry.at);
  rowEl.appendChild(when);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Reveal', () => {
      void window.afterglowQueue.reveal(entry.path);
    }),
    button('Open', () => {
      void window.afterglowQueue.open(entry.path).then((err) => {
        if (err) console.warn(`[afterglow] open failed: ${err}`);
      });
    }),
    button('Remove', () => {
      void window.afterglowQueue.remove(entry.path, entry.flagType).then(render);
    }),
  );
  rowEl.appendChild(actions);

  return rowEl;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key.toLowerCase() === 'q') {
    window.afterglowQueue.close();
  }
});

window.afterglowQueue.onChanged(render);
void window.afterglowQueue.list().then(render);
