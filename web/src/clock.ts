// The pipeline runs on performance.now(); records, the history and every "now" outside the pipeline use the wall
// clock (Date.now()). The two drift apart in a long-open tab: performance.now() does not count while the computer
// sleeps on some systems (macOS), and the wall clock can be set by the system. performance.timeOrigin + t then lags
// Date.now() by the time asleep, and records written after waking look that much older to every filter that uses
// Date.now() ("the last 15 minutes" of the plan card, phase.ts). So a pipeline time becomes wall time through its
// distance from the present on both clocks, which is exact for anything just measured (P20 review, 8 Nov).
export function toWallClock(t: number, perfNow: number, dateNow: number): number {
  return Math.round(dateNow - (perfNow - t));
}
