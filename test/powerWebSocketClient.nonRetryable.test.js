import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';

/**
 * RT-014 — `nonRetryableCloseCodes`.
 *
 * The defect this row names is a *stampede*, not a failure: a `1008` (policy
 * violation), `1001` (going away) or `1002` (protocol error) close is the same
 * answer for every client of a service, delivered at the same moment, so
 * decorrelated-jitter backoff has nothing to decorrelate. It spreads the retries
 * *after* the decision, not the decision. The client reconnected to a peer that
 * had already decided to stop answering, forever.
 *
 * ## What the option deliberately does not do
 *
 * It does not become a default. `[]` keeps every existing behaviour, including
 * reconnecting on a 1008 — see the default test below, which is the one most
 * likely to be quietly wrong, because "the option works" and "the option is
 * inert" look identical from the outside unless you also assert the reconnect
 * that *should* still happen.
 *
 * It is also **not** a `shouldReconnect` callback. The row ships the list first
 * and defers the callback, and `rg shouldReconnect src/` finds **nothing** —
 * the review row's own note says "`rg` → 0 matches", which is how it was
 * verified here too. So "a user callback cannot re-enable a non-retryable code"
 * is asserted against the hooks that *do* exist (`onClose`, and the built-in
 * reconnect inputs), because that is the property the check's placement has to
 * hold for the callback to be addable later without changing anyone's behaviour.
 *
 * ## Harness
 *
 * `FakeSocket` and `mkClient` are copied from `powerWebSocketClient.test.js`
 * rather than re-invented: this needs a socket whose close delivers a real
 * `close` event carrying a `code`, and a list of every socket the client
 * constructs — which *is* the reconnect counter, counted at the transport
 * instead of inferred from a timer. One deliberate divergence, documented on
 * `_fireEvent` below: the copied `_fire` cannot deliver an event the client can
 * read a close code off.
 */

/** A WebSocket double with manually driven lifecycle and a settable buffer. */
class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.pings = 0;
    this.closedWith = null;
    this._handlers = new Map();
  }
  addEventListener(type, fn) {
    const list = this._handlers.get(type) || [];
    list.push(fn);
    this._handlers.set(type, list);
  }
  _fire(type, data) {
    const ev = { type, data };
    for (const fn of this._handlers.get(type) || []) fn(ev);
    const prop = `on${type}`;
    if (typeof this[prop] === 'function') this[prop](ev);
  }
  /**
   * Fire an event whose object **is** the event, rather than wrapping a payload.
   *
   * **This is not a convenience, and the difference is load-bearing.** `_fire`
   * hands handlers `{type, data}` — right for `message`, where `.data` is the
   * payload, and wrong for `close`, where the client reads `event.code` off the
   * event itself. Delivered through `_fire`, a code arrives as `event.data.code`
   * and `event.code` is `undefined`, so **the client cannot see any close code
   * at all**. The existing websocket tests pass codes anyway (`close(1006, …)`,
   * `_fire('close', {code: 1006})`) and they pass, because nothing that exists
   * reads the code — so the fake was never wrong, only untested against. RT-014
   * is the first behaviour here that depends on it, so the real event shape has
   * to be delivered at least once, and it is delivered through this method.
   */
  _fireEvent(type, event) {
    for (const fn of this._handlers.get(type) || []) fn(event);
    const prop = `on${type}`;
    if (typeof this[prop] === 'function') this[prop](event);
  }
  open() {
    this.readyState = 1;
    this._fire('open');
  }
  send(frame) {
    this.sent.push(frame);
  }
  /**
   * Close the way a peer does: a `close` event carrying its code, which the
   * client can read.
   *
   * Distinct from the client's own `close()` below, which records what it was
   * asked for in `closedWith` — a test that wants a *peer* close with a code
   * calls this, so the two cannot be mistaken for one another.
   */
  peerClose(code, reason) {
    this.readyState = 3;
    this._fireEvent('close', { type: 'close', code, reason });
  }
  /**
   * The client's own close. Also delivers a readable event, so that a test can
   * tell "the gate ran and declined" from "the gate never saw the code" — see
   * the `_fireEvent` note.
   */
  close(code, reason) {
    this.closedWith = [code, reason];
    this.readyState = 3;
    this._fireEvent('close', { type: 'close', code, reason });
  }
  ping() {
    this.pings += 1;
  }
}

