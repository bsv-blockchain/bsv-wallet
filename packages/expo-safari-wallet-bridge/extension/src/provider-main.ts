// SPIKE ONLY (Task 13, S3): records that the MAIN-world entry ran, and when.
;(window as any).__bsvProbeMain = { t: Math.round(performance.now()), readyState: document.readyState, top: window === window.top }
