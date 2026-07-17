import { describe, expect, it } from 'vitest';
import { HISTORY_CAPACITY, createNavigator, type NavCandidate } from '../src/renderer/navigator';
import type { Playlist } from '../src/renderer/playlist';

/** Endless deterministic playlist; optional url → cluster id map (smart). */
function playlistOf(urls: readonly string[], clusters?: Readonly<Record<string, number>>): Playlist {
  let i = 0;
  return {
    size: urls.length,
    next: () => urls[i++ % urls.length],
    ...(clusters && { clusterOf: (url: string) => clusters[url] ?? null }),
  };
}

/** Ask for the next candidate and mark it shown (a successful load). */
function advance(nav: ReturnType<typeof createNavigator>): NavCandidate {
  const cand = nav.next();
  nav.shown(cand);
  return cand;
}

describe('navigator: history and forward/backward stepping', () => {
  it('pulls live items in playlist order and tracks the current one', () => {
    const nav = createNavigator(playlistOf(['a', 'b', 'c']));
    expect(nav.current).toBeNull();
    expect(advance(nav).url).toBe('a');
    expect(advance(nav).url).toBe('b');
    expect(nav.current).toBe('b');
  });

  it('prev walks back through shown items and returns null at the oldest', () => {
    const nav = createNavigator(playlistOf(['a', 'b', 'c']));
    advance(nav);
    advance(nav);
    advance(nav); // a b c shown
    const p1 = nav.prev()!;
    expect(p1.url).toBe('b');
    nav.shown(p1);
    const p2 = nav.prev()!;
    expect(p2.url).toBe('a');
    nav.shown(p2);
    expect(nav.prev()).toBeNull(); // at the oldest entry
    expect(nav.current).toBe('a');
  });

  it('after going back, next() replays forward history before pulling live', () => {
    const nav = createNavigator(playlistOf(['a', 'b', 'c']));
    advance(nav);
    advance(nav);
    advance(nav); // a b c
    nav.shown(nav.prev()!); // ← to b
    nav.shown(nav.prev()!); // ← to a
    expect(advance(nav).url).toBe('b'); // replay, not a live pull
    expect(advance(nav).url).toBe('c');
    expect(advance(nav).url).toBe('a'); // history exhausted → live again
  });

  it('a live pull while the cursor is behind truncates the forward tail', () => {
    const nav = createNavigator(playlistOf(['a', 'b', 'c', 'd']));
    advance(nav);
    advance(nav);
    advance(nav); // a b c
    nav.shown(nav.prev()!); // ← to b (c is the forward tail)
    // A moment skip (or any fresh show) records a live item mid-history:
    nav.shown({ url: 'z', index: null });
    expect(nav.current).toBe('z');
    // The old forward tail ('c') is gone — prev goes b, a:
    expect(nav.prev()!.url).toBe('b');
  });

  it('failed live candidates never enter history', () => {
    const nav = createNavigator(playlistOf(['a', 'b']));
    const bad = nav.next(); // 'a'
    nav.failed(bad);
    const good = nav.next(); // 'b'
    nav.shown(good);
    expect(nav.current).toBe('b');
    expect(nav.prev()).toBeNull(); // 'a' was never recorded
  });

  it('failed history candidates fall out of the buffer (deleted files)', () => {
    const nav = createNavigator(playlistOf(['a', 'b', 'c']));
    advance(nav);
    advance(nav);
    advance(nav); // a b c
    const back = nav.prev()!; // 'b'
    nav.failed(back); // b no longer loads
    const again = nav.prev()!;
    expect(again.url).toBe('a'); // b was dropped, a is next going back
    nav.shown(again);
    expect(advance(nav).url).toBe('c'); // forward replay also skips b now
  });

  it('is capped: the oldest entries fall off, the cursor stays consistent', () => {
    const urls = Array.from({ length: HISTORY_CAPACITY + 50 }, (_, i) => `u${i}`);
    const nav = createNavigator(playlistOf(urls));
    for (const _ of urls) advance(nav);
    expect(nav.current).toBe(`u${urls.length - 1}`);
    // Walk back: exactly HISTORY_CAPACITY - 1 steps are possible.
    let steps = 0;
    for (;;) {
      const cand = nav.prev();
      if (cand === null) break;
      nav.shown(cand);
      steps += 1;
    }
    expect(steps).toBe(HISTORY_CAPACITY - 1);
    expect(nav.current).toBe(`u${urls.length - HISTORY_CAPACITY}`);
  });
});

describe('navigator: moment navigation (smart clusters)', () => {
  // c1/c2/c3 form one moment, s is a single, d1/d2 the next moment.
  const clusters = { c1: 0, c2: 0, c3: 0, d1: 1, d2: 1 } as const;

  it('momentStart rewinds to the first shown item of the current moment', () => {
    const nav = createNavigator(playlistOf(['c1', 'c2', 'c3'], clusters));
    advance(nav);
    advance(nav);
    advance(nav); // moment fully shown, current = c3
    const start = nav.momentStart()!;
    expect(start.url).toBe('c1');
    nav.shown(start);
    // Auto-advance now replays the moment in shown order.
    expect(advance(nav).url).toBe('c2');
    expect(advance(nav).url).toBe('c3');
  });

  it('momentStart is null on singles, at the moment start, and in shuffle', () => {
    const smart = createNavigator(playlistOf(['s', 'c1'], clusters));
    advance(smart); // 's' — no cluster
    expect(smart.momentStart()).toBeNull();
    advance(smart); // 'c1' — in a cluster but the first shown item of it
    expect(smart.momentStart()).toBeNull();

    const shuffle = createNavigator(playlistOf(['a', 'b'])); // no clusterOf at all
    advance(shuffle);
    advance(shuffle);
    expect(shuffle.momentStart()).toBeNull();
  });

  it('momentStart does not rewind past an interleaved single', () => {
    const nav = createNavigator(playlistOf(['c1', 's', 'c2', 'c3'], clusters));
    for (let i = 0; i < 4; i++) advance(nav); // c1 s c2 c3
    // The contiguous run ending at c3 starts at c2 (s broke the run).
    expect(nav.momentStart()!.url).toBe('c2');
  });

  it('momentSkip pulls live items until the cluster changes', () => {
    const nav = createNavigator(playlistOf(['c1', 'c2', 'c3', 's', 'd1'], clusters));
    advance(nav); // current = c1 (cluster 0)
    const skip = nav.momentSkip()!;
    expect(skip.url).toBe('s'); // c2/c3 consumed and discarded
    expect(skip.index).toBeNull();
    nav.shown(skip);
    // The skipped-over items never entered history:
    expect(nav.prev()!.url).toBe('c1');
  });

  it('momentSkip is null on singles/shuffle (caller falls back to next)', () => {
    const smart = createNavigator(playlistOf(['s', 'c1'], clusters));
    advance(smart); // 's'
    expect(smart.momentSkip()).toBeNull();

    const shuffle = createNavigator(playlistOf(['a', 'b']));
    advance(shuffle);
    expect(shuffle.momentSkip()).toBeNull();
  });

  it('momentSkip gives up (null) when the whole library is one moment', () => {
    const all = { x1: 7, x2: 7, x3: 7 } as const;
    const nav = createNavigator(playlistOf(['x1', 'x2', 'x3'], all));
    advance(nav);
    expect(nav.momentSkip()).toBeNull(); // bounded by playlist.size attempts
  });
});
