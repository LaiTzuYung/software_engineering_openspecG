import type { ActivityState, ActivityStage, RankingRule } from "./model.ts";
import { calculateRankingResults, getRankingCap } from "./submissions.ts";

export interface RankingRuleView {
  readonly name: "純速度" | "均分上限";
  readonly explanation: string;
}

export interface StudentSubquestionView {
  readonly number: number;
  readonly submitted: boolean;
  readonly answer?: string;
}

export interface StudentQuestionView {
  readonly number: number;
  readonly description?: string;
  readonly subquestions: readonly StudentSubquestionView[];
}

export interface StudentAnswerView {
  readonly subquestionNumber: number;
  readonly answer: string;
}

export interface StudentResultView {
  readonly questionNumber: number;
  readonly successfulGroup: { readonly id: string; readonly name: string } | null;
  readonly answers: readonly StudentAnswerView[] | null;
  readonly explanation: string | null;
  readonly otherSubmissions: readonly {
    readonly group: { readonly id: string; readonly name: string };
    readonly originalRank: number;
    readonly skipped: boolean;
  }[];
}

export interface ScreenQuestionView {
  readonly number: number;
  readonly submittedCount: number;
  readonly totalGroups: number;
  readonly results?: {
    readonly successfulGroup: { readonly id: string; readonly name: string } | null;
    readonly answers: readonly StudentAnswerView[] | null;
    readonly others: readonly { readonly groupName: string; readonly originalRank: number; readonly skipped: boolean }[];
    readonly explanation: string | null;
  };
}

export interface ScreenView {
  readonly activityCode: string;
  readonly stage: ActivityStage;
  readonly groupCount: number;
  readonly rankingRule: RankingRuleView;
  readonly questions: readonly ScreenQuestionView[];
}

export interface StudentView {
  readonly activityCode: string;
  readonly stage: ActivityStage;
  readonly group: { readonly id: string; readonly name: string };
  readonly rankingRule: RankingRuleView;
  readonly questionDescriptionsVisible: boolean;
  readonly questions: readonly StudentQuestionView[];
  readonly results: readonly StudentResultView[] | null;
}

export type StudentStatusPayload = StudentView | { readonly error: "invalid-student-session" };
export type StudentStatusResponse =
  | { readonly statusCode: 200; readonly payload: StudentView }
  | { readonly statusCode: 401; readonly payload: { readonly error: "invalid-student-session" } };

export interface TeacherView {
  readonly activityCode: string;
  readonly stage: ActivityStage;
  readonly canWriteSpreadsheet: boolean;
  readonly questionSetSource: "google" | "xlsx" | "legacy";
  readonly rankingRule: RankingRuleView;
  readonly questionDescriptionsVisible: boolean;
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly onlineStudentPages: number;
  }[];
  readonly questions: readonly {
    readonly number: number;
    readonly description: string;
    readonly subquestions: readonly { readonly number: number }[];
    readonly groups: readonly {
      readonly groupId: string;
      readonly groupName: string;
      readonly submitted: boolean;
      readonly sequence: number | null;
      readonly rank: number | null;
      readonly originalRank: number | null;
      readonly finalRank: number | null;
      readonly successful: boolean;
      readonly skipped: boolean;
      readonly explanation: string;
      readonly answers: readonly StudentAnswerView[] | null;
    }[];
    readonly explanation: string | null;
  }[];
}

/** Builds a stage-specific projection view from an explicit, minimal allowlist. */
export function createScreenView(activity: ActivityState): ScreenView {
  const ranking = activity.stage === "ended" ? calculateRankingResults(activity) : null;
  const questions: ScreenQuestionView[] = activity.questionSet.questions.map((question) => {
    const submissions = activity.submissions.get(question.number);
    const base: ScreenQuestionView = {
      number: question.number,
      submittedCount: submissions?.size ?? 0,
      totalGroups: activity.groups.length,
    };
    if (ranking === null) return base;
    const result = ranking.questions.find(({ questionNumber }) => questionNumber === question.number);
    const winner = result?.successfulGroup ?? null;
    const answers = result?.answers === null || result?.answers === undefined
      ? null
      : question.subquestions.map(({ number }) => ({ subquestionNumber: number, answer: result.answers![number] ?? "" }));
    const others = ranking.submissions.filter(({ submission }) => submission.questionNumber === question.number)
      .filter(({ successful }) => !successful)
      .map(({ submission, originalRank, skipped }) => ({
        groupName: activity.groups.find(({ id }) => id === submission.groupId)?.name ?? submission.groupId,
        originalRank,
        skipped,
      }));
    return {
      ...base,
      results: {
        successfulGroup: winner,
        answers,
        others,
        explanation: result?.explanation ?? (submissions === undefined || submissions.size === 0 ? "沒有組別送出" : null),
      },
    };
  });
  return {
    activityCode: activity.activityCode,
    stage: activity.stage,
    groupCount: activity.groups.length,
    rankingRule: createRankingRuleView(activity.rankingRule, activity.questionSet.questions.length, activity.groups.length),
    questions,
  };
}

/**
 * Builds the only activity view intended for students. Every field is copied
 * from an explicit allowlist; never spread or serialize internal activity state.
 */
