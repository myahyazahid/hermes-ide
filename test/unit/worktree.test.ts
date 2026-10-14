import { existsSync, mkdirSync, mkdtempSync, readFileSync as readRaw, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPatch, branchFor, commitTask, createWorktree, git, headCommit, newTaskId, removeTask, repoRoot, summarize, taskPatch,
} from "../../src/core/worktree";

// Git on Windows may check files out with CRLF; the content is what matters here.
const readFileSync = (file: string, encoding: "utf8") => readRaw(file, encoding).replace(/\r\n/g, "\n");
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

describe("git worktrees for parallel tasks", () => {
  let root: string;
  let storage: string;
  let base: string;

  beforeEach(async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "hermes-wt-"));
    root = path.join(temp, "project with space");
    storage = path.join(temp, "worktrees");
    mkdirSync(root, { recursive: true });
    await git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(path.join(root, "b.txt"), "bee\n");
    await git(root, ["add", "-A"]);
    await git(root, [...ID, "commit", "-q", "-m", "init"]);
    base = (await headCommit(root))!;
  });
  afterEach(() => rmSync(path.dirname(root), { recursive: true, force: true }));

  const makeTask = async (id = "t1") => {
    const dir = path.join(storage, id);
    const branch = branchFor(id);
    expect(await createWorktree(root, dir, branch, base)).toEqual({ ok: true });
    return { dir, branch };
  };

  it("finds the repository root and the base commit", async () => {
    expect((await repoRoot(root))?.toLowerCase()).toBe(path.normalize(realpathSync.native(root)).toLowerCase());
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(await repoRoot(path.join(root, "no-such-folder"))).toBeUndefined();
  });

  it("a task edits its own copy and the project stays untouched until the patch is applied", async () => {
    const { dir } = await makeTask();
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(path.join(dir, "new.txt"), "created by the agent\n");
    rmSync(path.join(dir, "b.txt"));

    const summary = await commitTask(dir, base, "hermes task: test");
    expect(summary.files.sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
    expect(summary.additions).toBe(3); // TWO, four, new.txt
    expect(summary.deletions).toBe(2); // two, b.txt

    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);

    const patch = await taskPatch(dir, base);
    expect(await applyPatch(root, patch)).toEqual({ ok: true });
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nfour\n");
    expect(readFileSync(path.join(root, "new.txt"), "utf8")).toBe("created by the agent\n");
    expect(existsSync(path.join(root, "b.txt"))).toBe(false);
    // applied as uncommitted changes: the user's branch history is not touched
    expect(await headCommit(root)).toBe(base);
  });

  it("two tasks work at the same time without seeing each other", async () => {
    const one = await makeTask("t1");
    const two = await makeTask("t2");
    writeFileSync(path.join(one.dir, "only-one.txt"), "1");
    writeFileSync(path.join(two.dir, "only-two.txt"), "2");
    expect(existsSync(path.join(one.dir, "only-two.txt"))).toBe(false);
    expect((await commitTask(one.dir, base, "one")).files).toEqual(["only-one.txt"]);
    expect((await commitTask(two.dir, base, "two")).files).toEqual(["only-two.txt"]);
  });

  it("refuses a patch that does not fit the working tree, and then changes nothing", async () => {
    const { dir } = await makeTask();
    writeFileSync(path.join(dir, "a.txt"), "one\nFROM-AGENT\nthree\n");
    writeFileSync(path.join(dir, "extra.txt"), "x");
    await commitTask(dir, base, "task");
    const patch = await taskPatch(dir, base);

    writeFileSync(path.join(root, "a.txt"), "one\nFROM-USER\nthree\n"); // the user edited the same line meanwhile
    const result = await applyPatch(root, patch);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\nFROM-USER\nthree\n");
    expect(existsSync(path.join(root, "extra.txt"))).toBe(false); // all or nothing
  });

  it("a task that changed nothing summarises as empty and leaves no commit", async () => {
    const { dir } = await makeTask();
    expect(await commitTask(dir, base, "nothing")).toEqual({ files: [], additions: 0, deletions: 0 });
    expect(await headCommit(dir)).toBe(base);
    expect(await taskPatch(dir, base)).toBe("");
  });

  it("commits even where git has no identity configured", async () => {
    const empty = path.join(path.dirname(root), "empty-gitconfig");
    writeFileSync(empty, "");
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const { dir } = await makeTask(); // checked out under the same (empty) config, so line endings do not differ
      writeFileSync(path.join(dir, "x.txt"), "x");
      expect((await commitTask(dir, base, "no identity")).files).toEqual(["x.txt"]);
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    }
  });

  it("discarding removes the folder and the branch, and can be repeated", async () => {
    const { dir, branch } = await makeTask();
    writeFileSync(path.join(dir, "junk.txt"), "j");
    await commitTask(dir, base, "junk");
    await removeTask(root, dir, branch);
    expect(existsSync(dir)).toBe(false);
    expect((await git(root, ["branch", "--list", branch])).stdout.trim()).toBe("");
    await removeTask(root, dir, branch); // already gone: no throw
    expect((await summarize(root, base)).files).toEqual([]);
  });

  it("reports why a worktree could not be created", async () => {
    const { dir, branch } = await makeTask();
    const again = await createWorktree(root, path.join(storage, "other"), branch, base); // the branch name is taken
    expect(again.ok).toBe(false);
    expect(again.error).toBeTruthy();
    expect(dir).toBeTruthy();
  });

  it("makes ids that are safe in a branch name and a folder name", () => {
    const id = newTaskId(1_800_000_000_000, 0.5);
    expect(id).toMatch(/^[0-9a-z]{8}$/);
    expect(branchFor(id)).toBe(`hermes/task-${id}`);
    expect(newTaskId(1, 0)).not.toBe(newTaskId(2, 0));
  });
});
