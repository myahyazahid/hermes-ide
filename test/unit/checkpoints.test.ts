import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/core/checkpoints";

let base: string;
let ws: string;
let store: CheckpointStore;
let clock: number;

const file = (rel: string) => path.join(ws, ...rel.split("/"));
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(file(rel)), { recursive: true });
  writeFileSync(file(rel), text);
};
const read = (rel: string) => readFileSync(file(rel), "utf8");
const S = "session-1";

/** One agent turn: snapshot, then the "agent" edits through `edit`, then the turn ends. */
function agentTurn(turn: number, paths: string[], edit: () => void, label = `turn ${turn}`) {
  store.begin(S, turn, label);
  store.recordBefore(S, turn, paths.map(file));
  edit();
  store.finish(S, turn);
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "hermes-cp-"));
  ws = path.join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  clock = 1_000;
  store = new CheckpointStore(path.join(base, "store"), { cwd: ws, now: () => clock++, caseInsensitive: false });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("restoring to a checkpoint", () => {
  it("puts back edited files and removes files the agent created", () => {
    write("src/a.ts", "original a");
    agentTurn(0, ["src/a.ts", "src/new.ts"], () => {
      write("src/a.ts", "agent a");
      write("src/new.ts", "created by agent");
    });
    expect([...store.restorableTurns(S)]).toEqual([0]);

    const plan = store.plan(S, 0);
    expect(plan.items.map((i) => `${i.action}:${i.path}`)).toEqual(["write:src/a.ts", "delete:src/new.ts"]);
    expect(plan.items.every((i) => !i.modifiedSince)).toBe(true);

    const result = store.restore(S, 0);
    expect(result).toMatchObject({ written: 1, deleted: 1 });
    expect(read("src/a.ts")).toBe("original a");
    expect(existsSync(file("src/new.ts"))).toBe(false);
  });

  it("restores a file the agent deleted", () => {
    write("keep.txt", "precious");
    agentTurn(0, ["keep.txt"], () => rmSync(file("keep.txt")));
    expect(store.plan(S, 0).items).toMatchObject([{ action: "write", path: "keep.txt" }]);
    store.restore(S, 0);
    expect(read("keep.txt")).toBe("precious");
  });

  it("goes back to the state before the chosen turn, undoing all later turns too", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt"], () => write("a.txt", "v1"));
    agentTurn(1, ["a.txt", "b.txt"], () => {
      write("a.txt", "v2");
      write("b.txt", "b1");
    });
    agentTurn(2, ["a.txt"], () => write("a.txt", "v3"));

    store.restore(S, 1); // before turn 1: a.txt is v1, b.txt does not exist
    expect(read("a.txt")).toBe("v1");
    expect(existsSync(file("b.txt"))).toBe(false);
    expect([...store.restorableTurns(S)]).toEqual([0]); // turns 1 and 2 are gone

    store.restore(S, 0);
    expect(read("a.txt")).toBe("v0");
  });

  it("keeps the first snapshot when a file is edited several times in one turn", () => {
    write("a.txt", "v0");
    store.begin(S, 0, "t");
    store.recordBefore(S, 0, [file("a.txt")]);
    write("a.txt", "v1");
    store.recordBefore(S, 0, [file("a.txt")]); // second edit in the same turn must not replace the original
    write("a.txt", "v2");
    store.finish(S, 0);
    store.restore(S, 0);
    expect(read("a.txt")).toBe("v0");
  });

  it("does nothing for files that already match, and is not offered for turns that changed nothing", () => {
    write("a.txt", "same");
    agentTurn(0, ["a.txt"], () => {});
    expect(store.restorableTurns(S).size).toBe(0);
    expect(store.plan(S, 0).items).toEqual([]);
  });

  it("flags files that someone changed after the agent's edit", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt"], () => write("a.txt", "agent"));
    write("a.txt", "user typed more");
    const plan = store.plan(S, 0);
    expect(plan.items).toMatchObject([{ path: "a.txt", modifiedSince: true }]);
  });

  it("preserves bytes exactly, including CRLF and binary content", () => {
    const bytes = Buffer.from([0, 255, 13, 10, 7, 0, 1]);
    mkdirSync(ws, { recursive: true });
    writeFileSync(file("data.bin"), bytes);
    agentTurn(0, ["data.bin"], () => writeFileSync(file("data.bin"), "text"));
    store.restore(S, 0);
    expect(readFileSync(file("data.bin")).equals(bytes)).toBe(true);
  });
});

describe("undoing a restore", () => {
  it("brings back the agent's version and the dropped checkpoints", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt", "n.txt"], () => {
      write("a.txt", "agent");
      write("n.txt", "new");
    });
    store.restore(S, 0);
    expect(read("a.txt")).toBe("v0");
    expect(store.canUndo(S)).toBe(true);
    expect(store.restorableTurns(S).size).toBe(0);

    expect(store.undoRestore(S)).toMatchObject({ written: 2, deleted: 0 });
    expect(read("a.txt")).toBe("agent");
    expect(read("n.txt")).toBe("new");
    expect(store.canUndo(S)).toBe(false);
    expect([...store.restorableTurns(S)]).toEqual([0]); // can restore again
    expect(store.undoRestore(S)).toBeUndefined();
  });

  it("captures changes the user made after the agent, so a restore never destroys work", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt"], () => write("a.txt", "agent"));
    write("a.txt", "user added work");
    store.restore(S, 0);
    expect(read("a.txt")).toBe("v0");
    store.undoRestore(S);
    expect(read("a.txt")).toBe("user added work");
  });
});

