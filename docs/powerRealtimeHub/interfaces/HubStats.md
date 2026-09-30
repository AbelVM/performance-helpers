[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerRealtimeHub](../README.md) / HubStats

# Interface: HubStats

## Properties

### bytesOut

> **bytesOut**: `number`

Approximate bytes handed to the adapter.

---

### delivered

> **delivered**: `number`

Total messages handed to a `send` adapter.

---

### disconnected

> **disconnected**: `number`

Subscribers closed for falling behind.

---

### dropped

> **dropped**: `number`

Total messages discarded by a policy.

---

### published

> **published**: `number`

Total messages accepted by `publish`.

---

### subscribers

> **subscribers**: `number`

Current live subscription count.

---

### topics

> **topics**: `number`

Number of topics with at least one subscriber.
