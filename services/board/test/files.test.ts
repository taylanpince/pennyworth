import { execFileSync } from "node:child_process";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { decode, fileType, fileViews, pdfText, safeName } from "../src/files.js";
import type { Attachment, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

describe("file helpers (D-43)", () => {
  it("keeps only the file name, without markup or control characters", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\spec v2.pdf")).toBe("spec v2.pdf");
    expect(safeName('a<b>"c`.txt')).toBe("abc.txt");
    expect(safeName("...hidden")).toBe("hidden");
    expect(safeName("  ")).toBe("file");
    const long = safeName(`${"x".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("takes the browser's type, else the extension's", () => {
    expect(fileType("image/png", "a.png")).toBe("image/png");
    expect(fileType("text/plain; charset=utf-8", "a.txt")).toBe("text/plain");
    expect(fileType("", "notes.MD")).toBe("text/markdown");
    expect(fileType("", "blob")).toBe("application/octet-stream");
    expect(fileType("<script>", "a.pdf")).toBe("application/pdf");
  });

  it("decodes base64 within the limit", () => {
    expect(decode(Buffer.from("hello").toString("base64"))).toEqual(Buffer.from("hello"));
    expect(decode("not base64!")).toMatch(/base64/);
    expect(decode("")).toMatch(/empty/);
    expect(decode(Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"))).toMatch(/larger/);
  });

  it("marks a PDF's text version, and who uploaded what", () => {
    const at = (id: string, name: string, createdAt: string, by = "me-1"): Attachment => ({ id, issueId: "i", originalFilename: name, contentType: "x", byteSize: 1, createdAt, createdByUserId: by });
    const views = fileViews([at("2", "spec.pdf.txt", "2026-10-22T10:00:01Z"), at("1", "spec.pdf", "2026-10-22T10:00:00Z"), at("3", "notes.pdf.txt", "2026-10-22T10:00:02Z", "other")], "me-1");
    expect(views.map((v) => [v.id, v.textOf, v.by])).toEqual([
      ["1", null, "me"],
      ["2", "1", "me"],
      ["3", null, "agent"],
    ]);
  });

  const hasPdftotext = (() => {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPdftotext)("extracts a PDF's text, and gives up quietly on anything else", async () => {
    expect(await pdfText(minimalPdf("Quarterly plan"))).toContain("Quarterly plan");
    expect(await pdfText(Buffer.from("not a pdf"))).toBe("");
  });
});

describe("files on the board (D-43)", () => {
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const other = { ...issue, id: "22222222-2222-2222-2222-222222222222", identifier: "PEN-2", assigneeUserId: "someone" };
  const files: (Attachment & { data: Buffer })[] = [];
  const pc = {
    me: async () => "me-1",
    agents: async () => [],
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => ([issue, other].find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404"))),
    comments: async () => [],
    liveRuns: async () => [],
    children: async () => [],
    attachments: async (id: string) => files.filter((f) => f.issueId === id),
    addAttachment: async (issueId: string, name: string, type: string, data: Buffer) => {
      const a = { id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(files.length).padStart(12, "0")}`, issueId, originalFilename: name, contentType: type, byteSize: data.length, createdAt: new Date().toISOString(), createdByUserId: "me-1", data };
      files.push(a);
      return a;
    },
    attachmentContent: async (id: string) => files.find((f) => f.id === id)!.data,
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC" });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const headers = { host: "localhost:3120", ...(body === undefined ? {} : { "content-type": "application/json", "x-pennyworth-board": "1" }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const upload = (ref: string, name: string, type: string, data: Buffer) => call("POST", `/api/issues/${ref}/files`, { name, type, data: data.toString("base64") });

  it("attaches a file to the user's task and lists it", async () => {
    const res = await upload("PEN-1", "../notes.md", "text/markdown", Buffer.from("# Context\n"));
    expect(res.status).toBe(200);
    const view = JSON.parse(res.text);
    expect(view.files).toMatchObject([{ name: "notes.md", type: "text/markdown", size: 10, by: "me", textOf: null }]);
  });

  it("takes files up to Paperclip's 10 MB, not beyond", async () => {
    expect((await upload("PEN-1", "big.bin", "", Buffer.alloc(10 * 1024 * 1024, 1))).status).toBe(200);
    expect((await upload("PEN-1", "huge.bin", "", Buffer.alloc(10 * 1024 * 1024 + 1, 1))).status).toBe(400);
  });

  it("refuses uploads to other people's tasks, and without the board's header", async () => {
    expect((await upload("PEN-2", "a.txt", "text/plain", Buffer.from("x"))).status).toBe(403);
    const plain = await new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/issues/PEN-1/files", headers: { host: "localhost:3120", "content-type": "multipart/form-data" } }, (res) => resolve(res.statusCode!));
      req.end("x");
    });
    expect(plain).toBe(403);
  });

  it("downloads files, showing only plain images inline, and only from their own task", async () => {
    const png = files.length;
    await upload("PEN-1", "shot.png", "image/png", Buffer.from("png-bytes"));
    const text = await call("GET", `/api/issues/PEN-1/files/${files[0]!.id}`);
    expect(text.status).toBe(200);
    expect(text.text).toBe("# Context\n");
    expect(text.headers["content-type"]).toBe("application/octet-stream");
    expect(text.headers["content-disposition"]).toMatch(/^attachment; filename="notes\.md"/);
    expect(text.headers["content-security-policy"]).toMatch(/sandbox/);
    const img = await call("GET", `/api/issues/PEN-1/files/${files[png]!.id}`);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-disposition"]).toMatch(/^inline/);
    expect((await call("GET", `/api/issues/PEN-2/files/${files[0]!.id}`)).status).toBe(404);
  });
});

/** A one-page PDF with `text` on it. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
