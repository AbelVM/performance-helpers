---
'performance-helpers': minor
---

Add SIEVE (ALG-001) and S3-FIFO (ALG-002) eviction policies to `PowerCache`,
raise the typecheck ratchet ceiling to 162 to account for the new
`visited`/`queue` properties on `CacheNode`, and update the GATE-002 stop-list
in `test/docsCodeAgreement.test.js` for the newly added transport adapters.
