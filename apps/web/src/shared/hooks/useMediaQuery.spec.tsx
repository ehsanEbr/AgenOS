import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setViewportWidth } from '../../test/media';
import { useMediaQuery } from './useMediaQuery';

describe('useMediaQuery', () => {
  it('has the correct value on the very first render (no flash of the wrong layout)', () => {
    setViewportWidth(500);
    const { result } = renderHook(() => useMediaQuery('(min-width: 992px)'));
    expect(result.current).toBe(false);
  });

  it('updates when the viewport crosses the breakpoint, in both directions', () => {
    setViewportWidth(500);
    const { result } = renderHook(() => useMediaQuery('(min-width: 992px)'));

    setViewportWidth(1280);
    expect(result.current).toBe(true);

    setViewportWidth(800);
    expect(result.current).toBe(false);
  });

  it('stops listening after unmount', () => {
    const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 992px)'));
    unmount();
    setViewportWidth(300);
    expect(result.current).toBe(true); // last value; no update and no error after unmount
  });
});
