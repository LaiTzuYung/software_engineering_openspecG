import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GuidedNotesQuestionSet } from "../guided-notes/import-service.ts";
import { isGuidedNotesQuestionSet } from "./question-sets.ts";
import type { AcceptedSubmission, ActivityStage, ActivityState, RankingRule } from "./model.ts";
import { createActivityState } from "./model.ts";

export interface StudentSessionIdentity {
  readonly activityCode: string;
  readonly groupId: string;
}

export interface PersistedActivity {
  readonly activityCode: string;
  readonly questionSetId: string;
  readonly questionSet: GuidedNotesQuestionSet;
  readonly groups: ActivityState["groups"];
  readonly stage: ActivityStage;
  readonly rankingRule: RankingRule;
  readonly showQuestionDescriptions: boolean;
  readonly nextSubmissionSequence: number;
  readonly submissions: readonly AcceptedSubmission[];
}

export interface ActivitySnapshot {
  readonly version: 1;
  readonly activity: PersistedActivity;
  readonly studentSessions: Readonly<Record<string, StudentSessionIdentity>>;
}

export interface RestoredActivitySnapshot {
  readonly activity: ActivityState;
  readonly studentSessions: Map<string, StudentSessionIdentity>;
}

export class InvalidActivitySnapshotError extends Error {
  constructor() {
    super("活動快照格式無效。");
    this.name = "InvalidActivitySnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isActivityStage(value: unknown): value is ActivityStage {
  return value === "preparing" || value === "buzzing" || value === "ended";
}

function isRankingRule(value: unknown): value is RankingRule {
  return value === "speed" || value === "cap";
}

function validateSnapshot(value: unknown): asserts value is ActivitySnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.activity) || !isRecord(value.studentSessions)) {
    throw new InvalidActivitySnapshotError();
  }
  const activity = value.activity;
  if (typeof activity.activityCode !== "string" || !/^\d{4}$/u.test(activity.activityCode) ||
      typeof activity.questionSetId !== "string" || !isGuidedNotesQuestionSet(activity.questionSet) ||
      activity.questionSetId !== activity.questionSet.id || !Array.isArray(activity.groups) ||
      activity.groups.length < 2 || activity.groups.length > 10 || !isActivityStage(activity.stage) ||
      !isRankingRule(activity.rankingRule) || typeof activity.showQuestionDescriptions !== "boolean" ||
      !Number.isSafeInteger(activity.nextSubmissionSequence) || Number(activity.nextSubmissionSequence) < 1 ||
      !Array.isArray(activity.submissions)) {
    throw new InvalidActivitySnapshotError();
  }

  const groupIds = new Set<string>();
  for (const group of activity.groups) {
    if (!isRecord(group) || typeof group.id !== "string" || group.id.length === 0 ||
        typeof group.name !== "string" || group.name.trim().length === 0 || groupIds.has(group.id)) {
      throw new InvalidActivitySnapshotError();
    }
    groupIds.add(group.id);
  }

  const questionNumbers = new Set(activity.questionSet.questions.map(({ number }) => number));
  const subquestionNumbers = new Map(activity.questionSet.questions.map((question) => [
    question.number, new Set(question.subquestions.map(({ number }) => number)),
  ]));
  const submissionKeys = new Set<string>();
  const sequences = new Set<number>();
  let maximumSequence = 0;
  for (const submission of activity.submissions) {
    if (!isRecord(submission) || typeof submission.groupId !== "string" || !groupIds.has(submission.groupId) ||
        !Number.isSafeInteger(submission.questionNumber) || !questionNumbers.has(Number(submission.questionNumber)) ||
        !Number.isSafeInteger(submission.sequence) || Number(submission.sequence) < 1 ||
        !isIsoDate(submission.submittedAt) || !isRecord(submission.answers)) {
      throw new InvalidActivitySnapshotError();
    }
    const questionNumber = Number(submission.questionNumber);
    const expectedAnswers = subquestionNumbers.get(questionNumber)!;
    const answerNumbers = Object.keys(submission.answers).map(Number);
    if (answerNumbers.length !== expectedAnswers.size ||
        answerNumbers.some((number) => !expectedAnswers.has(number)) ||
        Object.values(submission.answers).some((answer) => typeof answer !== "string")) {
      throw new InvalidActivitySnapshotError();
    }
    const key = `${questionNumber}\u0000${submission.groupId}`;
    const sequence = Number(submission.sequence);
    if (submissionKeys.has(key) || sequences.has(sequence)) throw new InvalidActivitySnapshotError();
    submissionKeys.add(key);
    sequences.add(sequence);
    maximumSequence = Math.max(maximumSequence, sequence);
  }
  if (Number(activity.nextSubmissionSequence) <= maximumSequence) throw new InvalidActivitySnapshotError();

  for (const [token, identity] of Object.entries(value.studentSessions)) {
    if (token.length === 0 || !isRecord(identity) || identity.activityCode !== activity.activityCode ||
        typeof identity.groupId !== "string" || !groupIds.has(identity.groupId)) {
      throw new InvalidActivitySnapshotError();
    }
  }
}

