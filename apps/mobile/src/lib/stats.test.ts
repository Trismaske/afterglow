/** Stats activity-window geometry: scaling, goal line, headline counts. */
import { describe, expect, it } from 'vitest';
import { activityWindow, intakeWindow } from './stats';

const days = (counts: Record<string, number>) => new Map(Object.entries(counts));
// Calendar sequence ending at "today" (d5), oldest FIRST.
const keys = ['d1', 'd2', 'd3', 'd4', 'd5'];

describe('activityWindow', () => {
  it('scales bars against the best day when it beats the goal', () => {
    const w = activityWindow(days({ d1: 25, d3: 100, d5: 50 }), keys, 50);
    expect(w.bars.map((b) => b.count)).toEqual([25, 0, 100, 0, 50]);
    expect(w.bars.map((b) => b.height)).toEqual([0.25, 0, 1, 0, 0.5]);
    expect(w.best).toBe(100);
    expect(w.goalLine).toBe(0.5);
  });

  it('scales against the goal when no day reached it', () => {
    const w = activityWindow(days({ d2: 10, d5: 20 }), keys, 50);
    expect(w.bars.map((b) => b.height)).toEqual([0, 0.2, 0, 0, 0.4]);
    expect(w.goalLine).toBe(1);
    expect(w.goalDays).toBe(0);
  });

  it('counts totals, active days, goal days, and marks today', () => {
    const w = activityWindow(days({ d1: 60, d2: 3, d4: 50, d5: 7 }), keys, 50);
    expect(w.total).toBe(120);
    expect(w.activeDays).toBe(4);
    expect(w.goalDays).toBe(2);
    expect(w.bars.map((b) => b.goalReached)).toEqual([true, false, false, true, false]);
    expect(w.bars.map((b) => b.isToday)).toEqual([false, false, false, false, true]);
  });

  it('survives an empty window and an all-zero one', () => {
    const empty = activityWindow(new Map(), [], 50);
    expect(empty).toMatchObject({ bars: [], total: 0, activeDays: 0, goalDays: 0, best: 0 });
    const quiet = activityWindow(new Map(), keys, 50);
    expect(quiet.bars.every((b) => b.height === 0)).toBe(true);
    expect(quiet.goalLine).toBe(1);
  });

  it('ignores negative counts and a non-positive goal', () => {
    const w = activityWindow(days({ d1: -5, d5: 4 }), keys, 0);
    expect(w.bars.map((b) => b.count)).toEqual([0, 0, 0, 0, 4]);
    expect(w.goalLine).toBe(0);
    expect(w.goalDays).toBe(0);
  });
});

describe('intakeWindow', () => {
  it('puts both series on ONE scale so the comparison is honest', () => {
    const w = intakeWindow(days({ d1: 40, d3: 10, d5: 20 }), days({ d1: 5, d2: 20, d5: 20 }), keys);
    // The tallest thing anywhere (40 shot on d1) sets the divisor for
    // BOTH series — a per-series scale would draw 5 decisions as tall as
    // 40 photos and answer the opposite question.
    expect(w.pairs.map((p) => p.capturedHeight)).toEqual([1, 0, 0.25, 0, 0.5]);
    expect(w.pairs.map((p) => p.reviewedHeight)).toEqual([0.125, 0.5, 0, 0, 0.5]);
  });

  it('reports the window totals and which way they lean', () => {
    const behind = intakeWindow(days({ d1: 40, d2: 40 }), days({ d1: 10 }), keys);
    expect(behind.captured).toBe(80);
    expect(behind.reviewed).toBe(10);
    expect(behind.net).toBe(-70);
    const ahead = intakeWindow(days({ d1: 5 }), days({ d2: 30 }), keys);
    expect(ahead.net).toBe(25);
  });

  it('survives an empty window without dividing by zero', () => {
    const w = intakeWindow(days({}), days({}), keys);
    expect(w.pairs.every((p) => p.capturedHeight === 0 && p.reviewedHeight === 0)).toBe(true);
    expect(w.net).toBe(0);
  });
});
