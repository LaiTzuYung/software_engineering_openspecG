import { randomInt } from "node:crypto";
import type { GuidedNotesQuestionSet } from "../guided-notes/import-service.ts";

export type ActivityStage = "preparing" | "buzzing" | "ended";

export interface ActivityGroup {
  readonly id: string;
  readonly name: string;
}

export interface AcceptedSubmission {
  readonly groupId: string;
  readonly questionNumber: number;
  readonly sequence: number;
  readonly submittedAt: string;
  readonly answers: Readonly<Record<number, string>>;
}

/** Mutable, process-local activity state. Never serialize this directly to a student. */
export interface ActivityState {
  readonly activityCode: string;
  readonly questionSetId: string;
  readonly questionSet: GuidedNotesQuestionSet;
  readonly groups: readonly ActivityGroup[];
  stage: ActivityStage;
  showQuestionDescriptions: boolean;
  nextSubmissionSequence: number;
  readonly submissions: Map<number, Map<string, AcceptedSubmission>>;
}

export interface CreateActivityOptions {
  readonly activityCode?: string;
  readonly groupNames?: readonly string[];
}

export const DEFAULT_GROUP_NAMES = ["第 1 組", "第 2 組", "第 3 組", "第 4 組"] as const;

export function generateActivityCode(): string {
  return String(randomInt(1000, 10_000));
}

export function createActivityState(
  questionSet: GuidedNotesQuestionSet,
  options: CreateActivityOptions = {},
): ActivityState {
  const groupNames = options.groupNames ?? DEFAULT_GROUP_NAMES;
  if (groupNames.length < 2 || groupNames.length > 10) throw new Error("活動組數須為 2～10 組。");
  if (groupNames.some((name) => name.trim().length === 0)) throw new Error("組名不可空白。");

  return {
    activityCode: options.activityCode ?? generateActivityCode(),
    questionSetId: questionSet.id,
    questionSet: structuredClone(questionSet),
    groups: groupNames.map((name, index) => ({ id: `group-${index + 1}`, name })),
    stage: "preparing",
    showQuestionDescriptions: false,
    nextSubmissionSequence: 1,
    submissions: new Map(),
  };
}

export type StageTransitionResult =
  | { readonly ok: true; readonly stage: ActivityStage }
  | { readonly ok: false; readonly reason: "invalid-transition" };

/** Applies only the allowed forward transitions and leaves state untouched on rejection. */
export function transitionActivityStage(
  activity: ActivityState,
  nextStage: ActivityStage,
): StageTransitionResult {
  const allowed =
    (activity.stage === "preparing" && nextStage === "buzzing") ||
    (activity.stage === "buzzing" && nextStage === "ended");
  if (!allowed) return { ok: false, reason: "invalid-transition" };

  activity.stage = nextStage;
  return { ok: true, stage: activity.stage };
}

/** Holds the single current activity in memory; a new manager starts empty after restart. */
export class ActivityManager {
  private current: ActivityState | undefined;

  getActive(): ActivityState | undefined {
    return this.current;
  }

  create(questionSet: GuidedNotesQuestionSet, options: CreateActivityOptions = {}): ActivityState {
    const activity = createActivityState(questionSet, options);
    this.current = activity;
    return activity;
  }

  transition(nextStage: ActivityStage): StageTransitionResult {
    if (this.current === undefined) return { ok: false, reason: "invalid-transition" };
    return transitionActivityStage(this.current, nextStage);
  }
}
