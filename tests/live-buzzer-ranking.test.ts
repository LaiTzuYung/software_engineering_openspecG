import assert from "node:assert/strict";
import test from "node:test";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";
import { calculateRankingResults, getQuestionRanks, getQuestionResults, submitAnswers } from "../src/live-buzzer/submissions.ts";

function questionSet(types: readonly ("single" | "group")[]): GuidedNotesQuestionSet {
  const questions = types.map((type, index) => ({
    number: index + 1,
    description: `題目 ${index + 1}`,
    type,
    subquestions: Array.from({ length: type === "group" ? 2 : 1 }, (_, subquestionIndex) => ({
      number: subquestionIndex + 1,
      answerCell: {
        sheetName: "學習單",
        address: `H${index * 2 + subquestionIndex + 1}`,
        row: index * 2 + subquestionIndex + 1,
        column: 8,
      },
    })),
  }));
  const groupCount = questions.filter(({ type }) => type === "group").length;
  return {
    id: "ranking-set",
    createdAt: "2026-11-28T00:00:00.000Z",
    sheetName: "學習單",
    totalQuestionCount: questions.length,
    singleQuestionCount: questions.length - groupCount,
    groupQuestionCount: groupCount,
    questions,
    warnings: [],
  };
}

function activityFor(
  types: readonly ("single" | "group")[],
  groupNames: readonly string[],
) {
  const activity = createActivityState(questionSet(types), { groupNames });
  assert.deepEqual(transitionActivityStage(activity, "buzzing"), { ok: true, stage: "buzzing" });
  return activity;
}

function submit(activity: ReturnType<typeof activityFor>, groupId: string, questionNumber: number): void {
  const question = activity.questionSet.questions.find(({ number }) => number === questionNumber);
  assert.ok(question);
  const answers = Object.fromEntries(question.subquestions.map(({ number }) => [number, `答案 ${groupId}-${number}`]));
  const result = submitAnswers(activity, groupId, questionNumber, answers);
  assert.equal(result.accepted, true);
}

test("決策單 2-15：跨題逐筆套用均分上限並由第 2 組遞補第 1 題", () => {
  const activity = activityFor(["single", "single"], ["第 1 組", "第 2 組"]);
  submit(activity, "group-1", 2);
  submit(activity, "group-1", 1);
  submit(activity, "group-2", 1);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.cap, 1);
  assert.deepEqual(result.submissions.map(({ submission, originalRank, finalRank, successful, explanation }) => ({
    questionNumber: submission.questionNumber,
    groupId: submission.groupId,
    originalRank, finalRank, successful, explanation,
  })), [
    { questionNumber: 2, groupId: "group-1", originalRank: 1, finalRank: 1, successful: true, explanation: "" },
    { questionNumber: 1, groupId: "group-1", originalRank: 1, finalRank: null, successful: false, explanation: "第 1 組已達上限 1 題" },
    { questionNumber: 1, groupId: "group-2", originalRank: 2, finalRank: 1, successful: true, explanation: "遞補：第 1 組已達上限" },
  ]);
  assert.deepEqual(result.questions.map(({ questionNumber, successfulGroup }) => [questionNumber, successfulGroup?.name ?? null]), [
    [1, "第 2 組"],
    [2, "第 1 組"],
  ]);
});

test("均分上限下，單一送出組的提交全部被跳過時顯示唯一送出原因", () => {
  const activity = activityFor(["single", "single", "single"], ["第 1 組", "第 2 組", "第 3 組", "第 4 組"]);
  submit(activity, "group-1", 1);
  submit(activity, "group-1", 3);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.questions[2]?.explanation, "唯一送出的第 1 組已達上限 1 題");
  assert.equal(result.submissions[1]?.explanation, "第 1 組已達上限 1 題");
  assert.equal(result.questions[2]?.successfulGroup, null);
});

test("均分上限下，多組提交全部被跳過時按組別順序列出原因", () => {
  const activity = activityFor(["single", "single", "single"], ["第 1 組", "第 2 組", "第 3 組", "第 4 組"]);
  submit(activity, "group-1", 1);
  submit(activity, "group-2", 2);
  submit(activity, "group-1", 3);
  submit(activity, "group-2", 3);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.questions[2]?.explanation, "送出的第 1 組、第 2 組都已達上限 1 題");
  assert.equal(result.questions[2]?.successfulGroup, null);
});

