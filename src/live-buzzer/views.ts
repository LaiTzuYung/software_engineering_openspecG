import type { ActivityState, ActivityStage } from "./model.ts";
import { getQuestionRanks, getQuestionResults } from "./submissions.ts";

export interface StudentSubquestionView {
  readonly number: number;
  readonly submitted: boolean;
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
}

export interface StudentView {
  readonly activityCode: string;
  readonly stage: ActivityStage;
  readonly group: { readonly id: string; readonly name: string };
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
  readonly questionDescriptionsVisible: boolean;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
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
      readonly answers: readonly StudentAnswerView[] | null;
    }[];
  }[];
}

/**
 * Builds the only activity view intended for students. Every field is copied
 * from an explicit allowlist; never spread or serialize internal activity state.
 */
export function createStudentView(activity: ActivityState, groupId: string): StudentView | undefined {
  const group = activity.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return undefined;

  const questions: StudentQuestionView[] = activity.questionSet.questions.map((question) => {
    const subquestions: StudentSubquestionView[] = question.subquestions.map((subquestion) => ({
      number: subquestion.number,
      submitted: activity.submissions.get(question.number)?.has(groupId) ?? false,
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
export function createTeacherView(activity: ActivityState): TeacherView {
  const groups = activity.groups.map((group) => ({ id: group.id, name: group.name }));
  const questions = activity.questionSet.questions.map((question) => {
    const ranks = getQuestionRanks(activity, question.number);
    return {
      number: question.number,
      description: question.description,
      subquestions: question.subquestions.map(({ number }) => ({ number })),
      groups: activity.groups.map((group) => {
      const submission = activity.submissions.get(question.number)?.get(group.id);
      const rank = ranks.get(group.id) ?? null;
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
        answers,
      };
      }),
    };
  });

  return {
    activityCode: activity.activityCode,
    stage: activity.stage,
    canWriteSpreadsheet: activity.questionSet.googleSource !== undefined,
    questionDescriptionsVisible: activity.showQuestionDescriptions,
    groups,
    questions,
  };
}

function createStudentResults(activity: ActivityState): readonly StudentResultView[] {
  const results = getQuestionResults(activity);
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
    return { questionNumber: result.questionNumber, successfulGroup, answers };
  });
}
