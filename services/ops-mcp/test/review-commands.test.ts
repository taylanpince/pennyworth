import { describe, expect, it } from "vitest";
import { parseMatchCommand, parseRouteCommand } from "../src/meetings/review-commands.js";

describe("route commands", () => {
  it("understands the strict form", () => {
    expect(parseRouteCommand("route polygon/oms/OMS.md")).toEqual({ kind: "route", targets: ["polygon/oms/OMS.md"] });
    expect(parseRouteCommand("route `polygon/oms/OMS.md`")).toEqual({ kind: "route", targets: ["polygon/oms/OMS.md"] });
    expect(parseRouteCommand("route none")).toEqual({ kind: "none" });
  });

  it("understands natural phrasing and adds .md", () => {
    expect(parseRouteCommand("Going forward route these 1-1 meeting notes with Vojtech to polygon/oms/Vojtech 1-1")).toEqual({
      kind: "route",
      targets: ["polygon/oms/Vojtech 1-1.md"],
    });
    expect(parseRouteCommand("Please append it to [[polygon/agglayer/JPM]].")).toEqual({ kind: "route", targets: ["polygon/agglayer/JPM.md"] });
    expect(parseRouteCommand("Log this to 'people/Chris Nisbet.md'!")).toEqual({ kind: "route", targets: ["people/Chris Nisbet.md"] });
    expect(parseRouteCommand("don't route these anywhere")).toEqual({ kind: "none" });
  });

  it("ignores unrelated comments and unsafe paths", () => {
    expect(parseRouteCommand("Thanks, looks good")).toBeUndefined();
    expect(parseRouteCommand("route to ../../etc/passwd")).toBeUndefined();
    expect(parseRouteCommand("route to /etc/passwd")).toBeUndefined();
  });
});

describe("match commands", () => {
  it("accepts pick/number/option forms and ignore", () => {
    for (const s of ["pick 2", "2", "Option #2", "it's 2", "choose 2."]) expect(parseMatchCommand(s)).toEqual({ kind: "pick", choice: "2" });
    expect(parseMatchCommand("pick evt_abc123_20261005")).toEqual({ kind: "pick", choice: "evt_abc123_20261005" });
    expect(parseMatchCommand("ignore")).toEqual({ kind: "ignore" });
    expect(parseMatchCommand("not sure, maybe the second one?")).toBeUndefined();
  });
});
