import assert from "node:assert/strict";
import test from "node:test";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import { createScreenView, createStudentView, createTeacherView } from "../src/live-buzzer/views.ts";
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

function twoQuestionSet(): GuidedNotesQuestionSet {
  const set = questionSet();
  return {
    ...set,
    totalQuestionCount: 2,
    groupQuestionCount: 2,
    questions: [set.questions[0]!, { ...set.questions[0]!, number: 8 }],
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
    if (stage === "buzzing") {
      assert.deepEqual(view?.questions[0]?.subquestions, [
        { number: 1, submitted: true, answer: "TEAM-A-ANSWER-1" },
        { number: 2, submitted: true, answer: "TEAM-A-ANSWER-2" },
      ]);
      assert.equal(view?.results, null);
      const payload = JSON.stringify(view);
      assert.equal(payload.includes("SECRET-ANSWER-B"), false);
      assert.equal(payload.includes("SECOND-SECRET-B"), false);
      assert.equal(payload.includes("group-2"), false);
      assert.equal(payload.includes("第 2 組"), false);
      assert.doesNotMatch(payload, /"(?:rank|originalRank|finalRank)"\s*:/u);
      assert.equal(payload.includes("sequence"), false);
    } else {
      assert.deepEqual(view?.questions[0]?.subquestions, [
        { number: 1, submitted: true, answer: "TEAM-A-ANSWER-1" },
        { number: 2, submitted: true, answer: "TEAM-A-ANSWER-2" },
      ]);
      assert.deepEqual(view?.results, [{
        questionNumber: 7,
        successfulGroup: { id: "group-2", name: "第 2 組" },
        answers: [
          { subquestionNumber: 1, answer: "SECRET-ANSWER-B" },
          { subquestionNumber: 2, answer: "SECOND-SECRET-B" },
        ],
        otherSubmissions: [{ group: { id: "group-1", name: "第 1 組" }, originalRank: 2, skipped: false }],
      explanation: null,
      }]);
    }
  }
});

