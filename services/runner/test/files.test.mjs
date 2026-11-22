import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkFiles, mentionedFiles, shareable } from "../src/files.mjs";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "pw-files-"));
  mkdirSync(join(dir, "impact/raw"), { recursive: true });
  mkdirSync(join(dir, "stack/.git"), { recursive: true });
  mkdirSync(join(dir, "stack/api"), { recursive: true });
  mkdirSync(join(dir, "other"), { recursive: true });
  writeFileSync(join(dir, "impact/summary.md"), "# Summary\n");
  writeFileSync(join(dir, "impact/losses.csv"), "wallet,usd\n");
  writeFileSync(join(dir, "other/summary.md"), "# Other\n");
  writeFileSync(join(dir, "stack/api/adoption.go"), "package api\n");
  writeFileSync(join(dir, "impact/.env"), "KEY=1\n");
  writeFileSync(join(dir, "empty.txt"), "");
  writeFileSync(join(tmpdir(), "pw-outside.txt"), "outside\n");
  symlinkSync(join(tmpdir(), "pw-outside.txt"), join(dir, "impact/link.txt"));
  return dir;
}

describe("files the crew makes", () => {
  it("shares only real files inside the workspace", () => {
    const dir = workspace();
    try {
      const { files, refused } = shareable(dir, ["impact/losses.csv", "impact/raw", "impact/.env", "impact/link.txt", "empty.txt", "../x.txt"]);
      assert.deepEqual(files.map((f) => [f.name, f.type]), [["losses.csv", "text/csv"]]);
      assert.deepEqual(refused.map((r) => r.why), ["not a file (share the files in a folder one by one)", "looks like a hidden, key or credentials file", "outside the workspace", "empty, or over 10 MB", "no such file in the workspace"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns the files a reply names into downloads, leaving code references and folders alone", () => {
    const dir = workspace();
    try {
      const reply = `Results in \`impact/summary.md\` and \`${dir}/impact/losses.csv\`; raw in \`impact/raw/\`. The fix is \`stack/api/adoption.go\` (\`api/adoption.go:3\`). Also \`other/summary.md\`, \`impact/.env\` and \`missing.csv\`.`;
      const found = mentionedFiles(reply, dir);
      assert.deepEqual(found.map((f) => [f.mention, f.name]), [["impact/summary.md", "impact-summary.md"], [`${dir}/impact/losses.csv`, "losses.csv"], ["other/summary.md", "other-summary.md"]]);
      const linked = linkFiles(reply, new Map(found.map((f) => [f.mention, `/api/issues/i/files/${f.name}`])));
      assert.match(linked, /^Results in \[`impact\/summary\.md`\]\(\/api\/issues\/i\/files\/impact-summary\.md\) and \[`.*\/impact\/losses\.csv`\]\(\/api\/issues\/i\/files\/losses\.csv\); raw in `impact\/raw\/`\. The fix is `stack\/api\/adoption\.go` \(`api\/adoption\.go:3`\)\./);
      assert.equal(linkFiles("[`a.csv`](x) and `a.csv`", new Map([["a.csv", "/f"]])), "[`a.csv`](x) and [`a.csv`](/f)", "a path already in a link stays as it was");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
