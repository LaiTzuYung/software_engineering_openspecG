import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { GuidedNotesQuestionSet, PreviewQuestion } from "../guided-notes/import-service.ts";

export class InvalidQuestionSetError extends Error {
  constructor(fileName: string) {
    super(`題目集檔案格式無效：${fileName}`);
    this.name = "InvalidQuestionSetError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuestion(value: unknown): value is PreviewQuestion {
  if (!isRecord(value) || !Number.isInteger(value.number) || typeof value.description !== "string") return false;
  if (value.type !== "single" && value.type !== "group") return false;
  if (!Array.isArray(value.subquestions) || value.subquestions.length === 0) return false;
  return value.subquestions.every((subquestion) =>
    isRecord(subquestion) && Number.isInteger(subquestion.number) &&
    isRecord(subquestion.answerCell) && typeof subquestion.answerCell.address === "string" &&
    typeof subquestion.answerCell.sheetName === "string",
  );
}

export function isGuidedNotesQuestionSet(value: unknown): value is GuidedNotesQuestionSet {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 &&
    typeof value.createdAt === "string" && typeof value.sheetName === "string" &&
    (value.importSource === undefined || value.importSource === "google" || value.importSource === "xlsx") &&
    Number.isInteger(value.totalQuestionCount) && Array.isArray(value.questions) &&
    value.questions.length === value.totalQuestionCount && value.questions.every(isQuestion) &&
    Number.isInteger(value.singleQuestionCount) && Number.isInteger(value.groupQuestionCount) &&
    Array.isArray(value.warnings);
}

/** Reads validated question-set JSON; malformed JSON or records fail with a clear error. */
export class QuestionSetRepository {
  private readonly dataDirectory: string;

  constructor(dataDirectory = path.join(process.cwd(), "data", "guided-notes")) {
    this.dataDirectory = dataDirectory;
  }

  async list(): Promise<readonly GuidedNotesQuestionSet[]> {
    let entries;
    try {
      entries = await readdir(this.dataDirectory, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const questionSets: GuidedNotesQuestionSet[] = [];
    for (const fileName of files) questionSets.push(await this.readFile(fileName));
    return questionSets;
  }

  async get(id: string): Promise<GuidedNotesQuestionSet | undefined> {
    if (id.length === 0 || path.basename(id) !== id || id.includes("..")) return undefined;
    try {
      return await this.readFile(`${id}.json`);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readFile(fileName: string): Promise<GuidedNotesQuestionSet> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(this.dataDirectory, fileName), "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new InvalidQuestionSetError(fileName);
      throw error;
    }
    if (!isGuidedNotesQuestionSet(value)) throw new InvalidQuestionSetError(fileName);
    return value;
  }
}
