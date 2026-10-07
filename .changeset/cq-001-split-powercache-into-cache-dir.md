---
'performance-helpers': minor
---

Split `src/helpers/powerCache.js` into `src/helpers/cache/{core,memoizer,timedCache,index}.js` for maintainability. The original module path remains a backward-compatible re-export, so all existing imports continue to work unchanged.
