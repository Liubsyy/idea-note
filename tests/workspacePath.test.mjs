import assert from "node:assert/strict";
import test from "node:test";

import { resolvePathWithinWorkspace } from "../src/lib/workspacePath.ts";

const resolvedPath = (workspace, path) => {
  const result = resolvePathWithinWorkspace(workspace, path);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.path;
};

const rejectsOutside = (workspace, path) => {
  const result = resolvePathWithinWorkspace(workspace, path);
  assert.deepEqual(result, { ok: false, error: "路径不在当前工作区内。" });
};

test("resolves slash variants under a Windows workspace", () => {
  const workspace = "D:\\Dev\\Notes";
  assert.equal(resolvedPath(workspace, "doc"), "D:\\Dev\\Notes\\doc");
  assert.equal(resolvedPath(workspace, "doc/测试.md"), "D:\\Dev\\Notes\\doc\\测试.md");
  assert.equal(resolvedPath(workspace, "doc\\测试.md"), "D:\\Dev\\Notes\\doc\\测试.md");
  assert.equal(resolvedPath(workspace, "."), workspace);
});

test("accepts Windows absolute paths inside the workspace", () => {
  const workspace = "D:\\Dev\\Notes";
  assert.equal(
    resolvedPath(workspace, "d:\\dev\\notes\\doc\\测试.md"),
    "D:\\Dev\\Notes\\doc\\测试.md",
  );
});

test("does not duplicate separators for filesystem-root workspaces", () => {
  assert.equal(resolvedPath("D:\\", "doc\\测试.md"), "D:\\doc\\测试.md");
  assert.equal(resolvedPath("/", "doc/测试.md"), "/doc/测试.md");
});

test("rejects Windows paths outside the workspace", () => {
  const workspace = "D:\\Dev\\Notes";
  rejectsOutside(workspace, "..\\secret.md");
  rejectsOutside(workspace, "D:\\Dev\\Notes-old\\secret.md");
  rejectsOutside(workspace, "C:\\Dev\\Notes\\secret.md");
});

test("resolves and fences POSIX paths case-sensitively", () => {
  const workspace = "/home/user/notes";
  assert.equal(resolvedPath(workspace, "doc/测试.md"), "/home/user/notes/doc/测试.md");
  assert.equal(
    resolvedPath(workspace, "/home/user/notes/doc/测试.md"),
    "/home/user/notes/doc/测试.md",
  );
  rejectsOutside(workspace, "../secret.md");
  rejectsOutside(workspace, "/home/user/Notes/secret.md");
});

test("preserves UNC paths", () => {
  const workspace = "\\\\server\\share\\notes";
  assert.equal(
    resolvedPath(workspace, "doc\\测试.md"),
    "\\\\server\\share\\notes\\doc\\测试.md",
  );
  rejectsOutside(workspace, "\\\\server\\share\\notes-old\\secret.md");
});
