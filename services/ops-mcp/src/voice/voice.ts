import type { Config } from "../config.js";
import { UserFacingError } from "../util/errors.js";
import { shortHash } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import { localParts } from "../util/time.js";
import type { Vault } from "../vault/vault.js";

export const LESSONS_HEADING = "Lessons";

const NEW_NOTE = `# Writing Voice

How I write, for Pennyworth's drafts in my voice. Edit freely: Pennyworth only adds entries under Lessons when I ask it to learn something.

## ${LESSONS_HEADING}
`;

export interface VoiceLesson {
  lesson: string;
  example?: string;
  context?: string;
  task?: string;
}

/**
 * The user's writing voice guide: one vault note the Assistant reads before drafting in the
 * user's voice, and adds lessons to when the user asks. Lessons are only ever appended under
 * the Lessons heading; everything else in the note is the user's.
 */
export class VoiceGuide {
  constructor(
    private readonly cfg: Config,
    private readonly vault: Vault,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private path(): string {
    const path = this.cfg.vault.voice_note;
    if (!path) throw new UserFacingError("No voice note configured (vault.voice_note in system.yaml)", "not_configured");
    return path;
  }

  read(): { path: string; exists: boolean; content: string } {
    const path = this.path();
    if (!this.vault.exists(path)) return { path, exists: false, content: "" };
    const snap = this.vault.read(path);
    return { path: snap.path, exists: true, content: snap.content };
  }

  add(input: VoiceLesson): { path: string; status: "written" | "exists" } {
    const path = this.path();
    const lesson = input.lesson.trim();
    if (!lesson) throw new UserFacingError("Lesson is empty", "bad_request");
    const example = input.example?.trim();
    const marker = `<!-- pennyworth-voice:${shortHash(`${lesson}\n${example ?? ""}`)} -->`;
    const title = [localParts(this.now(), this.cfg.timezone).date, input.context?.trim(), input.task?.trim() && `(${input.task.trim()})`]
      .filter(Boolean)
      .join(" · ");
    const quoted = example ? `\n\nIn my words:\n\n${example.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}` : "";
    const entry = `### ${title}\n\n${lesson}${quoted}\n${marker}`;
    if (!this.vault.exists(path)) this.vault.createNote(path, NEW_NOTE);
    const result = this.vault.appendUnderHeading(path, LESSONS_HEADING, entry, marker);
    this.log.info({ tool: "voice_note_add", path, status: result.status, task: input.task }, "voice lesson added");
    return { path, status: result.status };
  }
}
