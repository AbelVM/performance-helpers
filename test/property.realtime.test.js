import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 100);

describe('PowerRealtimeHub invariants (S2-10)', () => {
  it('publish returns a non-negative queued count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 8 }),
        (ids) => {
          const sent = [];
          const hub = new PowerRealtimeHub({
            send: (sub, frame) => {
              sent.push({ sub: sub.id, frame });
            },
          });
          const subs = [];
          for (const id of ids) {
            try {
              subs.push(hub.subscribe('topic', () => {}, { id }));
            } catch {
              /* duplicate id */
            }
          }
          const q = hub.publish('topic', { hello: 1 });
          expect(typeof q).toBe('number');
          expect(q).toBeGreaterThanOrEqual(0);
          hub.close();
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('presence count matches subscribed subscribers', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 0, maxLength: 6 }),
        (ids) => {
          const hub = new PowerRealtimeHub({ send: () => {} });
          for (const id of ids) hub.subscribe('topic', () => {}, { id });
          expect(hub.presence().length).toBe(ids.length);
          hub.close();
        }
      ),
      { numRuns: RUNS }
    );
  });
});