describe("scope limits", () => {
  it("lists files outside the workspace as skipped instead of touching them", () => {
    const outside = path.join(base, "outside.txt");
    writeFileSync(outside, "elsewhere");
    store.begin(S, 0, "t");
    store.recordBefore(S, 0, [outside]);
    writeFileSync(outside, "changed");
    store.finish(S, 0);
    const plan = store.plan(S, 0);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ path: path.resolve(outside), reason: "outside" }]);
    store.restore(S, 0);
    expect(readFileSync(outside, "utf8")).toBe("changed");
  });

  it("skips files over the size limit", () => {
    const small = new CheckpointStore(path.join(base, "store2"), { cwd: ws, maxFileBytes: 10, caseInsensitive: false });
    write("big.txt", "x".repeat(50));
    small.begin(S, 0, "t");
    small.recordBefore(S, 0, [file("big.txt")]);
    expect(small.plan(S, 0).skipped).toEqual([{ path: "big.txt", reason: "too-large" }]);
  });

  it("ignores directories", () => {
    mkdirSync(file("dir"), { recursive: true });
    store.begin(S, 0, "t");
    store.recordBefore(S, 0, [file("dir")]);
    expect(store.plan(S, 0).items).toEqual([]);
  });

  it("remembers which turns ran terminal commands", () => {
    store.begin(S, 0, "t");
    store.noteCommand(S, 0);
    store.begin(S, 1, "u");
    expect([...store.commandTurns(S)]).toEqual([0]);
    expect(store.plan(S, 0).ranCommand).toBe(true);
    expect(store.plan(S, 1).ranCommand).toBe(false);
  });

  it("treats paths case-insensitively when configured for Windows", () => {
    const win = new CheckpointStore(path.join(base, "store3"), { cwd: ws, caseInsensitive: true });
    write("Readme.md", "v0");
    win.begin(S, 0, "t");
    win.recordBefore(S, 0, [file("Readme.md")]);
    win.recordBefore(S, 0, [file("README.MD")]);
    write("Readme.md", "v1");
    win.finish(S, 0);
    expect(win.plan(S, 0).items).toHaveLength(1);
  });
});

describe("persistence and housekeeping", () => {
  it("survives a new store instance (restart of the extension host)", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt"], () => write("a.txt", "agent"));
    const again = new CheckpointStore(path.join(base, "store"), { cwd: ws, caseInsensitive: false });
    expect([...again.restorableTurns(S)]).toEqual([0]);
    again.restore(S, 0);
    expect(read("a.txt")).toBe("v0");
  });

  it("starts empty instead of failing on a corrupt manifest", () => {
    write("a.txt", "v0");
    agentTurn(0, ["a.txt"], () => write("a.txt", "agent"));
    writeFileSync(path.join(base, "store", S, "manifest.json"), "{not json");
    const again = new CheckpointStore(path.join(base, "store"), { cwd: ws, caseInsensitive: false });
    expect(again.restorableTurns(S).size).toBe(0);
  });

  it("stores identical content once", () => {
    write("a.txt", "same content");
    write("b.txt", "same content");
    agentTurn(0, ["a.txt", "b.txt"], () => {});
    expect(readdirSync(path.join(base, "store", "_blobs"))).toHaveLength(1);
  });

  it("prunes old sessions and the blobs only they used, but keeps fresh ones", () => {
    write("old.txt", "old content");
    write("new.txt", "new content");
    store.begin("old-session", 0, "t");
    store.recordBefore("old-session", 0, [file("old.txt")]);
    store.begin("new-session", 0, "t");
    store.recordBefore("new-session", 0, [file("new.txt")]);
    const oldManifest = path.join(base, "store", "old-session", "manifest.json");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(oldManifest, longAgo, longAgo);

    const real = new CheckpointStore(path.join(base, "store"), { cwd: ws, caseInsensitive: false });
    expect(real.prune(30 * 86_400_000)).toBe(1);
    expect(existsSync(path.join(base, "store", "old-session"))).toBe(false);
    expect(existsSync(path.join(base, "store", "new-session"))).toBe(true);
    expect(readdirSync(path.join(base, "store", "_blobs"))).toHaveLength(1);
    expect(statSync(path.join(base, "store", "_blobs")).isDirectory()).toBe(true);
  });

  it("makes session ids safe as folder names", () => {
    store.begin("../../evil/session", 0, "t");
    expect(readdirSync(path.join(base, "store"))).toEqual([".._.._evil_session"]);
  });
});