/** Captures an immutable, JSON-safe representation of the current activity and sessions. */
export function createActivitySnapshot(
  activity: ActivityState,
  studentSessions: ReadonlyMap<string, StudentSessionIdentity> = new Map(),
): ActivitySnapshot {
  const submissions = [...activity.submissions.values()].flatMap((byGroup) => [...byGroup.values()])
    .sort((left, right) => left.sequence - right.sequence)
    .map((submission) => ({ ...submission, answers: { ...submission.answers } }));
  const snapshot: ActivitySnapshot = {
    version: 1,
    activity: {
      activityCode: activity.activityCode,
      questionSetId: activity.questionSetId,
      questionSet: structuredClone(activity.questionSet),
      groups: structuredClone(activity.groups),
      stage: activity.stage,
      rankingRule: activity.rankingRule,
      showQuestionDescriptions: activity.showQuestionDescriptions,
      nextSubmissionSequence: activity.nextSubmissionSequence,
      submissions,
    },
    studentSessions: Object.fromEntries([...studentSessions].map(([token, identity]) => [token, { ...identity }])),
  };
  validateSnapshot(snapshot);
  return snapshot;
}

/** Validates the whole file before restoring any of its state. */
export function restoreActivitySnapshot(value: unknown): RestoredActivitySnapshot {
  validateSnapshot(value);
  const { activity: saved, studentSessions } = value;
  const activity = createActivityState(saved.questionSet, {
    activityCode: saved.activityCode,
    groupNames: saved.groups.map(({ name }) => name),
    rankingRule: saved.rankingRule,
  });
  // Keep persisted identifiers, which are part of each student's session identity.
  Object.assign(activity.groups as { id: string; name: string }[], structuredClone(saved.groups));
  activity.stage = saved.stage;
  activity.showQuestionDescriptions = saved.showQuestionDescriptions;
  activity.nextSubmissionSequence = saved.nextSubmissionSequence;
  for (const submission of saved.submissions) {
    const byGroup = activity.submissions.get(submission.questionNumber) ?? new Map<string, AcceptedSubmission>();
    byGroup.set(submission.groupId, structuredClone(submission));
    activity.submissions.set(submission.questionNumber, byGroup);
  }
  return { activity, studentSessions: new Map(Object.entries(studentSessions).map(([token, identity]) => [token, { ...identity }])) };
}

/** Stores a single current-activity snapshot using ordered atomic replacement. */
export class ActivitySnapshotStore {
  readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly logError: (message: string) => void;

  constructor(
    dataDirectory = path.join(process.cwd(), "data"),
    logError: (message: string) => void = (message) => console.error(message),
  ) {
    this.filePath = path.join(dataDirectory, "live-buzzer-activity.json");
    this.logError = logError;
  }

  async load(): Promise<RestoredActivitySnapshot | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      this.logError(`無法讀取活動快照 ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    try {
      return restoreActivitySnapshot(JSON.parse(contents) as unknown);
    } catch (error) {
      this.logError(`活動快照無效，忽略並保留原檔 ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  save(snapshot: ActivitySnapshot): Promise<void> {
    validateSnapshot(snapshot);
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
    const operation = this.writeQueue.then(() => this.writeAtomically(contents));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async writeAtomically(contents: string): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

