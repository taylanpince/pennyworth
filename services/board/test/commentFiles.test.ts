import { expect, it } from "vitest";
import { commentFiles } from "../web/src/commentFiles.js";
import type { CommentView, FileView } from "../web/src/types.js";

const file = (id: string, name: string, time: number, textOf: string | null = null): FileView => ({ id, name, createdAt: new Date(time).toISOString(), type: "application/octet-stream", size: 100, by: "me", textOf });
const reply = (id: string, names: string[], time: number): CommentView => ({ id, body: `_Attached to the task: ${names.map((n) => `\`${n}\``).join(", ")}._`, createdAt: new Date(time).toISOString(), author: { kind: "runner", name: "Runner" } });

it("keeps each revision with its delivery, excluding unrelated files and text companions", () => {
  const first = file("a", "grid-v001.glb", 100);
  const second = file("b", "grid-v002.glb", 300);
  const comments = [reply("one", [first.name], 200), reply("two", [second.name, "context.txt"], 400)];
  const grouped = commentFiles(comments, [first, second, file("c", "reference.pdf", 50), file("d", "context.txt", 300, "c")]);
  expect([...grouped]).toEqual([["one", [first]], ["two", [second]]]);
});

it("does not put a replacement file under the earlier reply with the same filename", () => {
  const replacement = file("new", "model.stl", 300);
  const comments = [reply("old", [replacement.name], 200), reply("new", [replacement.name], 400), reply("repeat", [replacement.name], 500)];
  expect([...commentFiles(comments, [replacement])]).toEqual([["new", [replacement]]]);
});

it("does not turn filenames in ordinary discussion or user comments into deliveries", () => {
  const f = file("a", "model.glb", 100);
  const user = { ...reply("user", [f.name], 200), author: { kind: "me" as const, name: "You" } };
  expect(commentFiles([user, { ...reply("discussion", [], 300), body: "Please review `model.glb`." }], [f]).size).toBe(0);
});
