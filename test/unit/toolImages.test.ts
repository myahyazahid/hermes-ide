import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createToolImageFinder, imagePathsIn } from "../../src/core/toolImages";
import { Transcript } from "../../src/core/transcript";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("imagePathsIn", () => {
  it("finds Windows, POSIX and relative image paths in commands and output", () => {
    const text = `python shot.py --out "C:\\proj\\Saved\\shot_01.png"\nSaved to /tmp/ab/x.jpg and ./out/y.webp; see Path(r'D:/r/z.PNG')`;
    expect(imagePathsIn(text)).toEqual(["C:\\proj\\Saved\\shot_01.png", "/tmp/ab/x.jpg", "./out/y.webp", "D:/r/z.PNG"]);
  });

  it("ignores words that only look like extensions", () => {
    expect(imagePathsIn("convert to .png format, image.pngx, foo.png.bak")).toEqual([]);
  });
});

describe("tool image finder", () => {
  let dir: string;
  const old = (file: string) => fs.utimesSync(file, new Date(2000, 0, 1), new Date(2000, 0, 1));

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolimg-"));
    fs.writeFileSync(path.join(dir, "fresh.png"), PNG);
    fs.writeFileSync(path.join(dir, "old.png"), PNG);
    old(path.join(dir, "old.png"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("shows an image a command wrote while it ran, not an old one it merely mentions", () => {
    const tr = new Transcript(() => Date.now(), createToolImageFinder(() => dir));
    tr.apply({ sessionUpdate: "tool_call", toolCallId: "t1", title: "terminal", kind: "execute", status: "in_progress", rawInput: { command: "python shot.py" } });
    tr.apply({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: `wrote ${path.join(dir, "fresh.png")}\nold: old.png` } }] });
    const tool = tr.all()[0];
    expect(tool.kind === "tool" && tool.images?.map((i) => i.name)).toEqual(["fresh.png"]);
    expect(tool.kind === "tool" && tool.images?.[0].src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("shows any image the agent read, however old", () => {
    const tr = new Transcript(() => Date.now(), createToolImageFinder(() => dir));
    tr.apply({ sessionUpdate: "tool_call", toolCallId: "r1", title: "read_file: old.png", kind: "read", status: "completed", locations: [{ path: path.join(dir, "old.png") }] });
    const tool = tr.all()[0];
    expect(tool.kind === "tool" && tool.images?.map((i) => i.name)).toEqual(["old.png"]);
  });

  it("keeps image blocks Hermes returns in tool content", () => {
    const tr = new Transcript();
    tr.apply({ sessionUpdate: "tool_call", toolCallId: "v1", title: "vision", kind: "other", status: "completed", content: [{ type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } }] });
    const tool = tr.all()[0];
    expect(tool.kind === "tool" && tool.images).toEqual([{ src: "data:image/png;base64,AAAA", name: "image-1" }]);
  });
});
