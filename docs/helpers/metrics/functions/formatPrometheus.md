[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / formatPrometheus

# Function: formatPrometheus()

> **formatPrometheus**(`descriptors`): `string`

Format explicit metric descriptors using the Prometheus text exposition
format. Values are supplied by the caller so this function remains pure and
cannot accidentally sample helpers or infer histogram semantics.

## Parameters

### descriptors

[`PrometheusDescriptor`](../interfaces/PrometheusDescriptor.md)[]

## Returns

`string`
