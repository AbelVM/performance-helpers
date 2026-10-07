[**performance-helpers**](../../../../README.md)

***

[performance-helpers](../../../../README.md) / [helpers/cache/core](../README.md) / POWER\_CACHE\_OPTIONS

# Variable: POWER\_CACHE\_OPTIONS

> `const` **POWER\_CACHE\_OPTIONS**: readonly `string`[]

Every option `PowerCache` accepts, in one place.

CACHE-013: `PowerTimedCache` needs to validate the `cacheOptions` it forwards, and
the first version of that fix hand-copied this list. It was wrong in four places —
it carried `ttl`, `weight`, `keyResolver` and `cacheOptions`, none of which this
constructor accepts, and it **omitted `seed`** — so a wrapper advertised options the
cache behind it rejected. Two numbers in one file disagreeing is the failure this
repository keeps paying for; a *third* copy of a 22-item list would guarantee it.

`PowerTimedCache` therefore derives its own allowlist from this array rather than
restating it, and `test/powerTimedCache.delegation.test.js` checks the two against
each other through the error message, which prints the enforced set.
