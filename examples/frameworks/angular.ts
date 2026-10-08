import { DestroyRef, Injectable, inject } from '@angular/core';
import { signal } from '@angular/core';
import { PowerObserver } from 'performance-helpers/powerObserver';

@Injectable()
export class RequestState {
  private readonly destroyRef = inject(DestroyRef);
  private readonly observer = new PowerObserver(0, { distinct: true });
  readonly activeRequests = signal(this.observer.value);

  constructor() {
    const unsubscribe = this.observer.subscribe((next) => {
      this.activeRequests.set(next);
    });

    this.destroyRef.onDestroy(() => {
      unsubscribe();
      this.observer.dispose();
    });
  }

  started() {
    this.observer.value += 1;
  }

  finished() {
    this.observer.value -= 1;
  }
}
