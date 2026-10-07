[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerOperationContext](../README.md) / createOperationContext

# Function: createOperationContext()

> **createOperationContext**(`options?`): `object`

Create explicit coordination data for one operation.

The object is intentionally plain: helpers can consume the fields they
understand without importing a shared supervisor or context singleton.

## Parameters

### options?

#### correlationId?

`string`

#### deadlineAt?

`number`

Absolute deadline in milliseconds.

#### deadlineMs?

`number`

Relative deadline from this call.

#### priority?

`number`

#### retryBudget?

`Object`

Shared retry budget.

#### signal?

`AbortSignal`

## Returns

`object`

### correlationId?

> `optional` **correlationId?**: `string`

### deadlineAt?

> `optional` **deadlineAt?**: `number`

### priority

> **priority**: `number`

### retryBudget?

> `optional` **retryBudget?**: `Object`

### signal?

> `optional` **signal?**: `AbortSignal`
