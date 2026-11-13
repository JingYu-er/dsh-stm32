import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { recallWorkspace, rememberWorkspace, workspaceMemoPath } from "../lib/engine/workspace-memo.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("workspaceMemoPath：默认在 ~/.dsh-stm32 下，可用 DSH_STM32_HOME 覆盖", () => {
  const home = tempDir("memo-home-");
  const env = { DSH_STM32_HOME: home };
  assert.equal(workspaceMemoPath(env), path.join(home, "last-workspace.txt"));
  assert.match(workspaceMemoPath({}), /\.dsh-stm32[\\/]last-workspace\.txt$/u);
});

test("rememberWorkspace：写入后可读回，空白目录不覆盖已有记录", () => {
  const env = { DSH_STM32_HOME: tempDir("memo-write-") };
  assert.equal(recallWorkspace(env), "", "没写过时读回空串");

  rememberWorkspace("D:/work/demo", env);
  assert.equal(recallWorkspace(env), "D:/work/demo");

  rememberWorkspace("   ", env);
  assert.equal(recallWorkspace(env), "D:/work/demo", "空白目录不该把记录清掉");

  rememberWorkspace("D:/work/other", env);
  assert.equal(recallWorkspace(env), "D:/work/other", "后写覆盖前写");
});

test("recallWorkspace：目录不存在时返回空串而不是抛错", () => {
  const env = { DSH_STM32_HOME: path.join(tempDir("memo-missing-"), "nope") };
  assert.equal(recallWorkspace(env), "");
});
