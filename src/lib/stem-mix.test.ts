import { describe, expect, it } from "vitest";
import { addCut, crossfade, envelopeAt, insertPoint, setPoint, alignOffset, barLoop, barNumber, clampView, cutGain, endOf, gridOnTimeline, localTime, makeTrackEdit, overlap, snapTo, stemGain, swapStem, syncRatio, zoomView, type Placement } from "./stem-mix";

const grid = { beat: 0.5, first: 0.1 };
let n = 0;
const id = () => `c${++n}`;

describe("placement", () => {
  it("maps timeline time into a layer's own time and back", () => {
    const p: Placement = { offset: 10, ratio: 1.05, duration: 200 };
    expect(localTime(p, 10)).toBe(0);
    expect(localTime(p, 20)).toBeCloseTo(10.5);
    expect(endOf(p)).toBeCloseTo(10 + 200 / 1.05);
  });
  it("maps a layer's grid onto the timeline", () => {
    const g = gridOnTimeline({ beat: 0.5, first: 0.2 }, { offset: 4, ratio: 2, duration: 100 });
    expect(g).toEqual({ beat: 0.25, first: 4.1 });
  });
});

describe("snapping", () => {
  it("snaps to beats and bars, and leaves free time alone", () => {
    expect(snapTo(0.84, grid, 1)).toBeCloseTo(0.6);
    expect(snapTo(1.0, grid, 4)).toBeCloseTo(0.1);
    expect(snapTo(1.3, grid, 4)).toBeCloseTo(2.1);
    expect(snapTo(1.3, grid, 0)).toBe(1.3);
    expect(snapTo(1.3, null, 4)).toBe(1.3);
  });
  it("aligns a second layer's beats on the first layer's bars", () => {
    const own = { beat: 0.5, first: 0.3 };
    const offset = alignOffset(9.7, grid, own, 1, 4);
    // The second layer's first beat lands on a bar of the first.
    expect((offset + own.first - grid.first) / 2).toBeCloseTo(Math.round((offset + own.first - grid.first) / 2));
  });
  it("folds half and double time when syncing", () => {
    expect(syncRatio(128, 64)).toBeCloseTo(1);
    expect(syncRatio(128, 125)).toBeCloseTo(1.024);
    expect(syncRatio(null, 120)).toBe(1);
  });
});

describe("cuts", () => {
  it("joins cuts of one stem that touch, keeps other stems apart", () => {
    let cuts = addCut([], { id: id(), stem: 1, from: 2, to: 4 });
    cuts = addCut(cuts, { id: id(), stem: 1, from: 3, to: 6 });
    cuts = addCut(cuts, { id: id(), stem: 2, from: 3, to: 6 });
    expect(cuts.map(c => [c.stem, c.from, c.to])).toEqual([[1, 2, 6], [2, 3, 6]]);
  });
  it("ignores a cut with no length, in either direction", () => {
    expect(addCut([], { id: id(), stem: 0, from: 5, to: 5.001 })).toEqual([]);
    expect(addCut([], { id: id(), stem: 0, from: 6, to: 5 })[0]).toMatchObject({ from: 5, to: 6 });
  });
  it("silences inside a cut and ramps its edges", () => {
    const cuts = [{ id: "x", stem: 0, from: 10, to: 20 }];
    expect(cutGain(cuts, 0, 9, 1)).toBe(1);
    expect(cutGain(cuts, 0, 15, 1)).toBe(0);
    expect(cutGain(cuts, 0, 10.5, 1)).toBeCloseTo(0.5);
    expect(cutGain(cuts, 0, 10.5, 0)).toBe(0);
    expect(cutGain(cuts, 1, 15, 1)).toBe(1);
  });
  it("gives a stem its level, solo, cuts and the layer volume", () => {
    const e = makeTrackEdit();
    e.strips[2].level = 0.5; e.mix.volume = 0.8; e.cuts = [{ id: "x", stem: 2, from: 5, to: 8 }];
    const p = { offset: 0, ratio: 1, duration: 60 };
    expect(stemGain(e, p, 2, 1, false, 0)).toBeCloseTo(0.4);
    expect(stemGain(e, p, 2, 6, false, 0)).toBe(0);
    expect(stemGain(e, p, 2, 1, true, 0)).toBe(0);
    e.strips[2].solo = true;
    expect(stemGain(e, p, 2, 1, true, 0)).toBeCloseTo(0.4);
  });
});

