import { describe, expect, it } from 'vitest';
import { membershipVersion, onMembershipChange, publishMembershipChange } from './membershipSignal';

describe('membershipSignal', () => {
  it('bumps the version and calls every listener once per publish; an unsubscribed listener stays quiet', () => {
    const before = membershipVersion();
    const seen: number[] = [];
    const off = onMembershipChange(() => seen.push(membershipVersion()));
    publishMembershipChange();
    publishMembershipChange();
    expect(membershipVersion()).toBe(before + 2);
    expect(seen).toEqual([before + 1, before + 2]);
    off();
    publishMembershipChange();
    expect(seen).toEqual([before + 1, before + 2]);
    expect(membershipVersion()).toBe(before + 3);
  });
});