export function createStudentView(activity: ActivityState, groupId: string): StudentView | undefined {
  const group = activity.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return undefined;

  const questions: StudentQuestionView[] = activity.questionSet.questions.map((question) => {
    const submission = activity.submissions.get(question.number)?.get(groupId);
    const subquestions: StudentSubquestionView[] = question.subquestions.map((subquestion) => ({
      number: subquestion.number,
      submitted: submission !== undefined,
      ...(submission === undefined ? {} : { answer: submission.answers[subquestion.number] ?? "" }),
    }));
    if (activity.showQuestionDescriptions) {
      return { number: question.number, description: question.description, subquestions };
    }
    return { number: question.number, subquestions };
  });

  const view: StudentView = {
    activityCode: activity.activityCode,
    stage: activity.stage,
    group: { id: group.id, name: group.name },
    rankingRule: createRankingRuleView(activity.rankingRule, activity.questionSet.questions.length, activity.groups.length),
    questionDescriptionsVisible: activity.showQuestionDescriptions,
    questions,
    results: activity.stage === "ended" ? createStudentResults(activity) : null,
  };
  return view;
}

/** HTTP status adapters use this payload builder instead of serializing activity state. */
export function createStudentStatusPayload(activity: ActivityState, groupId: string): StudentStatusPayload {
  const view = createStudentView(activity, groupId);
  if (view === undefined) return { error: "invalid-student-session" };
  return view;
}

/** HTTP status routes serialize this response payload rather than internal state. */
export function createStudentStatusResponse(activity: ActivityState, groupId: string): StudentStatusResponse {
  const payload = createStudentStatusPayload(activity, groupId);
  if ("error" in payload) return { statusCode: 401, payload };
  return { statusCode: 200, payload };
}

/** Builds the teacher view, including all group answers and server order. */
export function createTeacherView(
  activity: ActivityState,
  onlineStudentPages: ReadonlyMap<string, number> = new Map(),
): TeacherView {
  const groups = activity.groups.map((group) => ({
    id: group.id,
    name: group.name,
    onlineStudentPages: onlineStudentPages.get(group.id) ?? 0,
  }));
  const rankingResults = calculateRankingResults(activity);
  const rankedSubmissions = new Map(rankingResults.submissions.map((result) => [result.submission.sequence, result]));
  const rankingQuestions = new Map(rankingResults.questions.map((result) => [result.questionNumber, result]));
  const questions = activity.questionSet.questions.map((question) => {
    const rankingQuestion = rankingQuestions.get(question.number);
    return {
      number: question.number,
      description: question.description,
      subquestions: question.subquestions.map(({ number }) => ({ number })),
      explanation: rankingQuestion?.explanation ?? null,
      groups: activity.groups.map((group) => {
      const submission = activity.submissions.get(question.number)?.get(group.id);
      const rankingResult = submission === undefined ? undefined : rankedSubmissions.get(submission.sequence);
      const rank = rankingResult?.originalRank ?? null;
      let answers: readonly StudentAnswerView[] | null = null;
      if (submission !== undefined) {
        answers = question.subquestions.map((subquestion) => ({
          subquestionNumber: subquestion.number,
          answer: submission.answers[subquestion.number] ?? "",
        }));
      }
      return {
        groupId: group.id,
        groupName: group.name,
        submitted: submission !== undefined,
        sequence: submission === undefined ? null : submission.sequence,
        rank,
        originalRank: rank,
        finalRank: rankingResult?.finalRank ?? null,
        successful: rankingResult?.successful ?? false,
        skipped: rankingResult?.skipped ?? false,
        explanation: rankingResult?.explanation ?? "",
        answers,
      };
      }),
    };
  });

  return {
    activityCode: activity.activityCode,
    stage: activity.stage,
    canWriteSpreadsheet: activity.questionSet.googleSource !== undefined,
    questionSetSource: activity.questionSet.googleSource !== undefined ? "google" : activity.questionSet.importSource ?? "legacy",
    rankingRule: createRankingRuleView(activity.rankingRule, activity.questionSet.questions.length, activity.groups.length),
    questionDescriptionsVisible: activity.showQuestionDescriptions,
    groups,
    questions,
  };
}

function createRankingRuleView(rule: RankingRule, questionCount: number, groupCount: number): RankingRuleView {
  if (rule === "speed") return { name: "純速度", explanation: "" };
  return { name: "均分上限", explanation: `每組最多成功 ${getRankingCap(questionCount, groupCount)} 題` };
}

function createStudentResults(activity: ActivityState): readonly StudentResultView[] {
  const results = calculateRankingResults(activity).questions;
  return results.map((result) => {
    let successfulGroup: StudentResultView["successfulGroup"] = null;
    if (result.successfulGroup !== null) {
      successfulGroup = { id: result.successfulGroup.id, name: result.successfulGroup.name };
    }

    let answers: readonly StudentAnswerView[] | null = null;
    if (result.answers !== null) {
      const question = activity.questionSet.questions.find(({ number }) => number === result.questionNumber);
      if (question !== undefined) {
        answers = question.subquestions.map((subquestion) => ({
          subquestionNumber: subquestion.number,
          answer: result.answers?.[subquestion.number] ?? "",
        }));
      }
    }
    const otherSubmissions = calculateRankingResults(activity).submissions
      .filter(({ submission, successful }) => submission.questionNumber === result.questionNumber && !successful)
      .map(({ submission, originalRank, skipped }) => ({
        group: {
          id: submission.groupId,
          name: activity.groups.find(({ id }) => id === submission.groupId)?.name ?? submission.groupId,
        },
        originalRank,
        skipped,
      }));
    return { questionNumber: result.questionNumber, successfulGroup, answers, explanation: result.explanation, otherSubmissions };
  });
}