const mkClient = (options = {}) => {
  const created = [];
  const client = new PowerWebSocketClient({
    url: 'ws://test/',
    WebSocketImpl: class extends FakeSocket {
      constructor(u, p) {
        super(u, p);
        created.push(this);
      }
    },
    heartbeatIntervalMs: 0,
    reconnectBaseMs: 10,
    reconnectMaxMs: 10,
    ...options,
  });
  return { client, created };
};

/**
 * Connect, open the socket, and hand the test the live socket.
 *
 * The socket is opened before returning because every close in this file has to
 * arrive on an **open** connection: a close delivered while `connect()` is still
 * pending settles the connect promise (RT-001) and is not the path under test.
 */
async function openClient(options = {}) {
  const { client, created } = mkClient(options);
  const p = client.connect();
  created[0].open();
  await p;
  return { client, socket: created[0], created };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RT-014: a declared non-retryable close code does not reconnect', () => {
  it('stops on a matching code and leaves the client terminally closed', async () => {
    // The row's own symptom, asserted as counters and shapes: 1008 is the code
    // named in the review row, and before this option the client answered it
    // with a reconnect — forever, and in lockstep with every other client.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });
    const closes = [];
    client.on('close', (e) => closes.push(e));

    socket.peerClose(1008, 'policy violation');

    // The close event still fires — this option suppresses the *reconnect*, not
    // the notification. A caller whose `onClose` performs its own cleanup must
    // still hear about it.
    expect(closes.length, 'the close event is not swallowed').toBe(1);
    expect(closes[0].code, 'and carries the code the peer sent').toBe(1008);
    expect(client.readyState, 'and the client is closed').toBe(3);
    expect(client.isOpen).toBe(false);

    // Advance well past `reconnectMaxMs`, so any armed backoff would have fired.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(created.length, 'no socket was constructed, so nothing reconnected').toBe(1);
    expect(client.stats().reconnects, 'and no attempt was counted').toBe(0);
    expect(client.stats().reconnectAttempts).toBe(0);
    // Not one of the two bounds ran out, so `null` here would be the honest
    // answer a caller gets with the default `[]` — this is what makes the
    // declared code distinguishable from "nothing was configured".
    expect(client.stats().reconnectExhaustedBy, 'the close code is the reason').toBe('close-code');
    client.close();
  });

  it('does not consume an attempt, so the budget is untouched', async () => {
    // **Ordering, not the gate.** The check runs before `_scheduleReconnect`,
    // which is what keeps `_reconnectAttempts` at 0 and — the part worth
    // pinning — before `_reconnectStartedAt` is stamped. A close that starts the
    // elapsed clock and then declines to reconnect has spent budget on an outage
    // it never retried, so the next `connect()` inherits a window that is
    // already partly gone.
    vi.useFakeTimers();
    const { client, socket } = await openClient({
      nonRetryableCloseCodes: [1001],
      maxReconnectElapsedMs: 100,
    });

    socket.peerClose(1001, 'going away');

    expect(client._reconnectStartedAt, 'no reconnect run was ever begun').toBe(null);
    expect(client._reconnectAttempts).toBe(0);

    // And the budget is whole: a deliberate reconnect after a non-retryable
    // close is not penalised by the close that preceded it.
    const deliberate = client.connect();
    // Left pending on purpose — a socket is never opened, so the only thing that
    // can settle it is the `client.close()` below, which rejects it with the
    // close event (RT-001). Marking it handled is what keeps that from surfacing
    // as an unhandled rejection at the end of the file; opening the socket would
    // reset `_reconnectStartedAt` and hide the assertion above.
    deliberate.catch(() => {});
    expect(client._reconnectStartedAt, 'a fresh connect starts its own run').toBe(null);
    client.close();
  });

  it('is not latched: a deliberate connect() after a non-retryable close works', async () => {
    // The option is per-close, not a one-way trip. An implementation that marked
    // the client closed *permanently* on a non-retryable code — the obvious way
    // to write it, by reusing `_closedByUser` — would leave a caller who
    // reconnects by hand after a peer restart with a client that silently
    // refuses to open, which is a worse defect than the stampede.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });

    socket.peerClose(1008, 'policy violation');
    const p = client.connect();
    created[1].open();
    await p;

    expect(created.length, 'the deliberate connect built a second socket').toBe(2);
    expect(client.isOpen, 'and it opened').toBe(true);
    client.close();
  });
});

