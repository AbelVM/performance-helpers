---
'performance-helpers': patch
---

Add four benchmark workloads to `bench/claims.js` that measured and closed four review rows: `runDeferWorkload()` for RES-022 (PowerDefer WeakMap overhead, 14.74× — closed as not adopted), `runCodecWorkload()` for RT-027 (binary codec vs JSON.stringify, 2.31× slower for 1000-number payloads — closed as not adopted), `runSabRingWorkload()` for RT-031 (SAB ring vs structuredClone, 5.27× slower — closed as not adopted), and `runKeyShapeWorkload()` for GAP-018 (cache key-shape throughput, integer fastest, string 1.21× slower, object keys collapse to `"[object Object]"` collisions — adopted). Also fix five lint errors in the same file (1 `prefer-const`, 4 `prettier/prettier`).
