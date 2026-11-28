import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActivityState } from "../src/live-buzzer/model.ts";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import {
  ActivitySnapshotStore,
  createActivitySnapshot,
  restoreActivitySnapshot,
  type StudentSessionIdentity,
} from "../src/live-buzzer/activity-persistence.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";

function questionSet(): GuidedNotesQuestionSet {
  return {
    id: "snapshot-set", createdAt: "2026-11-28T00:00:00.000Z", sheetName: "快照題目",
    totalQuestionCount: 2, singleQuestionCount: 2, groupQuestionCount: 0,
    questions: [
      { number: 1, description: "題目一", type: "single", subquestions: [{ number: 1, answerCell: { sheetName: "快照題目", address: "C2", row: 2, column: 3 } }] },
      { number: 2, description: "題目二", type: "single", subquestions: [{ number: 1, answerCell: { sheetName: "快照題目", address: "C3", row: 3, column: 3 } }] },
    ],
    warnings: [],
  };
}

function sampleSnapshot() {
  const activity = createActivityState(questionSet(), {
    activityCode: "4826", groupNames: ["紅隊", "藍隊"], rankingRule: "cap",
  });
  activity.stage = "buzzing";
  activity.showQuestionDescriptions = true;
  assert.equal(submitAnswers(activity, "group-2", 1, { 1: "藍隊答案" }).accepted, true);
  const identities = new Map<string, StudentSessionIdentity>([
    ["session-token-a", { activityCode: "4826", groupId: "group-1" }],
    ["session-token-b", { activityCode: "4826", groupId: "group-2" }],
  ]);
  return { activity, identities, snapshot: createActivitySnapshot(activity, identities) };
}

test("活動快照保留設定、題目集副本、提交及 session 對應，並能重建提交 Map", () => {
  const { snapshot } = sampleSnapshot();
  const restored = restoreActivitySnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.activity.activityCode, "4826");
  assert.equal(restored.activity.stage, "buzzing");
  assert.equal(restored.activity.rankingRule, "cap");
  assert.equal(restored.activity.showQuestionDescriptions, true);
  assert.equal(restored.activity.nextSubmissionSequence, 2);
  assert.deepEqual(restored.activity.submissions.get(1)?.get("group-2"), {
    groupId: "group-2", questionNumber: 1, sequence: 1,
    submittedAt: snapshot.activity.submissions[0]?.submittedAt,
    answers: { 1: "藍隊答案" },
  });
  assert.deepEqual([...restored.studentSessions], [...sampleSnapshot().identities]);
});

test("快照包含建立活動時的題目集副本，不依賴來源物件後續變更", () => {
  const { activity, snapshot } = sampleSnapshot();
  (activity.questionSet.questions[0] as unknown as { description: string }).description = "來源物件後來被修改";
  const restored = restoreActivitySnapshot(snapshot);
  assert.equal(restored.activity.questionSet.questions[0]?.description, "題目一");
});

test("快照驗證失敗時拒載整份活動而非部分恢復", () => {
  const { snapshot } = sampleSnapshot();
  const malformed = structuredClone(snapshot) as unknown as Record<string, any>;
  malformed.activity.stage = "paused";
  assert.throws(() => restoreActivitySnapshot(malformed), /活動快照格式無效/u);

  const invalidSequence = structuredClone(snapshot) as unknown as Record<string, any>;
  invalidSequence.activity.nextSubmissionSequence = 1;
  assert.throws(() => restoreActivitySnapshot(invalidSequence), /活動快照格式無效/u);
});

test("暫存檔寫完再原子替換，序列化寫入不留下臨時檔", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "activity-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { snapshot } = sampleSnapshot();
  const store = new ActivitySnapshotStore(directory, () => {});
  const firstWrite = store.save(snapshot);
  const laterSnapshot = { ...snapshot, activity: { ...snapshot.activity, stage: "ended" as const } };
  const secondWrite = store.save(laterSnapshot);
  await Promise.all([firstWrite, secondWrite]);
  const second = await readFile(store.filePath, "utf8");
  assert.equal(JSON.parse(second).activity.stage, "ended");
  assert.deepEqual((await readdir(directory)).sort(), [path.basename(store.filePath)]);
});

test("一次寫檔失敗後存檔佇列可繼續寫入較新的快照", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "activity-snapshot-queue-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { snapshot } = sampleSnapshot();
  const store = new ActivitySnapshotStore(directory, () => {});
  const internalStore = store as unknown as { writeAtomically(contents: string): Promise<void> };
  const writeAtomically = internalStore.writeAtomically.bind(store);
  let failOnce = true;
  internalStore.writeAtomically = async (contents) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("模擬暫存檔寫入失敗");
    }
    await writeAtomically(contents);
  };

  await assert.rejects(store.save(snapshot), /模擬暫存檔寫入失敗/u);
  await store.save({ ...snapshot, activity: { ...snapshot.activity, stage: "ended" } });
  assert.equal((await store.load())?.activity.stage, "ended");
});

test("讀取損壞或不支援版本時回傳無活動並保留原檔", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "activity-snapshot-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const errors: string[] = [];
  const store = new ActivitySnapshotStore(directory, (message) => errors.push(message));
  await writeFile(store.filePath, "{ invalid json", "utf8");
  assert.equal(await store.load(), undefined);
  assert.equal(await readFile(store.filePath, "utf8"), "{ invalid json");
  await writeFile(store.filePath, JSON.stringify({ version: 99, activity: {} }), "utf8");
  assert.equal(await store.load(), undefined);
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).version, 99);
  assert.equal(errors.length, 2);
});