describe('RT-014: the control — a code that is not on the list still reconnects', () => {
  it('reconnects on a code absent from the list', async () => {
    // **The assertion that proves the list is what stopped it.** With only the
    // matching-code test present, a client that never reconnects at all passes.
    // Here the same client, the same options and the same delivery path differ
    // in one code — and the behaviour is the opposite.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });

    // 1006 is what a server restart looks like: abnormal closure, and the one
    // code that *must* be retried. It is absent from the list.
    socket.peerClose(1006, 'server restart');
    // Counted at schedule time, so this reads before the backoff has elapsed —
    // which is why the assertion is a counter and not a socket count.
    expect(client.stats().reconnects, 'a code off the list is retried at once').toBe(1);

    await vi.advanceTimersByTimeAsync(200);

    expect(created.length, 'so a replacement socket was constructed').toBeGreaterThan(1);
    client.close();
  });

  it('reconnects on every code when the list names a different one', async () => {
    // The same property one code over, so a mutation that turned the comparison
    // into "matches everything" is caught by both directions.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [4000],
    });

    socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(200);

    expect(client.stats().reconnects, '1008 is not 4000').toBe(1);
    expect(created.length).toBeGreaterThan(1);
    client.close();
  });

  it('picks the matching code out of a multi-code list', async () => {
    // The realistic configuration: three codes declared, the peer sends the
    // second one. A check that only ever looked at `list[0]` would pass the
    // single-code tests and fail this.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1001, 1002, 1008],
    });

    socket.peerClose(1002, 'protocol error');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(created.length, 'the middle entry stopped it').toBe(1);
    expect(client.stats().reconnectExhaustedBy).toBe('close-code');
    client.close();
  });
});

describe('RT-014: the default is inert', () => {
  it('reconnects on 1008 by default, because the list is opt-in', async () => {
    // **The test most likely to be wrong on a first pass.** A finite default
    // would be a behaviour change, and the row is explicit that the list ships
    // opt-in. If this ever goes red, the option has been made a default — which
    // is a breaking change, not a bug fix, and needs a major version.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient();

    expect(client._nonRetryableCloseCodes, 'the default is an empty list').toEqual([]);

    socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(200);

    expect(client.stats().reconnects, 'so a 1008 is still retried').toBe(1);
    expect(created.length, 'and a replacement socket is built').toBeGreaterThan(1);
    expect(client.stats().reconnectExhaustedBy, 'nothing is exhausted').toBe(null);
    client.close();
  });

  it('accepts an explicit empty list and duplicate codes', async () => {
    const { client } = await openClient({ nonRetryableCloseCodes: [] });
    expect(client._nonRetryableCloseCodes).toEqual([]);

    // Duplicates are legal and kept: a scan does not care, and de-duplicating
    // would promise a normalisation the option does not document.
    const dupes = await openClient({ nonRetryableCloseCodes: [1008, 1008, '1008'] });
    expect(dupes.client._nonRetryableCloseCodes).toEqual([1008, 1008, 1008]);

    client.close();
    dupes.client.close();
  });
});

