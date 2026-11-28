import assert from "node:assert/strict";
import test from "node:test";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import { createStudentView, createTeacherView } from "../src/live-buzzer/views.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";

function questionSet(): GuidedNotesQuestionSet {
  return {
    id: "view-set",
    createdAt: "2026-11-21T00:00:00.000Z",
    sheetName: "學習單",
    totalQuestionCount: 1,
    singleQuestionCount: 0,
    groupQuestionCount: 1,
    questions: [{
      number: 7,
      description: "題目敘述不預設提供",
      type: "group",
      subquestions: [
        { number: 1, answerCell: { sheetName: "學習單", address: "H10", row: 10, column: 8 } },
        { number: 2, answerCell: { sheetName: "學習單", address: "H11", row: 11, column: 8 } },
      ],
    }],
    warnings: [],
  };
}

test("student view uses an explicit allowlist and excludes other groups' answers and ranks", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  activity.nextSubmissionSequence = 987654;
  const accepted = submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" });
  assert.equal(accepted.accepted, true);

  const studentView = createStudentView(activity, "group-1");
  assert.ok(studentView);
  const payload = JSON.stringify(studentView);

  assert.equal(studentView.questions[0]?.description, undefined);
  assert.equal(studentView.questions[0]?.subquestions[0]?.submitted, false);
  assert.equal(studentView.results, null);
  assert.equal(payload.includes("SECRET-ANSWER-B"), false);
  assert.equal(payload.includes("SECOND-SECRET-B"), false);
  assert.equal(payload.includes("987654"), false);
  assert.equal(payload.includes('"sequence"'), false);
  assert.equal(payload.includes('"answers"'), false);
  assert.equal(payload.includes("onlineStudentPages"), false);
});

test("均分上限學生 view 公開規則名稱與說明，但搶答中不含跳過、順位、成敗或他組資料", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468", rankingRule: "cap" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" });

  const view = createStudentView(activity, "group-1");
  assert.ok(view);
  assert.deepEqual(view.rankingRule, { name: "均分上限", explanation: "每組最多成功 1 題" });
  assert.equal(view.results, null);
  const payload = JSON.stringify(view);
  for (const forbidden of ["SECRET-ANSWER-B", "SECOND-SECRET-B", "group-2", "第 2 組", '"rank"', '"originalRank"', '"finalRank"', '"sequence"', '"skipped"', '"successful"']) {
    assert.equal(payload.includes(forbidden), false, `不應包含 ${forbidden}`);
  }
});

test("student view includes question descriptions only when enabled and rejects unknown groups", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  assert.equal(createStudentView(activity, "missing-group"), undefined);
  activity.showQuestionDescriptions = true;

  const view = createStudentView(activity, "group-1");
  assert.equal(view?.questionDescriptionsVisible, true);
  assert.equal(view?.questions[0]?.description, "題目敘述不預設提供");
});

test("ended student view preserves successful-group results while own answers remain group-scoped", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" });
  submitAnswers(activity, "group-1", 7, { 1: "TEAM-A-ANSWER-1", 2: "TEAM-A-ANSWER-2" });
  for (const stage of ["buzzing", "ended"] as const) {
    if (stage === "ended") transitionActivityStage(activity, "ended");
    const view = createStudentView(activity, "group-1");
    assert.deepEqual(view?.questions[0]?.subquestions, [
      { number: 1, submitted: true, answer: "TEAM-A-ANSWER-1" },
      { number: 2, submitted: true, answer: "TEAM-A-ANSWER-2" },
    ]);
    if (stage === "buzzing") {
      assert.equal(view?.results, null);
      const payload = JSON.stringify(view);
      assert.equal(payload.includes("SECRET-ANSWER-B"), false);
      assert.equal(payload.includes("SECOND-SECRET-B"), false);
      assert.equal(payload.includes("group-2"), false);
      assert.equal(payload.includes("第 2 組"), false);
      assert.doesNotMatch(payload, /"(?:rank|originalRank|finalRank)"\s*:/u);
      assert.equal(payload.includes("sequence"), false);
    } else {
      assert.deepEqual(view?.results, [{
        questionNumber: 7,
        successfulGroup: { id: "group-2", name: "第 2 組" },
        answers: [
          { subquestionNumber: 1, answer: "SECRET-ANSWER-B" },
          { subquestionNumber: 2, answer: "SECOND-SECRET-B" },
        ],
      }]);
    }
  }
});

test("teacher view includes per-question rank and preserves internal server sequence", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  activity.nextSubmissionSequence = 987654;
  submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" });

  const teacherView = createTeacherView(activity);
  const payload = JSON.stringify(teacherView);
  assert.equal(teacherView.questions[0]?.groups[1]?.submitted, true);
  assert.equal(teacherView.questions[0]?.groups[1]?.sequence, 987654);
  assert.equal(teacherView.questions[0]?.groups[1]?.rank, 1);
  assert.equal(teacherView.canWriteSpreadsheet, false);
  assert.deepEqual(teacherView.groups.map(({ onlineStudentPages }) => onlineStudentPages), [0, 0, 0, 0]);
  assert.notEqual(teacherView.questions[0]?.groups[1]?.rank, teacherView.questions[0]?.groups[1]?.sequence);
  assert.deepEqual(teacherView.questions[0]?.subquestions, [{ number: 1 }, { number: 2 }]);
  assert.equal(payload.includes("SECRET-ANSWER-B"), true);
  assert.equal(payload.includes("987654"), true);

  const googleActivity = createActivityState({ ...questionSet(), googleSource: { spreadsheetId: "sheets-id", gid: 2 } });
  assert.equal(createTeacherView(googleActivity).canWriteSpreadsheet, true);
  assert.equal(createTeacherView(googleActivity).questionSetSource, "google");
  const xlsxActivity = createActivityState({ ...questionSet(), importSource: "xlsx" });
  assert.equal(createTeacherView(xlsxActivity).questionSetSource, "xlsx");
  const legacyActivity = createActivityState(questionSet());
  assert.equal(createTeacherView(legacyActivity).questionSetSource, "legacy");
});
