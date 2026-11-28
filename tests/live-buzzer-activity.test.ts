import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActivityManager, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { InvalidQuestionSetError, QuestionSetRepository } from "../src/live-buzzer/question-sets.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";

function questionSet(): GuidedNotesQuestionSet {
  return {
    id: "set-1",
    createdAt: "2026-11-21T00:00:00.000Z",
    sheetName: "學習單",
    totalQuestionCount: 1,
    singleQuestionCount: 1,
    groupQuestionCount: 0,
    questions: [{
      number: 1,
      description: "第一題",
      type: "single",
      subquestions: [{
        number: 1,
        answerCell: { sheetName: "學習單", address: "G5", row: 5, column: 7 },
      }],
    }],
    warnings: [],
  };
}

test("activity starts empty and creates a single in-memory activity with default groups", () => {
  const manager = new ActivityManager();
  assert.equal(manager.getActive(), undefined);

  const source = questionSet();
  const activity = manager.create(source, { activityCode: "1234" });

  assert.equal(manager.getActive(), activity);
  assert.equal(activity.activityCode, "1234");
  assert.equal(activity.stage, "preparing");
  assert.equal(activity.rankingRule, "speed");
  assert.equal(activity.showQuestionDescriptions, false);
  assert.equal(activity.nextSubmissionSequence, 1);
  assert.deepEqual(activity.groups.map(({ name }) => name), ["第 1 組", "第 2 組", "第 3 組", "第 4 組"]);
  assert.equal(activity.questionSet.questions[0]!.description, "第一題");
  assert.notEqual(activity.questionSet, source);
  assert.notEqual(activity.questionSet.questions, source.questions);

  assert.equal(new ActivityManager().getActive(), undefined);
});

test("activity accepts a ranking rule at creation and only changes it while preparing", () => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "1234", rankingRule: "cap" });
  assert.equal(activity.rankingRule, "cap");

  assert.deepEqual(manager.setRankingRule("speed"), { ok: true, rankingRule: "speed" });
  assert.equal(activity.rankingRule, "speed");
  assert.deepEqual(manager.transition("buzzing"), { ok: true, stage: "buzzing" });
  assert.deepEqual(manager.setRankingRule("cap"), {
    ok: false,
    reason: "ranking-rule-locked",
    message: "搶答開始後不能更改排名規則",
  });
  assert.equal(activity.rankingRule, "speed");
  assert.deepEqual(manager.transition("ended"), { ok: true, stage: "ended" });
  assert.deepEqual(manager.setRankingRule("cap"), {
    ok: false,
    reason: "ranking-rule-locked",
    message: "搶答開始後不能更改排名規則",
  });
  assert.equal(activity.rankingRule, "speed");
});

test("activity stage transitions allow only preparing to buzzing to ended", () => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "1234" });

  assert.deepEqual(transitionActivityStage(activity, "ended"), { ok: false, reason: "invalid-transition" });
  assert.equal(activity.stage, "preparing");
  assert.deepEqual(manager.transition("buzzing"), { ok: true, stage: "buzzing" });
  assert.deepEqual(manager.transition("preparing"), { ok: false, reason: "invalid-transition" });
  assert.equal(activity.stage, "buzzing");
  assert.deepEqual(manager.transition("ended"), { ok: true, stage: "ended" });
  assert.deepEqual(manager.transition("buzzing"), { ok: false, reason: "invalid-transition" });
  assert.equal(activity.stage, "ended");
});

test("活動組數只接受 2 到 10 組，拒絕時保留原活動", () => {
  const manager = new ActivityManager();
  const original = manager.create(questionSet(), { activityCode: "1234" });

  assert.throws(() => manager.create(questionSet(), { groupNames: ["一組"] }), /組數須為 2～10 組/u);
  assert.equal(manager.getActive(), original);
  assert.equal(manager.create(questionSet(), { groupNames: ["一組", "二組"] }).groups.length, 2);
  assert.equal(manager.create(questionSet(), { groupNames: Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 組`) }).groups.length, 10);
  const tenGroupActivity = manager.getActive();
  assert.throws(() => manager.create(questionSet(), { groupNames: Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 組`) }), /組數須為 2～10 組/u);
  assert.equal(manager.getActive(), tenGroupActivity);
});

test("question set repository reads valid JSON from a temporary directory", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-sets-"));
  try {
    const dataDirectory = path.join(temporaryDirectory, "data", "guided-notes");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(dataDirectory, "set-1.json"), `${JSON.stringify(questionSet())}\n`, "utf8");
    const repository = new QuestionSetRepository(dataDirectory);

    assert.deepEqual((await repository.list()).map(({ id }) => id), ["set-1"]);
    assert.equal((await repository.get("set-1"))?.questions[0]?.number, 1);
    assert.equal(await repository.get("../escape"), undefined);
    assert.equal(await repository.get("missing"), undefined);

    const manager = new ActivityManager();
    manager.create((await repository.get("set-1"))!, { activityCode: "1234" });
    assert.equal(manager.getActive()?.questionSet.id, "set-1");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("question set repository reads legacy JSON without Google source metadata", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-legacy-set-"));
  try {
    const legacySet = questionSet();
    const legacyRecord = { ...legacySet } as Record<string, unknown>;
    delete legacyRecord.googleSource;
    await writeFile(path.join(temporaryDirectory, "legacy.json"), `${JSON.stringify(legacyRecord)}\n`, "utf8");

    const loaded = await new QuestionSetRepository(temporaryDirectory).get("legacy");
    assert.equal(loaded?.id, "set-1");
    assert.equal(loaded?.googleSource, undefined);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("question set repository rejects malformed JSON shape", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-sets-"));
  try {
    await writeFile(path.join(temporaryDirectory, "bad.json"), JSON.stringify({ id: "bad" }), "utf8");
    await assert.rejects(new QuestionSetRepository(temporaryDirectory).list(), InvalidQuestionSetError);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("question set repository returns an empty list when the data directory is absent", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-sets-"));
  try {
    const missingDirectory = path.join(temporaryDirectory, "absent");
    assert.deepEqual(await new QuestionSetRepository(missingDirectory).list(), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
