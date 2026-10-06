import { describe, expect, it } from "vitest";
import { parseMatchCommand } from "../src/meetings/review-commands.js";

describe("match commands", () => {
  it("accepts pick/number/option forms and ignore", () => {
    for (const s of ["pick 2", "2", "Option #2", "it's 2", "choose 2."]) expect(parseMatchCommand(s)).toEqual({ kind: "pick", choice: "2" });
    expect(parseMatchCommand("pick evt_abc123_20261005")).toEqual({ kind: "pick", choice: "evt_abc123_20261005" });
    expect(parseMatchCommand("ignore")).toEqual({ kind: "ignore" });
    expect(parseMatchCommand("not sure, maybe the second one?")).toBeUndefined();
  });
});
