import { describe, expect, it } from "vitest";
import { parseMatchCommand } from "../src/meetings/review-commands.js";

describe("match commands", () => {
  it("accepts pick/number/option forms and ignore", () => {
    for (const s of ["pick 2", "2", "Option #2", "it's 2", "choose 2."]) expect(parseMatchCommand(s)).toEqual({ kind: "pick", choice: "2" });
    expect(parseMatchCommand("pick evt_abc123_20261005")).toEqual({ kind: "pick", choice: "evt_abc123_20261005" });
    expect(parseMatchCommand("ignore")).toEqual({ kind: "ignore" });
    expect(parseMatchCommand("not sure, maybe the second one?")).toBeUndefined();
  });

  it("recognizes a meeting that was not on the calendar, keeping the user's note", () => {
    const note = "This was an impromptu meeting with Sarthak from JPM. Please extract action items from the call.";
    expect(parseMatchCommand(note)).toEqual({ kind: "unscheduled", note });
    for (const s of ["It wasn't on my calendar, a call with Dana", "ad-hoc chat with Lee", "None of these, there was no calendar event", "unscheduled"]) {
      expect(parseMatchCommand(s)?.kind).toBe("unscheduled");
    }
    expect(parseMatchCommand("none of these")).toEqual({ kind: "ignore" });
  });
});
