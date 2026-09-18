// A worker that dies on load, so the pool's dead-worker path can be TESTED rather than
// reasoned about. `scan-pool.test.ts` points a pool at this and requires every task to
// come back `null` instead of hanging -- which is the defect it was written for: a
// `postMessage` to a dead worker throws nothing and delivers nothing, so the audit would
// simply never return, with no error anywhere.
throw new Error('this worker fails to load, on purpose');
