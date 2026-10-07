import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";

// Task text comes from Slack, email and meetings: untrusted. Render Markdown, then sanitise; no
// images (tracking pixels), forms or styles. Links open in a new tab without a referrer.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (href.startsWith("#/")) return; // a task reference inside the board
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** "PEN-12" in text → a link that opens that task on the board. */
export function linkTasks(md: string, prefix: string): string {
  if (!prefix) return md;
  const re = new RegExp(`(^|[^\\w\\[/#-])(${prefix}-\\d+)\\b(?!\\])`, "g");
  return md.replace(re, (_m, pre: string, ref: string) => `${pre}[${ref}](#/t/${ref})`);
}

export function renderMarkdown(md: string, prefix: string): string {
  const html = marked.parse(linkTasks(md, prefix), { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "video", "audio", "svg"], FORBID_ATTR: ["style"] });
}

// ------------------------------------------------------------ task references show their status

type Ref = { status: string; title: string };
const refs = new Map<string, { at: number; ref: Ref | null }>();
const STATUS_TEXT: Record<string, string> = { done: "Done", cancelled: "Cancelled", in_progress: "In progress", in_review: "Ready for review", blocked: "Blocked", todo: "To do", backlog: "Backlog" };

/** Status and title for task identifiers, from a short client cache or one /api/refs call. */
async function lookup(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => {
    const hit = refs.get(id);
    return !hit || Date.now() - hit.at > 30_000;
  });
  if (!missing.length) return;
  const res = await fetch(`/api/refs?ids=${encodeURIComponent(missing.join(","))}`);
  if (!res.ok) return;
  const found = (await res.json()) as Record<string, Ref>;
  for (const id of missing) refs.set(id, { at: Date.now(), ref: found[id] ?? null });
}

function decorate(root: HTMLElement) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="#/t/"]')) {
    const ref = refs.get(a.getAttribute("href")!.slice(4))?.ref;
    if (!ref) continue;
    a.dataset.status = ref.status;
    a.title = `${STATUS_TEXT[ref.status] ?? ref.status} · ${ref.title}`;
  }
}

export function Markdown({ text, prefix, className = "" }: { text: string; prefix: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text, prefix), [text, prefix]);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const ids = [...new Set([...root.querySelectorAll('a[href^="#/t/"]')].map((a) => a.getAttribute("href")!.slice(4)))];
    if (!ids.length) return;
    decorate(root);
    let live = true;
    lookup(ids).then(() => live && decorate(root), () => {});
    return () => {
      live = false;
    };
  }, [html]);
  if (!text.trim()) return null;
  return <div ref={el} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
