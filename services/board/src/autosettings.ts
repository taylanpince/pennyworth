// The automation switch (docs/design/automation.md, D-75): off unless the user turns it on, here in
// Settings or in the runner's config. The runner asks for it on every poll; what the board stores wins
// over the runner's config, and the runner sends its config so Settings can show what applies.
import { z } from "zod";
import type { Store } from "./store.js";

export const AutomationSchema = z
  .object({
    enabled: z.boolean(),
    prWatches: z.boolean(),
    crossReview: z.boolean(),
    followUps: z.boolean(),
    idle: z.boolean(),
  })
  .strict();
export type Automation = z.infer<typeof AutomationSchema>;

/** Nothing set anywhere: everything off. */
export const AUTOMATION_OFF: Automation = { enabled: false, prWatches: true, crossReview: true, followUps: true, idle: true };

/** What the user chose in Settings, or undefined when they never did (the runner's config applies). */
export function storedAutomation(store: Store): Automation | undefined {
  const raw = store.meta("automation");
  if (!raw) return undefined;
  const parsed = AutomationSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

export function saveAutomation(store: Store, value: Automation): Automation {
  store.setMeta("automation", JSON.stringify(value));
  return value;
}
