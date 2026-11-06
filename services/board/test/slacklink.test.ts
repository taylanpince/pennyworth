import { describe, expect, it } from "vitest";
import { slackAppLink } from "../web/src/slack.js";

const teams = { "polygon.enterprise.slack.com": "E07D7KV2ML0" };

describe("slackAppLink", () => {
  it("opens a thread reply in the app", () => {
    expect(slackAppLink("https://polygon.enterprise.slack.com/archives/C0AD7K62VKP/p1793954842940969?thread_ts=1793123076.009189&cid=C0AD7K62VKP", teams)).toBe(
      "slack://channel?team=E07D7KV2ML0&id=C0AD7K62VKP&message=1793954842.940969&thread_ts=1793123076.009189&host=slack.com",
    );
  });

  it("opens a message and a channel", () => {
    expect(slackAppLink("https://polygon.enterprise.slack.com/archives/C0AD8SUV7PG/p1791196295735679", teams)).toBe("slack://channel?team=E07D7KV2ML0&id=C0AD8SUV7PG&message=1791196295.735679&host=slack.com");
    expect(slackAppLink("https://Polygon.Enterprise.slack.com/archives/C0AD8SUV7PG", teams)).toBe("slack://channel?team=E07D7KV2ML0&id=C0AD8SUV7PG&host=slack.com");
  });

  it("leaves other links alone", () => {
    expect(slackAppLink("https://other.slack.com/archives/C0AD8SUV7PG/p1791196295735679", teams)).toBeUndefined();
    expect(slackAppLink("https://polygon.enterprise.slack.com/files/U1/F1/x.pdf", teams)).toBeUndefined();
    expect(slackAppLink("http://polygon.enterprise.slack.com/archives/C0AD8SUV7PG", teams)).toBeUndefined();
    expect(slackAppLink("https://example.com/archives/C0AD8SUV7PG", teams)).toBeUndefined();
    expect(slackAppLink("not a url", teams)).toBeUndefined();
  });
});
