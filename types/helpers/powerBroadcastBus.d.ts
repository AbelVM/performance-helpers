/**
 * Creates a BroadcastChannel bus with per-frame ack, pending counter with
 * timeout, and slow-consumer detection.
 *
 * The bus assigns a sequence number to every frame it posts, tracks pending
 * acks per receiver, and marks a receiver slow when its pending count exceeds
 * the threshold or when an ack times out. Slow-consumer policy is driven by
 * the pending counter, not an invisible queue.
 *
 * @param {PowerBroadcastBusOptions} options
 */
export function createBroadcastBus(options: PowerBroadcastBusOptions): {
    send(sub: any, frame: any): boolean;
    close(sub: any): void;
    getSlowConsumerIds(): Set<string>;
    /**
     * A snapshot of the per-receiver pending-ack counts.
     *
     * Exists because of AUD-014. `close()` used to write a `0` into
     * `receiverPendingCount` for a receiver whose pending sends it had just
     * cleared, on the reasoning that the count was zero either way — which is
     * true of the *value* and false of the *entry*. A zero entry is not a state,
     * it is a leftover: nothing decrements it, because the timers that would
     * have were cleared, so it survives until the bus is disposed and the map
     * grows one key per closed subscriber.
     *
     * That is a pure retention bug with no behavioural symptom, which makes it
     * invisible to every test written against the public surface — the existing
     * `close` test asserted only `getSlowConsumerIds()` and passed either way.
     * This accessor is the smallest thing that makes the retention observable,
     * and it is the same shape as `getSlowConsumerIds()` for the same reason:
     * "what is the bus still tracking" is a question an operator debugging a leak
     * actually asks.
     *
     * @returns {Map<string, number>} A copy — mutating it does not affect the bus.
     */
    getPendingCounts(): Map<string, number>;
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
};
export type PowerBroadcastBusOptions = {
    /**
     * - The BroadcastChannel to use.
     */
    channel: BroadcastChannel;
    /**
     * - Timeout in milliseconds for acks.
     */
    ackTimeoutMs?: number | undefined;
    /**
     * - Called when a
     * receiver is marked as slow. The hub passes a callback that sets
     * `sub.slowConsumer = true`; the bus itself never touches subscriber records.
     */
    onSlowConsumer?: ((receiverId: string) => void) | undefined;
};
export type PendingAck = {
    seq: number;
    receiverId: string;
    timer: ReturnType<typeof setTimeout>;
};
