import type { ActivityState, AcceptedSubmission } from "./model.ts";

export type SubmissionRejectionReason =
  | "activity-not-buzzing"
  | "unknown-group"
  | "unknown-question"
  | "already-submitted"
  | "incomplete-answer-set"
  | "blank-answer"
  | "answer-too-long";

export type SubmissionResult =
  | { readonly accepted: true; readonly submission: AcceptedSubmission }
  | { readonly accepted: false; readonly reason: SubmissionRejectionReason };

export interface QuestionResult {
  readonly questionNumber: number;
  readonly successfulGroup: { readonly id: string; readonly name: string } | null;
  readonly answers: Readonly<Record<number, string>> | null;
  readonly sequence: number | null;
}

/** Returns each submitted group's question-local rank, ordered by server sequence. */
export function getQuestionRanks(
  activity: ActivityState,
  questionNumber: number,
): ReadonlyMap<string, number> {
  const submissions = activity.submissions.get(questionNumber);
  if (submissions === undefined) return new Map();

  const ordered = [...submissions.values()].sort((left, right) => left.sequence - right.sequence);
  return new Map(ordered.map((submission, index) => [submission.groupId, index + 1]));
}

const MAX_ANSWER_CODE_POINTS = 200;

function removeWhitespace(answer: string): string {
  return answer.replace(/\s/gu, "");
}

/**
 * Synchronously validates and records one group's complete answer for a question.
 * Keep validation, duplicate checking, sequence allocation and writes in this
 * function with no await or callbacks so one event-loop turn is atomic.
 */
export function submitAnswers(
  activity: ActivityState,
  groupId: string,
  questionNumber: number,
  answers: Readonly<Record<number, string>>,
): SubmissionResult {
  if (activity.stage !== "buzzing") return { accepted: false, reason: "activity-not-buzzing" };
  if (!activity.groups.some((group) => group.id === groupId)) {
    return { accepted: false, reason: "unknown-group" };
  }

  const question = activity.questionSet.questions.find(({ number }) => number === questionNumber);
  if (question === undefined) return { accepted: false, reason: "unknown-question" };

  const existingSubmissions = activity.submissions.get(questionNumber);
  if (existingSubmissions?.has(groupId)) return { accepted: false, reason: "already-submitted" };

  const expectedNumbers = question.subquestions.map(({ number }) => number);
  const answerNumbers = Object.keys(answers).map(Number);
  if (answerNumbers.length !== expectedNumbers.length ||
      expectedNumbers.some((number) => !Object.hasOwn(answers, number)) ||
      answerNumbers.some((number) => !expectedNumbers.includes(number))) {
    return { accepted: false, reason: "incomplete-answer-set" };
  }

  const normalizedAnswers: Record<number, string> = {};
  for (const subquestionNumber of expectedNumbers) {
    const answer = answers[subquestionNumber];
    if (typeof answer !== "string") return { accepted: false, reason: "incomplete-answer-set" };
    const normalized = removeWhitespace(answer);
    if (normalized.length === 0) return { accepted: false, reason: "blank-answer" };
    if ([...normalized].length > MAX_ANSWER_CODE_POINTS) {
      return { accepted: false, reason: "answer-too-long" };
    }
    normalizedAnswers[subquestionNumber] = answer;
  }

  const submission: AcceptedSubmission = {
    groupId,
    questionNumber,
    sequence: activity.nextSubmissionSequence,
    submittedAt: new Date().toISOString(),
    answers: normalizedAnswers,
  };

  // Commit is the only mutation point, after the complete input has passed validation.
  const submissionsForQuestion = existingSubmissions ?? new Map<string, AcceptedSubmission>();
  submissionsForQuestion.set(groupId, submission);
  activity.submissions.set(questionNumber, submissionsForQuestion);
  activity.nextSubmissionSequence += 1;
  return { accepted: true, submission };
}

/** Returns the first accepted group for each question, with no client timestamps. */
export function getQuestionResults(activity: ActivityState): readonly QuestionResult[] {
  return activity.questionSet.questions.map((question) => {
    const accepted = activity.submissions.get(question.number);
    let first: AcceptedSubmission | undefined;
    if (accepted !== undefined) {
      for (const submission of accepted.values()) {
        if (first === undefined || submission.sequence < first.sequence) first = submission;
      }
    }

    if (first === undefined) {
      return { questionNumber: question.number, successfulGroup: null, answers: null, sequence: null };
    }
    const group = activity.groups.find(({ id }) => id === first!.groupId)!;
    return {
      questionNumber: question.number,
      successfulGroup: { id: group.id, name: group.name },
      answers: { ...first.answers },
      sequence: first.sequence,
    };
  });
}
