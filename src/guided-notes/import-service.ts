import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { toA1 } from "./coordinates.ts";
import type { CellValue, LocatedCell, ParseResult, ParseWarning, ParsedQuestion } from "./model.ts";

export interface PreviewCell {
  readonly sheetName: string;
  readonly address: string;
  readonly row: number;
  readonly column: number;
}

export interface PreviewSubquestion {
  readonly number: number;
  readonly answerCell: PreviewCell;
  readonly labelCell?: PreviewCell;
}

export interface PreviewQuestion {
  readonly number: number;
  readonly numberCell?: PreviewCell;
  readonly numberCellValue?: CellValue;
  readonly description: string;
  readonly type: "single" | "group";
  readonly subquestions: readonly PreviewSubquestion[];
}

export interface PreviewWarning {
  readonly code: ParseWarning["code"];
  readonly message: string;
  readonly cell: PreviewCell;
}

export interface GoogleSpreadsheetSource {
  readonly spreadsheetId: string;
  readonly gid: number;
}

/** Source-neutral preview and persisted question-set representation. */
export interface GuidedNotesQuestionSet {
  readonly id: string;
  readonly createdAt: string;
  readonly sheetName: string;
  readonly googleSource?: GoogleSpreadsheetSource;
  readonly importSource?: "google" | "xlsx";
  readonly locatingMode?: "header" | "marker";
  readonly answerMarkerTemplates?: readonly {
    readonly questionNumber: number;
    readonly subquestionNumber: number;
    readonly answerCell: PreviewCell;
    readonly originalValue: string;
  }[];
  readonly totalQuestionCount: number;
  readonly singleQuestionCount: number;
  readonly groupQuestionCount: number;
  readonly questions: readonly PreviewQuestion[];
  readonly warnings: readonly PreviewWarning[];
}

function previewCell(cell: LocatedCell): PreviewCell {
  return {
    sheetName: cell.sheetName,
    address: toA1({ row: cell.row, column: cell.column }),
    row: cell.row,
    column: cell.column,
  };
}

function previewQuestion(question: ParsedQuestion): PreviewQuestion {
  return {
    number: question.number,
    numberCell: previewCell(question.numberCell),
    numberCellValue: question.numberCellValue,
    description: question.description,
    type: question.type,
    subquestions: question.subquestions.map((subquestion) => ({
      number: subquestion.number,
      answerCell: previewCell(subquestion.answerCell),
      ...(subquestion.labelCell === undefined ? {} : { labelCell: previewCell(subquestion.labelCell) }),
    })),
  };
}

export function createImportPreview(
  result: ParseResult,
  googleSource?: GoogleSpreadsheetSource,
  importSource: "google" | "xlsx" = googleSource === undefined ? "xlsx" : "google",
): GuidedNotesQuestionSet {
  const questions = result.questions.map(previewQuestion);
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    sheetName: result.sheetName,
    ...(googleSource === undefined ? {} : { googleSource }),
    importSource,
    locatingMode: result.mode,
    answerMarkerTemplates: result.answerMarkerTemplates.map((template) => ({
      questionNumber: template.questionNumber,
      subquestionNumber: template.subquestionNumber,
      answerCell: previewCell(template.answerCell),
      originalValue: template.originalValue,
    })),
    totalQuestionCount: questions.length,
    singleQuestionCount: questions.filter(({ type }) => type === "single").length,
    groupQuestionCount: questions.filter(({ type }) => type === "group").length,
    questions,
    warnings: result.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      cell: previewCell(warning.cell),
    })),
  };
}

/** Holds previews in memory and persists a question set only after explicit confirmation. */
export class GuidedNotesImportService {
  private readonly pending = new Map<string, GuidedNotesQuestionSet>();
  private readonly created = new Map<string, GuidedNotesQuestionSet>();
  private readonly dataDirectory: string;

  constructor(dataDirectory = path.join(process.cwd(), "data", "guided-notes")) {
    this.dataDirectory = dataDirectory;
  }

  preview(result: ParseResult, googleSource?: GoogleSpreadsheetSource, importSource?: "google" | "xlsx"): GuidedNotesQuestionSet {
    const preview = createImportPreview(result, googleSource, importSource ?? (googleSource === undefined ? "xlsx" : "google"));
    this.pending.set(preview.id, preview);
    return preview;
  }

  async confirm(previewId: string): Promise<GuidedNotesQuestionSet> {
    const existing = this.created.get(previewId);
    if (existing !== undefined) return existing;
    const preview = this.pending.get(previewId);
    if (preview === undefined) throw new Error("找不到待確認的匯入預覽，請重新匯入。");

    await mkdir(this.dataDirectory, { recursive: true });
    const outputPath = path.join(this.dataDirectory, `${preview.id}.json`);
    await writeFile(outputPath, `${JSON.stringify(preview, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    this.pending.delete(previewId);
    this.created.set(previewId, preview);
    return preview;
  }

  getCreatedQuestionSet(id: string): GuidedNotesQuestionSet | undefined {
    return this.created.get(id);
  }

  async readPersistedQuestionSet(id: string): Promise<GuidedNotesQuestionSet> {
    const contents = await readFile(path.join(this.dataDirectory, `${id}.json`), "utf8");
    return JSON.parse(contents) as GuidedNotesQuestionSet;
  }
}
