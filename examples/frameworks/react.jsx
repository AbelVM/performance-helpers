import { useSyncExternalStore } from 'react';
import { PowerObserver } from 'performance-helpers/powerObserver';

// Put shared state at the provider or feature boundary, not in render.
const activeRequests = new PowerObserver(0, { distinct: true });

export function useActiveRequests() {
  return useSyncExternalStore(
    activeRequests.subscribe.bind(activeRequests),
    activeRequests.getSnapshot.bind(activeRequests),
    activeRequests.getServerSnapshot.bind(activeRequests)
  );
}

export function requestStarted() {
  activeRequests.value += 1;
}

export function requestFinished() {
  activeRequests.value -= 1;
}

// If the component owns the observer instead, dispose it from the owner effect.
// Do not dispose this shared observer when an individual component unmounts.