test("ended student result includes the no-success explanation for a skipped-only question", () => {
  const activity = createActivityState(twoQuestionSet(), { activityCode: "2468", rankingRule: "cap" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-1", 7, { 1: "ANSWER-1", 2: "ANSWER-2" });
  submitAnswers(activity, "group-1", 8, { 1: "ANSWER-3", 2: "ANSWER-4" });
  transitionActivityStage(activity, "ended");

  const view = createStudentView(activity, "group-1");
  assert.equal(view?.results?.[1]?.explanation, "唯一送出的第 1 組已達上限 1 題");
});

test("ended student result with no submissions has no winner, answers, or other submissions", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  transitionActivityStage(activity, "ended");
  const view = createStudentView(activity, "group-1");
  assert.deepEqual(view?.results, [{
    questionNumber: 7, successfulGroup: null, answers: null, explanation: null, otherSubmissions: [],
  }]);
});

test("ended student results show original ranks and skipped status without other answers", () => {
  const activity = createActivityState(twoQuestionSet(), { activityCode: "2468", rankingRule: "cap" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-1", 7, { 1: "WINNER-A", 2: "WINNER-B" });
  submitAnswers(activity, "group-2", 7, { 1: "OTHER-A", 2: "OTHER-B" });
  submitAnswers(activity, "group-1", 8, { 1: "SKIP-A", 2: "SKIP-B" });
  submitAnswers(activity, "group-2", 8, { 1: "WINNER-C", 2: "WINNER-D" });
  transitionActivityStage(activity, "ended");
  const view = createStudentView(activity, "group-3");
  assert.deepEqual(view?.results?.[0]?.otherSubmissions, [{ group: { id: "group-2", name: "第 2 組" }, originalRank: 2, skipped: false }]);
  assert.deepEqual(view?.results?.[1]?.otherSubmissions, [{ group: { id: "group-1", name: "第 1 組" }, originalRank: 1, skipped: true }]);
  for (const entry of view?.results?.flatMap(({ otherSubmissions }) => otherSubmissions) ?? []) {
    assert.deepEqual(Object.keys(entry).sort(), ["group", "originalRank", "skipped"]);
    assert.deepEqual(Object.keys(entry.group).sort(), ["id", "name"]);
  }
  assert.equal(JSON.stringify(view?.results).includes("OTHER-A"), false);
  assert.equal(JSON.stringify(view?.results).includes("SKIP-A"), false);
});

test("ended non-winning student can still see own answers but not another non-winning group's answers", () => {
  const activity = createActivityState(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-2", 7, { 1: "WINNER-ANSWER-1", 2: "WINNER-ANSWER-2" });
  submitAnswers(activity, "group-1", 7, { 1: "OWN-LOSER-ANSWER-1", 2: "OWN-LOSER-ANSWER-2" });
  submitAnswers(activity, "group-3", 7, { 1: "OTHER-LOSER-ANSWER-1", 2: "OTHER-LOSER-ANSWER-2" });
  transitionActivityStage(activity, "ended");

  const view = createStudentView(activity, "group-1");
  assert.deepEqual(view?.questions[0]?.subquestions, [
    { number: 1, submitted: true, answer: "OWN-LOSER-ANSWER-1" },
    { number: 2, submitted: true, answer: "OWN-LOSER-ANSWER-2" },
  ]);
  assert.deepEqual(view?.results?.[0]?.otherSubmissions, [
    { group: { id: "group-1", name: "第 1 組" }, originalRank: 2, skipped: false },
    { group: { id: "group-3", name: "第 3 組" }, originalRank: 3, skipped: false },
  ]);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("OWN-LOSER-ANSWER-1"), true);
  assert.equal(serialized.includes("OWN-LOSER-ANSWER-2"), true);
  assert.equal(serialized.includes("OTHER-LOSER-ANSWER-1"), false);
  assert.equal(serialized.includes("OTHER-LOSER-ANSWER-2"), false);
});

test("teacher view exposes central ranking fields and question explanation for rendering", () => {
  const activity = createActivityState(twoQuestionSet(), { activityCode: "2468", rankingRule: "cap" });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-1", 7, { 1: "A1", 2: "A2" });
  submitAnswers(activity, "group-1", 8, { 1: "B1", 2: "B2" });
  submitAnswers(activity, "group-2", 8, { 1: "C1", 2: "C2" });

  const view = createTeacherView(activity);
  assert.deepEqual(view.questions[1]?.groups.map(({ originalRank, finalRank, successful, skipped, explanation }) => [
    originalRank, finalRank, successful, skipped, explanation,
  ]), [
    [1, null, false, true, "第 1 組已達上限 1 題"],
    [2, 1, true, false, "遞補：第 1 組已達上限"],
    [null, null, false, false, ""],
    [null, null, false, false, ""],
  ]);
  assert.equal(view.questions[1]?.explanation, null);
});

test("screen view has a stage-specific allowlist and ended results expose only winner answers and other original ranks", () => {
  const activity = createActivityState(twoQuestionSet(), { activityCode: "2468", rankingRule: "cap" });
  const preparing = createScreenView(activity);
  assert.equal(preparing.stage, "preparing");
  assert.equal(preparing.groupCount, 4);
  assert.equal(preparing.activityCode, "2468");

  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-1", 7, { 1: "WINNER-A1", 2: "WINNER-A2" });
  submitAnswers(activity, "group-2", 7, { 1: "LOSER-SECRET-B1", 2: "LOSER-SECRET-B2" });
  const buzzing = createScreenView(activity);
  const buzzingPayload = JSON.stringify(buzzing);
  assert.deepEqual(buzzing.questions.map(({ submittedCount, totalGroups }) => [submittedCount, totalGroups]), [[2, 4], [0, 4]]);
  for (const forbidden of ["WINNER-A1", "LOSER-SECRET", "group-1", "第 1 組", "originalRank", "finalRank", "position", "finalPosition", '"rank"', "successful", "skipped", "sequence", "answers"]) {
    assert.equal(buzzingPayload.includes(forbidden), false, `搶答中不可包含 ${forbidden}`);
  }

  submitAnswers(activity, "group-3", 8, { 1: "SKIPPED-C1", 2: "SKIPPED-C2" });
  submitAnswers(activity, "group-1", 8, { 1: "WINNER-C1", 2: "WINNER-C2" });
  transitionActivityStage(activity, "ended");
  const ended = createScreenView(activity);
  assert.deepEqual(ended.questions[0]?.results, {
    successfulGroup: { id: "group-1", name: "第 1 組" },
    answers: [{ subquestionNumber: 1, answer: "WINNER-A1" }, { subquestionNumber: 2, answer: "WINNER-A2" }],
    others: [{ groupName: "第 2 組", originalRank: 2, skipped: false }],
    explanation: null,
  });
  assert.deepEqual(ended.questions[1]?.results?.others, [{ groupName: "第 1 組", originalRank: 2, skipped: true }]);
  assert.deepEqual(ended.questions[1]?.results?.successfulGroup, { id: "group-3", name: "第 3 組" });
  assert.deepEqual(ended.questions[1]?.results?.answers, [{ subquestionNumber: 1, answer: "SKIPPED-C1" }, { subquestionNumber: 2, answer: "SKIPPED-C2" }]);
  assert.equal(JSON.stringify(ended.questions[0]?.results).includes("LOSER-SECRET"), false);
  assert.equal(JSON.stringify(ended.questions[1]?.results).includes("group-1"), false);
});

test("buzzing teacher view has live ranks and outcomes in both pure-speed and cap modes", () => {
  for (const rankingRule of ["speed", "cap"] as const) {
    const activity = createActivityState(twoQuestionSet(), {
      activityCode: "2468", rankingRule, groupNames: ["第 1 組", "第 2 組"],
    });
    transitionActivityStage(activity, "buzzing");
    submitAnswers(activity, "group-1", 7, { 1: "A1", 2: "A2" });

    if (rankingRule === "speed") {
      submitAnswers(activity, "group-2", 7, { 1: "B1", 2: "B2" });
      const view = createTeacherView(activity);
      assert.equal(view.stage, "buzzing");
      assert.deepEqual(view.questions[0]?.groups.slice(0, 2).map(({ submitted, originalRank, finalRank, successful }) => [
        submitted, originalRank, finalRank, successful,
      ]), [[true, 1, 1, true], [true, 2, 2, false]]);
      assert.deepEqual(view.questions[0]?.groups[0]?.answers, [
        { subquestionNumber: 1, answer: "A1" }, { subquestionNumber: 2, answer: "A2" },
      ]);
    } else {
      submitAnswers(activity, "group-1", 8, { 1: "A3", 2: "A4" });
      submitAnswers(activity, "group-2", 8, { 1: "B3", 2: "B4" });
      const view = createTeacherView(activity);
      assert.equal(view.stage, "buzzing");
      assert.deepEqual(view.questions[1]?.groups.slice(0, 2).map(({ submitted, originalRank, finalRank, successful, skipped, explanation }) => [
        submitted, originalRank, finalRank, successful, skipped, explanation,
      ]), [
        [true, 1, null, false, true, "第 1 組已達上限 1 題"],
        [true, 2, 1, true, false, "遞補：第 1 組已達上限"],
      ]);
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
