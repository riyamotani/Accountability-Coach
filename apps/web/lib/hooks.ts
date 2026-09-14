'use client';

import { useSyncExternalStore } from 'react';

/** This value never changes while the page is open, so nothing to subscribe to. */
const neverChanges = () => () => {};

/**
 * The device's timezone, read from the OS via the browser (NOT IP geolocation).
 *
 * Why useSyncExternalStore rather than useState + useEffect: the value only
 * exists on the client, so a naive read during render would make the
 * server-rendered HTML disagree with the client's first render (a hydration
 * mismatch), while reading it in an effect and calling setState triggers a
 * second render pass on every mount — which React 19's
 * `react-hooks/set-state-in-effect` rule flags, correctly.
 *
 * useSyncExternalStore exists precisely for "read a value that lives outside
 * React, and give the server a different snapshot than the client." It takes
 * both snapshots as separate arguments, so there's no mismatch and no extra
 * render.
 */
export function useDetectedTimezone(): string {
  return useSyncExternalStore(
    neverChanges,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => '', // server snapshot — the server has no device timezone to report
  );
}
