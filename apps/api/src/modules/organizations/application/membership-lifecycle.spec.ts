import { describe, expect, it } from 'vitest';
import { MembershipLifecycle, type MembershipRemovalParticipant } from './membership-lifecycle';

const participant = (name: string): MembershipRemovalParticipant => ({
  name,
  onMembershipRemoved: () => Promise.resolve(),
});

describe('MembershipLifecycle (the participant registry)', () => {
  it('keeps participants in registration order and reports what is registered', () => {
    const lifecycle = new MembershipLifecycle();
    const [a, b] = [participant('a'), participant('b')];
    lifecycle.registerRemovalParticipant(a);
    lifecycle.registerRemovalParticipant(b);
    expect(lifecycle.participants()).toEqual([a, b]);
    expect(lifecycle.isRegistered('a')).toBe(true);
    expect(lifecycle.isRegistered('zzz')).toBe(false);
  });

  it('refuses a second participant with the same name', () => {
    const lifecycle = new MembershipLifecycle();
    lifecycle.registerRemovalParticipant(participant('projects'));
    expect(() => lifecycle.registerRemovalParticipant(participant('projects'))).toThrow(/already registered/);
  });

  it('is sealed when the application has bootstrapped: later registrations are refused with a clear message', () => {
    const lifecycle = new MembershipLifecycle();
    lifecycle.registerRemovalParticipant(participant('early'));
    lifecycle.onApplicationBootstrap();
    expect(() => lifecycle.registerRemovalParticipant(participant('late'))).toThrow(
      /"late" was registered after application bootstrap: the registry is sealed/,
    );
    expect(lifecycle.participants().map((entry) => entry.name)).toEqual(['early']);
  });

  it('hands out a copy, so a caller cannot change the registered set', () => {
    const lifecycle = new MembershipLifecycle();
    lifecycle.registerRemovalParticipant(participant('a'));
    (lifecycle.participants() as MembershipRemovalParticipant[]).push(participant('intruder'));
    expect(lifecycle.participants().map((entry) => entry.name)).toEqual(['a']);
  });
});