describe("loops and swaps", () => {
  it("starts a bar loop on the bar under the playhead", () => {
    expect(barLoop(5.3, grid, 2)).toEqual({ from: expect.closeTo(4.1, 6), to: expect.closeTo(8.1, 6) });
    expect(barNumber(4.2, grid)).toBe(3);
  });
  it("swaps a stem between two layers at one point", () => {
    const pa = { offset: 0, ratio: 1, duration: 100 }, pb = { offset: 80, ratio: 1, duration: 100 };
    expect(overlap(pa, pb)).toEqual({ from: 80, to: 100 });
    const [a, b] = swapStem(makeTrackEdit(), pa, makeTrackEdit(), pb, 2, 90, id);
    expect(a.cuts).toMatchObject([{ stem: 2, from: 90, to: 100 }]);
    expect(b.cuts).toMatchObject([{ stem: 2, from: 0, to: 10 }]);
  });
});

describe("view", () => {
  it("zooms around a point and stays inside the timeline", () => {
    const v = zoomView({ from: 0, span: 100 }, 0.5, 50, 100);
    expect(v).toEqual({ from: 25, span: 50 });
    expect(clampView({ from: 90, span: 50 }, 100)).toEqual({ from: 50, span: 50 });
    expect(clampView({ from: 0, span: 500 }, 100)).toEqual({ from: 0, span: 100 });
  });
});

describe("volume curves", () => {
  it("is flat without points and outside them, straight between", () => {
    expect(envelopeAt([], 5)).toBe(1);
    const pts = [{ t: 10, g: 1 }, { t: 20, g: 0 }];
    expect(envelopeAt(pts, 0)).toBe(1);
    expect(envelopeAt(pts, 15)).toBeCloseTo(0.5);
    expect(envelopeAt(pts, 30)).toBe(0);
  });
  it("inserts in order and keeps a moved point between its neighbours", () => {
    const [pts, i] = insertPoint([{ t: 0, g: 1 }, { t: 10, g: 0 }], { t: 4, g: 2 });
    expect(i).toBe(1);
    expect(pts[1]).toEqual({ t: 4, g: 1 });
    expect(setPoint(pts, 1, { t: 50, g: 0.3 })[1].t).toBeLessThan(10);
  });
  it("fades A out and B in over the overlap, in each layer's own seconds", () => {
    const pa = { offset: 0, ratio: 1, duration: 100 }, pb = { offset: 80, ratio: 2, duration: 100 };
    const [a, b] = crossfade(pa, pb, "smooth", { from: 80, to: 100 });
    expect(envelopeAt(a, 79)).toBe(1);
    expect(envelopeAt(a, 100)).toBeCloseTo(0);
    expect(envelopeAt(b, 0)).toBeCloseTo(0);
    expect(envelopeAt(b, 40)).toBeCloseTo(1);
    // Equal power in the middle.
    expect(envelopeAt(a, 90) ** 2 + envelopeAt(b, 20) ** 2).toBeCloseTo(1, 1);
    const [ca, cb] = crossfade(pa, pb, "cut", { from: 80, to: 100 }, 90);
    expect(envelopeAt(ca, 89.9)).toBe(1);
    expect(envelopeAt(ca, 90.1)).toBe(0);
    expect(envelopeAt(cb, 19.9)).toBe(0);
    expect(envelopeAt(cb, 20.1)).toBe(1);
    expect(crossfade(pa, pb, "linear", null)).toEqual([[], []]);
  });
});
