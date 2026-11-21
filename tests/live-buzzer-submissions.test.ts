import assert from "node:assert/strict";
import test from "node:test";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { getQuestionResults, submitAnswers } from "../src/live-buzzer/submissions.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";

function questionSet(): GuidedNotesQuestionSet {
  return {
    id: "set-1",
    createdAt: "2026-11-21T00:00:00.000Z",
    sheetName: "學習單",
    totalQuestionCount: 2,
    singleQuestionCount: 1,
    groupQuestionCount: 1,
    questions: [
      {
        number: 1,
        description: "單題",
        type: "single",
        subquestions: [{ number: 1, answerCell: { sheetName: "學習單", address: "G5", row: 5, column: 7 } }],
      },
      {
        number: 2,
        description: "題組",
        type: "group",
        subquestions: [
          { number: 1, answerCell: { sheetName: "學習單", address: "H7", row: 7, column: 8 } },
          { number: 2, answerCell: { sheetName: "學習單", address: "H8", row: 8, column: 8 } },
        ],
      },
    ],
    warnings: [],
  };
}

function buzzingActivity() {
  const activity = createActivityState(questionSet(), { activityCode: "1234" });
  assert.deepEqual(transitionActivityStage(activity, "buzzing"), { ok: true, stage: "buzzing" });
  return activity;
}

test("rejects answers before start and after end without recording or consuming sequence", () => {
  const activity = createActivityState(questionSet());
  assert.deepEqual(submitAnswers(activity, "group-1", 1, { 1: "answer" }), {
    accepted: false,
    reason: "activity-not-buzzing",
  });
  assert.equal(activity.nextSubmissionSequence, 1);
  assert.equal(activity.submissions.size, 0);

  transitionActivityStage(activity, "buzzing");
  transitionActivityStage(activity, "ended");
  assert.deepEqual(submitAnswers(activity, "group-1", 1, { 1: "answer" }), {
    accepted: false,
    reason: "activity-not-buzzing",
  });
  assert.equal(activity.nextSubmissionSequence, 1);
  assert.equal(activity.submissions.size, 0);
});

test("rejects blank, overlong, incomplete, extra and invalid submissions without residue", () => {
  const activity = buzzingActivity();
  const cases = [
    ["blank-answer", 1, { 1: " \t\n" }],
    ["answer-too-long", 1, { 1: "😀".repeat(201) }],
    ["incomplete-answer-set", 2, { 1: "only one" }],
    ["incomplete-answer-set", 2, { 1: "one", 2: "two", 3: "extra" }],
    ["blank-answer", 2, { 1: "one", 2: "　" }],
    ["unknown-group", 1, { 1: "answer" }],
    ["unknown-question", 99, { 1: "answer" }],
  ] as const;

  for (const [reason, questionNumber, answers] of cases) {
    assert.deepEqual(submitAnswers(activity, reason === "unknown-group" ? "missing" : "group-1", questionNumber, answers), {
      accepted: false,
      reason,
    });
  }
  assert.equal(activity.submissions.size, 0);
  assert.equal(activity.nextSubmissionSequence, 1);
});

test("accepts a complete question-group answer as one submission", () => {
  const activity = buzzingActivity();
  const result = submitAnswers(activity, "group-1", 2, { 1: "answer one", 2: "answer two" });

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.submission.sequence, 1);
  assert.deepEqual(result.submission.answers, { 1: "answer one", 2: "answer two" });
  assert.equal(activity.submissions.get(2)?.size, 1);
  assert.equal(activity.nextSubmissionSequence, 2);
});

test("orders near-simultaneous submissions by server sequence and accepts one answer per group and question", async () => {
  const activity = buzzingActivity();
  const [first, sameGroupRace, anotherGroup, anotherQuestion] = await Promise.all([
    Promise.resolve().then(() => submitAnswers(activity, "group-2", 1, { 1: "first" })),
    Promise.resolve().then(() => submitAnswers(activity, "group-2", 1, { 1: "second" })),
    Promise.resolve().then(() => submitAnswers(activity, "group-1", 1, { 1: "third" })),
    Promise.resolve().then(() => submitAnswers(activity, "group-1", 2, { 1: "part one", 2: "part two" })),
  ]);

  assert.equal(first.accepted, true);
  assert.deepEqual(sameGroupRace, { accepted: false, reason: "already-submitted" });
  assert.equal(anotherGroup.accepted, true);
  assert.equal(anotherQuestion.accepted, true);
  if (first.accepted && anotherGroup.accepted && anotherQuestion.accepted) {
    assert.deepEqual([
      first.submission.sequence,
      anotherGroup.submission.sequence,
      anotherQuestion.submission.sequence,
    ], [1, 2, 3]);
  }
  assert.equal(activity.nextSubmissionSequence, 4);
  assert.equal(activity.submissions.get(1)?.size, 2);
});

test("keeps first accepted answer and sequence unchanged after duplicate attempt", () => {
  const activity = buzzingActivity();
  const accepted = submitAnswers(activity, "group-1", 1, { 1: "original" });
  const repeated = submitAnswers(activity, "group-1", 1, { 1: "replacement" });

  assert.equal(accepted.accepted, true);
  assert.deepEqual(repeated, { accepted: false, reason: "already-submitted" });
  assert.equal(activity.nextSubmissionSequence, 2);
  assert.equal(activity.submissions.get(1)?.get("group-1")?.answers[1], "original");
});

test("calculates the first successful group independently for each question", () => {
  const activity = buzzingActivity();
  submitAnswers(activity, "group-3", 1, { 1: "third group" });
  submitAnswers(activity, "group-1", 1, { 1: "first group" });
  submitAnswers(activity, "group-2", 2, { 1: "winner one", 2: "winner two" });

  assert.deepEqual(getQuestionResults(activity), [
    {
      questionNumber: 1,
      successfulGroup: { id: "group-3", name: "第 3 組" },
      answers: { 1: "third group" },
      sequence: 1,
    },
    {
      questionNumber: 2,
      successfulGroup: { id: "group-2", name: "第 2 組" },
      answers: { 1: "winner one", 2: "winner two" },
      sequence: 3,
    },
  ]);
});
