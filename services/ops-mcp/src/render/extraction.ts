import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max);

/** Structured meeting record produced by the Meeting Librarian from untrusted source text. */
export const ExtractionSchema = z.object({
  summary: z.string().trim().min(1).max(4000).describe("Brief neutral summary (one paragraph)"),
  decisions: z
    .array(
      z.object({
        text: line(600),
        kind: z.enum(["explicit", "probable"]).describe("explicit = clearly stated as decided; probable = likely conclusion, not confirmed"),
      }),
    )
    .max(30)
    .default([]),
  actions: z
    .array(
      z.object({
        owner: z.string().trim().max(120).nullable().describe("Person responsible; null if unclear. Never guess."),
        action: line(600),
        deadline: z.string().trim().max(120).nullable().describe("Only if explicitly stated in the source; else null"),
        source_quote: z.string().trim().max(400).optional().describe("Short supporting quote from the source"),
      }),
    )
    .max(40)
    .default([]),
  open_questions: z.array(line(600)).max(30).default([]),
  context: z.array(line(800)).max(20).default([]).describe("Important background context"),
  people: z.array(line(120)).max(60).default([]),
  topics: z.array(line(120)).max(20).default([]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * Neutralize model-supplied text before it goes into markdown:
 *  - HTML comments are removed so markers cannot be forged;
 *  - newlines are flattened so items cannot inject headings or frontmatter;
 *  - leading heading/quote/list syntax is escaped.
 */
export function inline(text: string): string {
  return text
    .replace(/<!--|-->/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^([#>]|-{3,}|\*{3,})/, "\\$1");
}

export function paragraph(text: string): string {
  return text
    .replace(/<!--|-->/g, "")
    .split(/\n{2,}/)
    .map((p) => inline(p))
    .filter(Boolean)
    .join("\n\n");
}