describe('RT-014: a user hook cannot re-enable a declared non-retryable code', () => {
  it('ignores what an onClose handler returns or attempts', async () => {
    // **There is no `shouldReconnect` option** (`rg shouldReconnect src/` finds
    // nothing), so the only hook a user has on this path is `onClose` — and it
    // runs *before* the reconnect decision, so a handler cannot reach the state
    // the decision reads. This is the property the check's placement exists to
    // hold: when a callback form is added later it must go after
    // `matchesCloseCode`, or a predicate would quietly outrank the declaration.
    //
    // Two attempts to steer it from the handler, over two close deliveries: return
    // a verdict, and throw. Neither changes the outcome — `_emit` has no channel
    // for a handler's return value at all, and it catches a throw. (Calling
    // `client.close()` from the handler was a third and is not here: it re-enters
    // `_handleClose` through the same event, so the handler runs again and calls
    // `close()` again, recursing until the socket chain gives up. That is a fact
    // about `close()`, not about this option — see the boundary test below.)
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });
    const seen = [];
    const errors = [];
    let throwNext = false;
    client.on('error', (e) => errors.push(e));
    client.on('close', () => {
      seen.push('handler ran');
      if (throwNext) throw new Error('a user handler that throws');
      return false;
    });

    socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(created.length, 'a returned verdict changes nothing').toBe(1);

    throwNext = true;
    socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(seen, 'the handler ran both times, and still could not re-enable').toEqual([
      'handler ran',
      'handler ran',
    ]);
    expect(created.length, 'no reconnect, whatever the handler did').toBe(1);
    expect(client.stats().reconnects).toBe(0);
    expect(errors.length, 'and the throw was reported rather than escaping').toBe(1);
    client.close();
  });

  it('lets an onClose handler reconnect deliberately, by calling connect()', async () => {
    // **A characterisation, not an aspiration.** An `onClose` handler that calls
    // `connect()` *does* reopen, and this option does not stop it — a deliberate
    // `connect()` is a user-initiated connection, which is the same thing
    // `close()` is, and the option constrains the *automatic* decision rather
    // than the user's own explicit one. It is pinned so that making it blocked
    // later is a deliberate decision with a test to change, rather than something
    // someone discovers from a lockup: a handler that reconnects on every close is
    // exactly the stampede this row exists to stop, and it is the shape the
    // upcoming `shouldReconnect` callback must not make easy.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });
    let calls = 0;
    let reconnecting = null;
    client.on('close', () => {
      calls += 1;
      if (calls === 1) reconnecting = client.connect();
    });

    socket.peerClose(1008, 'policy violation');

    expect(created.length, 'the handler asked for it, so a socket was built').toBe(2);
    expect(client._closedByUser, 'and the connect counted as a user action').toBe(false);
    // Settle the handler's promise rather than leaving it pending: the teardown
    // `close()` would reject it, and an unhandled rejection at the end of the file
    // is a false positive that makes the next real one invisible.
    created[1].open();
    await reconnecting;
    expect(client.isOpen, 'and the deliberate reconnect actually opened').toBe(true);
    client.close();
  });

  it('does not mark a caller-initiated close as non-retryable', async () => {
    // The gate is inside `if (!this._closedByUser)`, deliberately. A user who
    // closes with a code that happens to be on the list has not discovered the
    // code is non-retryable — they asked for the close — so recording
    // `'close-code'` there would put a lie in the one field that exists to say
    // why reconnection stopped.
    vi.useFakeTimers();
    const { client } = await openClient({ nonRetryableCloseCodes: [1000, 1008] });

    client.close(1000, 'bye');

    expect(client.readyState).toBe(3);
    expect(client.stats().reconnectExhaustedBy, 'the caller asked, the code did not').toBe(null);
    expect(client.stats().reconnects).toBe(0);
  });
});

