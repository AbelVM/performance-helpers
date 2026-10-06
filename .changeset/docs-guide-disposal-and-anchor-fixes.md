---
'performance-helpers': patch
---

Documentation review and cleanup across guides, README, and assets:

- Deduplicated overlapping Clocks sections in `powerThrottle.md`, `powerRateLimit.md`, `powerSlidingWindow.md`, and `powerGCRA.md`.
- Removed stale `smart.md` reference from `autoscale.md` and `review.md` reference from `powerCache.md`.
- Fixed broken markdown anchors in `powerMessageCodec.md` and `powerServo.md`.
- Added missing "Cancelling a wait" section to `powerPermitGate.md`.
- Removed duplicate `fnComplexity` bullet in `powerChunking.md`.
- Reordered `powerBackpressure.md` and added disposal documentation.
- Fixed table formatting and added disposal docs in `powerSemaphore.md`.
- Added disposal documentation in `powerSubscriberSet.md`, `powerPool.md`, and `powerCache.md`.
- Updated `README.md` Caching section to include `PowerMemoizer` and `PowerTimedCache`.
- Verified all markdown anchors reference valid sections and `docs:claims` passes.
