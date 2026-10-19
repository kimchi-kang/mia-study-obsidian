import { describe, expect, it } from "vitest";
import { StudySwipe } from "../src/core/study-swipe";

const start = { pointerId: 1, x: 200, y: 200, time: 0 };
describe("deliberate study swipes", () => {
  it.each([
    ["light", 60, "next"], ["normal", 60, null], ["normal", 80, "next"], ["firm", 80, null], ["firm", 100, "next"],
  ] as const)("respects sensitivity %s for a %s pixel swipe", (sensitivity, distance, expected) => {
    const swipe = new StudySwipe(); swipe.begin(start, 360, sensitivity);
    expect(swipe.finish({ ...start, x: 200 - distance, time: 300 })).toBe(expected);
  });
  it.each([[-90, "next"], [90, "previous"]] as const)("accepts a deliberate stroke %s", (dx, direction) => {
    const swipe = new StudySwipe(); swipe.begin(start, 360);
    expect(swipe.finish({ ...start, x: start.x + dx, time: 300 })).toBe(direction);
    expect(swipe.finish({ ...start, x: start.x + dx, time: 320 })).toBeNull();
  });
  it.each([
    { x: 220, y: 200, time: 150 }, // small tap movement
    { x: 300, y: 255, time: 300 }, // diagonal
    { x: 205, y: 300, time: 300 }, // vertical scroll
    { x: 300, y: 200, time: 1000 }, // long press / reading
    { x: 300, y: 200, time: 100, pointerId: 2 },
  ])("rejects accidental movement %j", (end) => {
    const swipe = new StudySwipe(); swipe.begin(start, 360);
    expect(swipe.finish({ ...start, ...end })).toBeNull();
  });
  it("does not turn a vertical scroll into a swipe after the finger changes direction", () => {
    const swipe = new StudySwipe(); swipe.begin(start, 360);
    swipe.move({ ...start, x: 205, y: 225, time: 50 });
    expect(swipe.finish({ ...start, x: 90, y: 225, time: 300 })).toBeNull();
  });
  it("uses a longer stroke on a tablet without making it excessive", () => {
    const swipe = new StudySwipe(); swipe.begin(start, 1200);
    expect(swipe.finish({ ...start, x: 280, time: 300 })).toBeNull();
    swipe.begin(start, 1200);
    expect(swipe.finish({ ...start, x: 320, time: 300 })).toBe("previous");
  });
  it("cancels partial input when the view rerenders or the browser takes over", () => {
    const swipe = new StudySwipe(); swipe.begin(start, 360); swipe.cancel();
    expect(swipe.finish({ ...start, x: 90, time: 300 })).toBeNull();
  });
});
