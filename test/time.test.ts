import { describe, expect, it } from "vitest";
import { describeRefs, formatNow, resolveTemporalRefs, startOfZonedDay } from "../src/context/time.js";

// Wednesday 11 Nov 2026, 14:30 in Asia/Kolkata
const NOW = Date.UTC(2026, 10, 11, 9, 0);
const IST = "Asia/Kolkata";
const labels = (text: string, now = NOW, tz = IST) =>
  resolveTemporalRefs(text, now, tz).map((r) => ({ text: r.text, labels: r.ranges.map((x) => x.label), ambiguous: r.ambiguous }));

describe("resolveTemporalRefs", () => {
  it("resolves a bare weekday to the most recent past occurrence", () => {
    expect(labels("On Monday we shortlisted 5 CRM tools for a 20-person sales team")).toEqual([
      { text: "Monday", labels: ["Mon 9 Nov 2026"], ambiguous: false },
    ]);
  });

  it("flags 'last Tuesday' on a Wednesday as ambiguous and returns both candidates", () => {
    expect(labels("Last Tuesday I asked you about Postgres hosting")).toEqual([
      { text: "Last Tuesday", labels: ["Tue 10 Nov 2026", "Tue 3 Nov 2026"], ambiguous: true },
    ]);
  });

  it("does not flag 'last Friday' when both readings agree", () => {
    expect(labels("last Friday")).toEqual([{ text: "last Friday", labels: ["Fri 6 Nov 2026"], ambiguous: false }]);
  });

  it("treats the same weekday as today-or-a-week-ago", () => {
    expect(labels("on Wednesday")[0]).toMatchObject({ labels: ["Wed 11 Nov 2026", "Wed 4 Nov 2026"], ambiguous: true });
  });

  it("resolves explicit dates", () => {
    expect(labels("What did I ask you on 3 November?")[0]).toMatchObject({ labels: ["Tue 3 Nov 2026"] });
  });

  it("rolls a yearless future date back to the previous year", () => {
    expect(labels("what about 20 December")[0]).toMatchObject({ labels: ["Sat 20 Dec 2025"] });
  });

  it("resolves yesterday, last week and last month", () => {
    expect(labels("yesterday")[0]).toMatchObject({ labels: ["Tue 10 Nov 2026"] });
    const week = resolveTemporalRefs("what happened last week", NOW, IST)[0]!;
    expect(week.ranges[0]!.label).toBe("week of Mon 2 Nov 2026 to Sun 8 Nov 2026");
    expect(week.ranges[0]!.endMs - week.ranges[0]!.startMs).toBe(7 * 86_400_000);
    const month = resolveTemporalRefs("last month", NOW, IST)[0]!;
    expect(month.ranges[0]!.label).toBe("Oct 2026");
    expect(month.ranges[0]!.endMs - month.ranges[0]!.startMs).toBe(31 * 86_400_000);
  });

  it("ignores future-tense weekdays, times of day and non-dates", () => {
    expect(labels("I will meet them on Friday")).toEqual([]);
    expect(labels("remind me at 5pm")).toEqual([]);
    expect(labels("Compare 5 CRM tools for a 20-person team")).toEqual([]);
  });

  it("uses the user's local calendar day, not UTC", () => {
    const lateUtc = Date.UTC(2026, 10, 10, 20, 0); // 01:30 on 11 Nov in IST, 12:00 on 10 Nov in LA
    const ist = resolveTemporalRefs("today", lateUtc, IST)[0]!.ranges[0]!;
    expect(ist.label).toBe("Wed 11 Nov 2026");
    expect(ist.startMs).toBe(Date.UTC(2026, 10, 10, 18, 30));
    const la = resolveTemporalRefs("today", lateUtc, "America/Los_Angeles")[0]!.ranges[0]!;
    expect(la.label).toBe("Tue 10 Nov 2026");
  });

  it("handles a 25-hour day when DST ends", () => {
    const r = resolveTemporalRefs("on 1 November", NOW, "America/New_York")[0]!.ranges[0]!;
    expect(r.endMs - r.startMs).toBe(25 * 3_600_000);
  });
});

describe("formatting", () => {
  it("formats now with weekday, date, time and zone", () => {
    expect(formatNow(NOW, IST)).toBe("Wednesday 11 Nov 2026, 14:30 (Asia/Kolkata)");
  });

  it("describes ambiguity for the prompt", () => {
    const notes = describeRefs(resolveTemporalRefs("last Tuesday", NOW, IST));
    expect(notes).toBe('"last Tuesday" -> ambiguous: Tue 10 Nov 2026 or Tue 3 Nov 2026');
    expect(describeRefs([])).toBeNull();
  });

  it("finds local midnight", () => {
    expect(startOfZonedDay({ y: 2026, m: 11, d: 9 }, IST)).toBe(Date.UTC(2026, 10, 8, 18, 30));
  });
});