test("題組視為一題計算 cap，完整題組提交只占一個成功名額", () => {
  const activity = activityFor(["group", "single"], ["第 1 組", "第 2 組"]);
  submit(activity, "group-1", 1);
  submit(activity, "group-1", 2);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.cap, 1);
  assert.equal(result.submissions[0]?.successful, true);
  assert.equal(result.submissions[1]?.skipped, true);
  assert.equal(result.questions[0]?.successfulGroup?.name, "第 1 組");
});

test("組數多於題數時均分上限仍為 1", () => {
  const activity = activityFor(["single", "single"], ["第 1 組", "第 2 組", "第 3 組", "第 4 組"]);

  assert.equal(calculateRankingResults(activity, "cap").cap, 1);
});

test("無人作答的題目仍計入活動總題數與均分上限", () => {
  const activity = activityFor(["single", "single", "single"], ["第 1 組", "第 2 組"]);
  submit(activity, "group-1", 1);
  submit(activity, "group-1", 2);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.cap, 2);
  assert.equal(result.questions[1]?.successfulGroup?.name, "第 1 組");
  assert.equal(result.questions[2]?.successfulGroup, null);
  assert.equal(result.questions[2]?.explanation, null);
});

test("組別達上限後即使該題已有成功組，該組提交仍標為跳過", () => {
  const activity = activityFor(["single", "single", "single"], ["第 1 組", "第 2 組", "第 3 組"]);
  submit(activity, "group-2", 1);
  submit(activity, "group-1", 2);
  submit(activity, "group-1", 1);

  const result = calculateRankingResults(activity, "cap");
  assert.equal(result.submissions[2]?.skipped, true);
  assert.equal(result.submissions[2]?.finalRank, null);
  assert.equal(result.submissions[2]?.explanation, "第 1 組已達上限 1 題");
  assert.equal(result.questions[0]?.successfulGroup?.name, "第 2 組");
});

test("最終順位只計未跳過提交，跳過的原始順位不造成最終順位跳號", () => {
  const activity = activityFor(
    ["single", "single", "single", "single"],
    ["第 1 組", "第 2 組", "第 3 組"],
  );
  submit(activity, "group-2", 1);
  submit(activity, "group-1", 2);
  submit(activity, "group-1", 3);
  submit(activity, "group-1", 1);
  submit(activity, "group-3", 1);

  const questionOne = calculateRankingResults(activity, "cap").submissions.filter(({ submission }) => submission.questionNumber === 1);
  assert.deepEqual(questionOne.map(({ originalRank, finalRank, skipped }) => [originalRank, finalRank, skipped]), [
    [1, 1, false],
    [2, null, true],
    [3, 2, false],
  ]);
});

test("純速度結果與既有 getQuestionRanks、getQuestionResults 完全相同", () => {
  const activity = activityFor(["single", "group", "single"], ["第 1 組", "第 2 組", "第 3 組"]);
  submit(activity, "group-2", 1);
  submit(activity, "group-1", 2);
  submit(activity, "group-3", 2);
  submit(activity, "group-3", 3);

  const result = calculateRankingResults(activity);
  assert.equal(result.rule, "speed");
  assert.equal(result.cap, null);
  assert.deepEqual(result.questions.map(({ questionNumber, successfulGroup, answers, sequence }) => ({
    questionNumber, successfulGroup, answers, sequence,
  })), getQuestionResults(activity));
  for (const rankedSubmission of result.submissions) {
    const { submission } = rankedSubmission;
    const rank = getQuestionRanks(activity, submission.questionNumber).get(submission.groupId);
    assert.equal(rankedSubmission.originalRank, rank);
    assert.equal(rankedSubmission.finalRank, rank);
    assert.equal(rankedSubmission.successful, result.questions.find(({ questionNumber }) => questionNumber === submission.questionNumber)?.successfulGroup?.id === submission.groupId);
    assert.equal(rankedSubmission.explanation, "");
    assert.equal(rankedSubmission.skipped, false);
  }
});
