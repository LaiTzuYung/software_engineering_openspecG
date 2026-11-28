import type { ActivityState, AcceptedSubmission, RankingRule } from "./model.ts";

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

export interface RankedSubmissionResult {
  readonly submission: AcceptedSubmission;
  readonly originalRank: number;
  readonly finalRank: number | null;
  readonly successful: boolean;
  readonly skipped: boolean;
  readonly explanation: string;
}

export interface RankingQuestionResult extends QuestionResult {
  readonly explanation: string | null;
}

export interface RankingResults {
  readonly rule: RankingRule;
  readonly cap: number | null;
  readonly submissions: readonly RankedSubmissionResult[];
  readonly questions: readonly RankingQuestionResult[];
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

/** Preserves the original pure-speed outcome for the unified calculator's speed branch. */
function getPureSpeedQuestionResults(activity: ActivityState): readonly QuestionResult[] {
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

/** Returns existing result fields, with the activity's selected rule applied by the shared calculator. */
export function getQuestionResults(activity: ActivityState): readonly QuestionResult[] {
  return calculateRankingResults(activity).questions.map(({ explanation: _explanation, ...result }) => result);
}

/** Returns the cap derived from all questions in the activity, whether submitted or not. */
export function getRankingCap(questionCount: number, groupCount: number): number {
  return Math.ceil(questionCount / groupCount);
}

/** Recomputes all question outcomes in server-sequence order without mutating the activity. */
export function calculateRankingResults(
  activity: ActivityState,
  rule: RankingRule = activity.rankingRule,
): RankingResults {
  const ranksByQuestion = new Map<number, ReadonlyMap<string, number>>();
  const acceptedSubmissions: AcceptedSubmission[] = [];
  for (const question of activity.questionSet.questions) {
    ranksByQuestion.set(question.number, getQuestionRanks(activity, question.number));
    acceptedSubmissions.push(...(activity.submissions.get(question.number)?.values() ?? []));
  }
  acceptedSubmissions.sort((left, right) => left.sequence - right.sequence);

  if (rule === "speed") {
    const currentResults = getPureSpeedQuestionResults(activity);
    const successfulGroupByQuestion = new Map(
      currentResults.map(({ questionNumber, successfulGroup }) => [questionNumber, successfulGroup?.id]),
    );
    const submissions = acceptedSubmissions.map((submission): RankedSubmissionResult => {
      const originalRank = ranksByQuestion.get(submission.questionNumber)?.get(submission.groupId);
      if (originalRank === undefined) throw new Error("已接受提交缺少原始順位。");
      return {
        submission,
        originalRank,
        finalRank: originalRank,
        successful: successfulGroupByQuestion.get(submission.questionNumber) === submission.groupId,
        skipped: false,
        explanation: "",
      };
    });
    return {
      rule,
      cap: null,
      submissions,
      questions: currentResults.map((result) => ({ ...result, explanation: null })),
    };
  }

  const cap = getRankingCap(activity.questionSet.questions.length, activity.groups.length);
  const successfulCountByGroup = new Map<string, number>();
  const winnerByQuestion = new Map<number, AcceptedSubmission>();
  const skippedGroupsByQuestion = new Map<number, string[]>();
  const finalRankByQuestion = new Map<number, number>();
  const groupNameById = new Map(activity.groups.map(({ id, name }) => [id, name]));
  const rankedBySequence = new Map<number, RankedSubmissionResult>();

  for (const submission of acceptedSubmissions) {
    const originalRank = ranksByQuestion.get(submission.questionNumber)?.get(submission.groupId);
    if (originalRank === undefined) throw new Error("已接受提交缺少原始順位。");
    const groupName = groupNameById.get(submission.groupId) ?? submission.groupId;
    const successfulCount = successfulCountByGroup.get(submission.groupId) ?? 0;
    if (successfulCount >= cap) {
      rankedBySequence.set(submission.sequence, {
        submission,
        originalRank,
        finalRank: null,
        successful: false,
        skipped: true,
        explanation: `${groupName}已達上限 ${cap} 題`,
      });
      const skipped = skippedGroupsByQuestion.get(submission.questionNumber) ?? [];
      skipped.push(groupName);
      skippedGroupsByQuestion.set(submission.questionNumber, skipped);
      continue;
    }

    const finalRank = (finalRankByQuestion.get(submission.questionNumber) ?? 0) + 1;
    finalRankByQuestion.set(submission.questionNumber, finalRank);
    const previousSkippedGroups = skippedGroupsByQuestion.get(submission.questionNumber) ?? [];
    const successful = !winnerByQuestion.has(submission.questionNumber);
    if (successful) {
      winnerByQuestion.set(submission.questionNumber, submission);
      successfulCountByGroup.set(submission.groupId, successfulCount + 1);
    }
    rankedBySequence.set(submission.sequence, {
      submission,
      originalRank,
      finalRank,
      successful,
      skipped: false,
      explanation: successful && previousSkippedGroups.length > 0
        ? `遞補：${previousSkippedGroups.join("、")}已達上限`
        : "",
    });
  }

  const submissions = acceptedSubmissions.map((submission) => {
    const result = rankedBySequence.get(submission.sequence);
    if (result === undefined) throw new Error("已接受提交缺少排名結果。");
    return result;
  });
  const submittedGroupIdsByQuestion = new Map<number, Set<string>>();
  for (const submission of acceptedSubmissions) {
    const groupIds = submittedGroupIdsByQuestion.get(submission.questionNumber) ?? new Set<string>();
    groupIds.add(submission.groupId);
    submittedGroupIdsByQuestion.set(submission.questionNumber, groupIds);
  }
  const questions = activity.questionSet.questions.map((question): RankingQuestionResult => {
    const winner = winnerByQuestion.get(question.number);
    if (winner !== undefined) {
      const group = activity.groups.find(({ id }) => id === winner.groupId);
      if (group === undefined) throw new Error("成功提交所屬組別不存在。");
      return {
        questionNumber: question.number,
        successfulGroup: { id: group.id, name: group.name },
        answers: { ...winner.answers },
        sequence: winner.sequence,
        explanation: null,
      };
    }

    const submittedGroupIds = submittedGroupIdsByQuestion.get(question.number);
    if (submittedGroupIds === undefined || submittedGroupIds.size === 0) {
      return { questionNumber: question.number, successfulGroup: null, answers: null, sequence: null, explanation: null };
    }
    const submittedGroupNames = activity.groups
      .filter(({ id }) => submittedGroupIds.has(id))
      .map(({ name }) => name);
    const explanation = submittedGroupNames.length === 1
      ? `唯一送出的${submittedGroupNames[0]}已達上限 ${cap} 題`
      : `送出的${submittedGroupNames.join("、")}都已達上限 ${cap} 題`;
    return { questionNumber: question.number, successfulGroup: null, answers: null, sequence: null, explanation };
  });

  return { rule, cap, submissions, questions };
}