describe('RT-014: string close codes match, and a list is validated', () => {
  it('matches a numeric string against the numeric event code', async () => {
    // **The decision, pinned.** A close code read out of JSON, an environment
    // variable or a query string arrives as a string, and an effective-looking
    // list that silently matches nothing is worse than no list — the client
    // reconnects for ever, which is the defect the option was added to fix. So
    // the forgiving read is the deliberate one.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: ['1008'],
    });
    expect(client._nonRetryableCloseCodes, 'normalised to a number at construction, once').toEqual([
      1008,
    ]);

    socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(created.length, "'1008' stopped the numeric 1008").toBe(1);
    expect(client.stats().reconnectExhaustedBy).toBe('close-code');
    client.close();
  });

  it('matches a numeric code against a string-valued CloseEvent code', async () => {
    // The other direction, and it is not hypothetical: the DOM hands a `number`,
    // but a `ws`-shaped adapter or a test double built on JSON round-trips it
    // through a string. One lenient reader for both sides.
    vi.useFakeTimers();
    const { client, socket, created } = await openClient({
      nonRetryableCloseCodes: [1008],
    });

    socket.readyState = 3;
    socket._fireEvent('close', { type: 'close', code: '1008', reason: 'policy violation' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(created.length).toBe(1);
    expect(client.stats().reconnectExhaustedBy).toBe('close-code');
    client.close();
  });

  it('refuses an entry that merely looks like a code', async () => {
    // The control for the control: lenient matching must not have widened into
    // "matches something close". `'100 8'` is not a code, and it is *refused*
    // rather than stored — see the validation test below for why that is the
    // direction chosen. `1010` is a valid code that is simply the wrong one.
    vi.useFakeTimers();
    // `mkClient`, not `openClient`: the latter is `async`, so a throw inside it
    // surfaces as a rejected promise and `toThrow` would see nothing. The
    // constructor throws before any socket exists, so nothing has to be opened.
    expect(() => mkClient({ nonRetryableCloseCodes: ['100 8'] })).toThrow(
      /nonRetryableCloseCodes\[0\]/
    );

    const lenient = await openClient({ nonRetryableCloseCodes: ['1010'] });
    lenient.socket.peerClose(1008, 'policy violation');
    await vi.advanceTimersByTimeAsync(200);
    expect(lenient.created.length, '1010 is not 1008').toBeGreaterThan(1);
    expect(lenient.client.stats().reconnects).toBe(1);
    lenient.client.close();
  });

  it('throws on a non-array rather than coercing one', async () => {
    // `null` is the case that matters: destructuring defaults only cover
    // `undefined`, so an explicit `null` reaches the check and used to be
    // iterable-or-not decided by whatever read it first.
    for (const value of [null, 1008, '1008', { 0: 1008 }, false]) {
      expect(() => mkClient({ nonRetryableCloseCodes: value })).toThrow(/nonRetryableCloseCodes/);
    }
    // Typed as `TypeError`, like every other bad option on this class.
    let thrown = null;
    try {
      mkClient({ nonRetryableCloseCodes: 1008 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'and it is a TypeError').toBeInstanceOf(TypeError);
  });

  it('throws on an entry that is not a close code', async () => {
    // **The `maxReconnectAttempts: NaN` lesson (RT-013), applied to a list.**
    // Silently skipping a bad entry would leave the caller believing a code is
    // protected when it is not — the one failure direction this option must not
    // have. `NaN` is the rejected value the reader returns, not the accepted
    // one, so `null` and `''` cannot match close code 0 either.
    for (const value of [null, '', '   ', 'close', Number.NaN, {}, [], true, Infinity]) {
      expect(
        () => mkClient({ nonRetryableCloseCodes: [1008, value] }),
        `entry ${String(value)}`
      ).toThrow(/nonRetryableCloseCodes\[1\]/);
    }
    // `±Infinity` is refused even though it is a `number`: a close code is a
    // uint16, so an infinite one can never match, and storing it would be a
    // configured-looking entry that does nothing.
    expect(() => mkClient({ nonRetryableCloseCodes: [-Infinity] })).toThrow(
      /nonRetryableCloseCodes\[0\]/
    );
  });

  it('does not alias the array the caller passed', async () => {
    // The list is read on every close for the life of the process, so the
    // client holds its own copy: a caller mutating the array they passed must
    // not silently change which codes end the connection.
    const list = [1008];
    const { client } = await openClient({ nonRetryableCloseCodes: list });
    list.push(1002);

    expect(client._nonRetryableCloseCodes, 'the push after construction is not seen').toEqual([
      1008,
    ]);
    client.close();
  });
});
