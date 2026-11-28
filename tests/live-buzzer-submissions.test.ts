import assert from "node:assert/strict";
import test from "node:test";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { getQuestionRanks, getQuestionResults, submitAnswers } from "../src/live-buzzer/submissions.ts";
import { createResultsCsv, formatCsvSubmittedAt } from "../src/live-buzzer/result-csv.ts";
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

test("records a server ISO timestamp on each accepted submission and shares it across group answers", () => {
  const activity = buzzingActivity();
  const before = Date.now();
  const single = submitAnswers(activity, "group-1", 1, { 1: "single answer" });
  const group = submitAnswers(activity, "group-2", 2, { 1: "part one", 2: "part two" });
  const after = Date.now();

  assert.equal(single.accepted, true);
  assert.equal(group.accepted, true);
  if (!single.accepted || !group.accepted) return;
  for (const submission of [single.submission, group.submission]) {
    assert.match(submission.submittedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
    const timestamp = Date.parse(submission.submittedAt);
    assert.ok(timestamp >= before && timestamp <= after);
  }
  assert.equal(Object.keys(group.submission.answers).length, 2);
  assert.equal(typeof group.submission.submittedAt, "string");
});

test("CSV 送出時間轉為台灣 UTC+8，精確到秒且不含毫秒", () => {
  assert.equal(formatCsvSubmittedAt("2026-11-27T13:47:01.559Z"), "2026-11-27T21:47:01+08:00");
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

test("calculates each question's ranks from one, regardless of global submission sequence", () => {
  const activity = buzzingActivity();
  submitAnswers(activity, "group-2", 1, { 1: "first on question one" });
  submitAnswers(activity, "group-1", 1, { 1: "second on question one" });
  const thirdQuestionSubmission = submitAnswers(activity, "group-3", 2, { 1: "first on question two", 2: "second answer" });

  assert.equal(thirdQuestionSubmission.accepted, true);
  if (thirdQuestionSubmission.accepted) assert.equal(thirdQuestionSubmission.submission.sequence, 3);
  assert.deepEqual([...getQuestionRanks(activity, 1)], [["group-2", 1], ["group-1", 2]]);
  assert.deepEqual([...getQuestionRanks(activity, 2)], [["group-3", 1]]);
});

test("assigns a question-group submission one shared rank for every subquestion", () => {
  const activity = buzzingActivity();
  submitAnswers(activity, "group-1", 2, { 1: "part one", 2: "part two" });
  submitAnswers(activity, "group-3", 2, { 1: "other one", 2: "other two" });

  const ranks = getQuestionRanks(activity, 2);
  assert.equal(ranks.get("group-1"), 1);
  assert.equal(ranks.get("group-3"), 2);
  assert.equal(activity.submissions.get(2)?.get("group-1")?.answers[1], "part one");
  assert.equal(activity.submissions.get(2)?.get("group-1")?.answers[2], "part two");
});

test("CSV 每筆提交每個小題一列，重用各題順位並排序，包含伺服器時間與成功狀態", () => {
  const activity = createActivityState(questionSet(), { groupNames: ["甲隊", "乙隊", "未提交"] });
  transitionActivityStage(activity, "buzzing");
  assert.equal(submitAnswers(activity, "group-1", 1, { 1: "A" }).accepted, true);
  assert.equal(submitAnswers(activity, "group-2", 1, { 1: "B" }).accepted, true);
  assert.equal(submitAnswers(activity, "group-2", 2, { 1: "C", 2: "D" }).accepted, true);
  const firstSubmittedAt = activity.submissions.get(1)!.get("group-1")!.submittedAt;
  const csv = createResultsCsv(activity);
  assert.ok(csv.startsWith("\uFEFF題號,小題,組別,答案,原始順位,最終順位,是否成功,送出時間,說明\r\n"));
  assert.equal(csv, `\uFEFF題號,小題,組別,答案,原始順位,最終順位,是否成功,送出時間,說明\r\n1,1,甲隊,A,1,1,是,${formatCsvSubmittedAt(firstSubmittedAt)},\r\n1,1,乙隊,B,2,2,否,${formatCsvSubmittedAt(activity.submissions.get(1)!.get("group-2")!.submittedAt)},\r\n2,1,乙隊,C,1,1,是,${formatCsvSubmittedAt(activity.submissions.get(2)!.get("group-2")!.submittedAt)},\r\n2,2,乙隊,D,1,1,是,${formatCsvSubmittedAt(activity.submissions.get(2)!.get("group-2")!.submittedAt)},\r\n`);
  assert.doesNotMatch(csv, /未提交/u);
  assert.match(firstSubmittedAt, /^\d{4}-\d\d-\d\dT.*Z$/u);
});

test("CSV 以 UTF-8 BOM 輸出，正確跳脫含逗號、引號、換行與中文的組名和答案", () => {
  const activity = createActivityState(questionSet(), { groupNames: ['甲,"隊"\n二', "未提交組"] });
  transitionActivityStage(activity, "buzzing");
  const answer = '含,逗號"引號\n換行';
  assert.equal(submitAnswers(activity, "group-1", 1, { 1: answer }).accepted, true);
  const csv = createResultsCsv(activity);
  assert.ok(csv.charCodeAt(0) === 0xfeff);
  assert.match(csv, /"甲,""隊""\n二","含,逗號""引號\n換行",1,1,是,/u);
});

test("CSV 對所有欄位的公式前綴加單引號", () => {
  const base = questionSet();
  const values = ["+plus", "-minus", "@at", "\ttab", "\nline"];
  const set: GuidedNotesQuestionSet = {
    ...base,
    totalQuestionCount: values.length,
    singleQuestionCount: values.length,
    groupQuestionCount: 0,
    questions: values.map((_, index) => ({
      number: index + 1,
      description: "題目 " + (index + 1),
      type: "single",
      subquestions: [{ number: 1, answerCell: { sheetName: "學習單", address: "A" + (index + 1), row: index + 1, column: 1 } }],
    })),
  };
  const activity = createActivityState(set, { groupNames: ["=公式組", "一般組"] });
  transitionActivityStage(activity, "buzzing");
  values.forEach((answer, index) => assert.equal(submitAnswers(activity, "group-1", index + 1, { 1: answer }).accepted, true));

  const csv = createResultsCsv(activity);
  assert.match(csv, /'=公式組/u);
  assert.match(csv, /,'\+plus,/u);
  assert.match(csv, /,'-minus,/u);
  assert.match(csv, /,'@at,/u);
  assert.match(csv, /,'\ttab,/u);
  assert.match(csv, /,"'\nline",/u);
});

test("CSV 為完全沒有組別送出的題目輸出空白佔位列", () => {
  const activity = buzzingActivity();
  assert.equal(submitAnswers(activity, "group-1", 1, { 1: "已送出答案" }).accepted, true);

  const csv = createResultsCsv(activity);
  assert.match(csv, /\r\n2,,,,,,,,沒有組別送出\r\n/u);
});
