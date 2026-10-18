[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerTaskGroup

# powerTaskGroup

Structured concurrency: a scope that runs async tasks and cancels all of
them on exit.

`PowerTaskGroup` (also called a `Scope`) owns an `AbortController` and a set
of in-flight tasks. Every task receives the scope's `AbortSignal`; when the
scope is disposed (or a task rejects and `cancelOnError` is set) all
siblings are aborted and the scope waits for them to settle.

## Classes

- [PowerTaskGroup](classes/PowerTaskGroup.md)

## Interfaces

- [PowerTaskGroupOptions](interfaces/PowerTaskGroupOptions.md)

## References

### default

Renames and re-exports [PowerTaskGroup](classes/PowerTaskGroup.md)
