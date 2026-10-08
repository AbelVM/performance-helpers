# Framework recipes

These recipes show a common UI workflow: cache a request, expose loading and
error state, and ignore results after the owner is gone. The cache is shared by
the feature; the reactive state belongs to the component or service.

The examples use `fetch` so they do not prescribe a framework HTTP client.
Replace it with `HttpClient`, a project fetch wrapper, or another promise-based
client as needed.

## React

```jsx
import { useEffect, useState } from 'react';
import { PowerCache } from 'performance-helpers/powerCache';

const profiles = new PowerCache({ maxEntries: 500, defaultTTL: 30_000 });

export function useProfile(id) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading', data: null, error: null });

    profiles
      .getOrSetAsync(`profile:${id}`, (signal) =>
        fetch(`/api/profiles/${id}`, { signal }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
      )
      .then((data) => current && setState({ status: 'ready', data, error: null }))
      .catch((error) => current && setState({ status: 'error', data: null, error }));

    return () => {
      current = false;
    };
  }, [id]);

  return state;
}
```

Keep `profiles` at the feature/provider lifetime. Dispose it when that owner is
removed, not when one consuming component unmounts.

## Vue

```js
import { onScopeDispose, ref, watch } from 'vue';
import { PowerCache } from 'performance-helpers/powerCache';

const profiles = new PowerCache({ maxEntries: 500, defaultTTL: 30_000 });

export function useProfile(id) {
  const state = ref({ status: 'loading', data: null, error: null });

  const stop = watch(
    id,
    (value, _oldValue, onCleanup) => {
      let current = true;
      onCleanup(() => {
        current = false;
      });
      state.value = { status: 'loading', data: null, error: null };

      profiles
        .getOrSetAsync(`profile:${value}`, (signal) =>
          fetch(`/api/profiles/${value}`, { signal }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
        )
        .then((data) => current && (state.value = { status: 'ready', data, error: null }))
        .catch((error) => current && (state.value = { status: 'error', data: null, error }));
    },
    { immediate: true }
  );

  onScopeDispose(stop);
  return state;
}
```

## Angular

```ts
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { PowerCache } from 'performance-helpers/powerCache';

type ProfileState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: unknown;
  error: unknown;
};

@Injectable({ providedIn: 'root' })
export class ProfileStore {
  private readonly destroyRef = inject(DestroyRef);
  private readonly profiles = new PowerCache({ maxEntries: 500, defaultTTL: 30_000 });
  private destroyed = false;
  readonly state = signal<ProfileState>({ status: 'idle', data: null, error: null });

  async load(id: string) {
    this.state.set({ status: 'loading', data: null, error: null });
    try {
      const data = await this.profiles.getOrSetAsync(`profile:${id}`, async (signal) => {
        const response = await fetch(`/api/profiles/${id}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      if (!this.destroyed) this.state.set({ status: 'ready', data, error: null });
    } catch (error) {
      if (!this.destroyed) this.state.set({ status: 'error', data: null, error });
    }
  }

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.profiles.dispose();
    });
  }
}
```

For a store shared by the whole application, `providedIn: 'root'` makes the
service the owner. For a route- or component-scoped provider, Angular owns the
service lifetime and the same teardown still applies.

## SSR request boundaries

Create request data and caches inside the server request boundary. A module-level
cache can leak one user's response into another user's render. Pass the request's
initial data into the client store so `getServerSnapshot` and the first hydrated
snapshot agree:

```js
import { PowerCache } from 'performance-helpers/powerCache';
import { PowerObserver } from 'performance-helpers/powerObserver';

export function createRequestProfileStore(initialProfile) {
  const profiles = new PowerCache({ maxEntries: 50, defaultTTL: 30_000 });
  const observer = new PowerObserver(
    { status: initialProfile ? 'ready' : 'idle', data: initialProfile, error: null },
    { distinct: true }
  );

  return {
    observer,
    load(id) {
      observer.value = { status: 'loading', data: observer.value.data, error: null };
      return profiles
        .getOrSetAsync(`profile:${id}`, () => fetch(`/api/profiles/${id}`).then((r) => r.json()))
        .then((data) => {
          observer.value = { status: 'ready', data, error: null };
          return data;
        })
        .catch((error) => {
          observer.value = { status: 'error', data: observer.value.data, error };
          throw error;
        });
    },
    dispose() {
      observer.dispose();
      profiles.dispose();
    },
  };
}
```

On the server, call `dispose()` after rendering the request. In the browser,
keep the store at the provider or route lifetime rather than recreating it on
every render.
