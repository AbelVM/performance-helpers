import { describe, expect, it } from 'vitest';
import { PowerObserver } from '../src/helpers/powerObserver.js';

describe('framework SSR integration', () => {
  it('keeps the hydration snapshot stable and flushes scheduled updates deterministically', () => {
    const initial = { status: 'loading', data: null };
    const observer = new PowerObserver(initial);
    const seen = [];
    const unsubscribe = observer.subscribe((value) => seen.push(value));

    const serverSnapshot = observer.getServerSnapshot();
    expect(observer.getSnapshot()).toBe(serverSnapshot);

    observer.value = { status: 'ready', data: 'ok' };
    expect(seen).toEqual([]);
    observer.flush();

    expect(seen).toEqual([{ status: 'ready', data: 'ok' }]);
    unsubscribe();
    observer.dispose();
  });
});
