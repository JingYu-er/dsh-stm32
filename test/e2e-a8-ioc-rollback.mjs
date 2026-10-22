// A8：apply 中途失败 / 事后回滚，都要让 .ioc 字节级还原（SHA-256 一致）。
// 跑法：node test\e2e-a8-ioc-rollback.mjs
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyIocPlan, planIocChanges, rollbackIoc, sha256Hex } from "../lib/engine/ioc-plan.js";
import { freshCopy, log } from "./harness.mjs";
import { e2eProject, e2eWorkDir } from "./fixtures.mjs";

const SOURCE = e2eProject();
const TARGET = e2eWorkDir("a8");

freshCopy(SOURCE, TARGET);
const iocPath = join(TARGET, "blink.ioc");
const original = readFileSync(iocPath, "utf8");
const originalSha = sha256Hex(original);

// ── 1) 正常 apply：SHA 必须变成候选的，且备份就是原文件 ─────────────────────────
const plan = planIocChanges({ projectDir: TARGET, pins: [{ pin: "PA5", signal: "output", label: "led2" }] });
log("plan：", plan.ok, plan.message, "changes=", plan.changes.length);
assert.equal(plan.ok, true, plan.message);

const applied = applyIocPlan({ projectDir: TARGET, planId: plan.planId });
log("apply：", applied.ok, applied.message);
assert.equal(applied.ok, true, applied.message);
assert.equal(applied.shaBefore, originalSha);
assert.equal(applied.shaAfter, plan.candidateSha256);
assert.equal(readFileSync(applied.backupPath, "utf8"), original, "备份必须与原文件逐字节一致");

// ── 2) 回滚：SHA 必须回到原值（这才是 A8 要的"字节级还原"）─────────────────────
const rolled = rollbackIoc({ projectDir: TARGET, backupFrom: applied.backupPath });
log("rollback：", rolled.ok, rolled.message);
assert.equal(rolled.ok, true, rolled.message);
const afterRollback = readFileSync(iocPath, "utf8");
assert.equal(afterRollback, original, "回滚后必须逐字节等于原文件");
assert.equal(sha256Hex(afterRollback), originalSha);

// ── 3) 中途失败：plan 之后有人改了 .ioc → apply 必须拒写，文件 SHA 不变 ──────────
const plan2 = planIocChanges({ projectDir: TARGET, pins: [{ pin: "PA6", signal: "output", label: "led3" }] });
assert.equal(plan2.ok, true, plan2.message);
const tampered = afterRollback.replace("Mcu.PinsNb=8", "Mcu.PinsNb=9");
writeFileSync(iocPath, tampered);
const tamperedSha = sha256Hex(tampered);

const refused = applyIocPlan({ projectDir: TARGET, planId: plan2.planId });
log("被改过后的 apply：", refused.ok, refused.message);
assert.equal(refused.ok, false, "plan 之后 .ioc 被改，apply 必须拒绝");
assert.match(refused.message, /被改过|重新 plan/u);
assert.equal(sha256Hex(readFileSync(iocPath, "utf8")), tamperedSha, "拒绝时不能动文件");

// ── 4) 中途失败：候选文件被动过 → 同样拒写 ───────────────────────────────────
// 先把 .ioc 还原：刚才故意写坏成 PinsNb=9 却没有 Mcu.Pin8，plan 自己就会拒绝（不连续），
// 那是另一条守卫，不该混进这一段。
writeFileSync(iocPath, original);
const plan3 = planIocChanges({ projectDir: TARGET, pins: [{ pin: "PA7", signal: "output", label: "led4" }] });
assert.equal(plan3.ok, true, plan3.message);
const planFile = JSON.parse(readFileSync(join(TARGET, ".dsh-stm32/plans", plan3.planId + ".json"), "utf8"));
writeFileSync(planFile.candidatePath, readFileSync(planFile.candidatePath, "utf8") + "\r\n# tampered\r\n");
const refused2 = applyIocPlan({ projectDir: TARGET, planId: plan3.planId });
log("候选被改过后的 apply：", refused2.ok, refused2.message);
assert.equal(refused2.ok, false, "候选被改，apply 必须拒绝");
assert.equal(sha256Hex(readFileSync(iocPath, "utf8")), originalSha, "拒绝时不能动文件");

log("A8 PASS：apply→rollback SHA " + originalSha.slice(0, 12) + " → " + applied.shaAfter.slice(0, 12) + " → " + originalSha.slice(0, 12));
