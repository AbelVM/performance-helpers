import { describe, it, expect } from 'vitest';
import PowerCircuit from '../src/helpers/powerCircuit.js';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerCircuit observability', () => {
  it('calls onStateChange callback when state transitions occur', async () => {
    const calls = [];
    const cb = new PowerCircuit({
      threshold: 1,
      timeout: 10,
      onStateChange: (s, r) => calls.push([s, r]),
    });

    // cause a failure to open the circuit
    await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {});

    // after one failure threshold=1 -> should open
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0][0]).toBe('open');
    expect(calls[0][1]).toBe('thresholdExceeded');

    // advance through timeout by waiting
    await new Promise((res) => setTimeout(res, 15));

    // next call should cause half-open then success -> closed
    await cb.call(() => Promise.resolve('ok'));

    // find closed event
    const closed = calls.find(([s]) => s === 'closed');
    expect(closed).toBeTruthy();
  });

  it('swallows errors thrown by onStateChange and event bus observers', async () => {
    const bus = new PowerEventBus();
    bus.on('stateChange', () => {
      throw new Error('bus observer failed');
    });

    const cb = new PowerCircuit({
      threshold: 1,
      timeout: 10,
      eventBus: bus,
      onStateChange() {
        throw new Error('callback failed');
      },
    });

    await expect(cb.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.state).toBe('open');
  });

  it('emits stateChange on provided PowerEventBus', async () => {
    const bus = new PowerEventBus();
    const events = [];
    bus.on('stateChange', (payload) => events.push(payload));

    const cb = new PowerCircuit({ threshold: 1, timeout: 10, eventBus: bus });

    await cb.call(() => Promise.reject(new Error('boom'))).catch(() => {});

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].state).toBe('open');
    expect(events[0].reason).toBe('thresholdExceeded');

    await new Promise((res) => setTimeout(res, 15));
    await cb.call(() => Promise.resolve('ok'));

    const closedEvent = events.find((e) => e.state === 'closed');
    expect(closedEvent).toBeTruthy();
  });
});
