import { randomUUID } from "node:crypto";
import { getCellValue } from "./coordinates.ts";
import type { GoogleSpreadsheetSource, GuidedNotesQuestionSet, PreviewCell } from "./import-service.ts";
import type { GridSheet, ParsedSubquestion } from "./model.ts";
import { parseGuidedNotes } from "./parser.ts";

export interface PlannedSpreadsheetAnswer {
  readonly questionNumber: number;
  readonly subquestionNumber: number;
  readonly answer: string;
}

export interface SpreadsheetExportTarget {
  readonly questionNumber: number;
  readonly subquestionNumber: number;
  readonly cell: PreviewCell;
  readonly currentValue: string | number | boolean | null;
  readonly answer: string;
  readonly status: "write" | "same";
}

export interface SpreadsheetExportPreview {
  readonly id: string;
  readonly targets: readonly SpreadsheetExportTarget[];
}

export class SpreadsheetStructureMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetStructureMismatchError";
  }
}

function sourceUrl(source: GoogleSpreadsheetSource): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(source.spreadsheetId)}/edit?gid=${source.gid}`;
}

function cellLocation(cell: PreviewCell): string {
  return `${cell.sheetName}!${cell.address}`;
}

function questionMap(questionSet: GuidedNotesQuestionSet) {
  return new Map(questionSet.questions.map((question) => [question.number, question]));
}

function subquestionMap(subquestions: readonly { readonly number: number }[]) {
  return new Map(subquestions.map((subquestion) => [subquestion.number, subquestion]));
}

function assertCellMatches(
  questionNumber: number,
  subquestionNumber: number,
  kind: "作答格" | "標籤格",
  imported: PreviewCell | undefined,
  current: PreviewCell | undefined,
): void {
  if (imported === undefined && current === undefined) return;
  if (imported === undefined) {
    throw new SpreadsheetStructureMismatchError(
      `第 ${questionNumber} 題小題 ${subquestionNumber} 新增${kind}：目前為「${cellLocation(current!)}」。`,
    );
  }
  if (current === undefined) {
    throw new SpreadsheetStructureMismatchError(
      `第 ${questionNumber} 題小題 ${subquestionNumber} 的${kind}不見了：匯入時為「${cellLocation(imported)}」。`,
    );
  }
  if (
    imported.sheetName !== current.sheetName ||
    imported.row !== current.row ||
    imported.column !== current.column
  ) {
    throw new SpreadsheetStructureMismatchError(
      `第 ${questionNumber} 題小題 ${subquestionNumber} 的${kind}不同：匯入時為「${cellLocation(imported)}」，目前為「${cellLocation(current)}」。`,
    );
  }
}

/** Compares imported question identities and located cells against a fresh parse. */
export function compareQuestionSetStructure(
  imported: GuidedNotesQuestionSet,
  current: ReturnType<typeof parseGuidedNotes>,
): void {
  const importedQuestions = questionMap(imported);
  const currentQuestions = new Map(current.questions.map((question) => [question.number, question]));

  for (const question of current.questions) {
    if (!importedQuestions.has(question.number)) {
      throw new SpreadsheetStructureMismatchError(`試算表新增第 ${question.number} 題，請重新匯入後再回寫。`);
    }
  }
  for (const question of imported.questions) {
    const currentQuestion = currentQuestions.get(question.number);
    if (currentQuestion === undefined) {
      throw new SpreadsheetStructureMismatchError(`匯入時的第 ${question.number} 題目前不存在，請重新匯入後再回寫。`);
    }
    if (question.type !== currentQuestion.type) {
      throw new SpreadsheetStructureMismatchError(
        `第 ${question.number} 題題型不同：匯入時為「${question.type === "group" ? "題組" : "單題"}」，目前為「${currentQuestion.type === "group" ? "題組" : "單題"}」。`,
      );
    }

    const importedSubquestions = subquestionMap(question.subquestions);
    const currentSubquestions = new Map(currentQuestion.subquestions.map((item) => [item.number, item]));
    for (const subquestion of currentQuestion.subquestions) {
      if (!importedSubquestions.has(subquestion.number)) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${question.number} 題新增小題 ${subquestion.number}，請重新匯入後再回寫。`,
        );
      }
    }
    for (const subquestion of question.subquestions) {
      const currentSubquestion = currentSubquestions.get(subquestion.number);
      if (currentSubquestion === undefined) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${question.number} 題小題 ${subquestion.number} 目前不存在，請重新匯入後再回寫。`,
        );
      }
      assertCellMatches(
        question.number,
        subquestion.number,
        "作答格",
        subquestion.answerCell,
        toPreviewCell(currentSubquestion.answerCell),
      );
      assertCellMatches(
        question.number,
        subquestion.number,
        "標籤格",
        subquestion.labelCell,
        currentSubquestion.labelCell === undefined ? undefined : toPreviewCell(currentSubquestion.labelCell),
      );
    }
  }

  if (current.sheetName !== imported.sheetName) {
    throw new SpreadsheetStructureMismatchError(
      `工作表名稱不同：匯入時為「${imported.sheetName}」，目前為「${current.sheetName}」。`,
    );
  }
}

function toPreviewCell(cell: ParsedSubquestion["answerCell"]): PreviewCell {
  const column = cell.column;
  let letters = "";
  let remaining = column;
  while (remaining > 0) {
    remaining -= 1;
    letters = String.fromCharCode(65 + remaining % 26) + letters;
    remaining = Math.floor(remaining / 26);
  }
  return { sheetName: cell.sheetName, address: `${letters}${cell.row}`, row: cell.row, column };
}

async function readAndCompare(
  questionSet: GuidedNotesQuestionSet,
  readSpreadsheet: (url: string) => Promise<GridSheet>,
): Promise<{ readonly sheet: GridSheet; readonly parsed: ReturnType<typeof parseGuidedNotes> }> {
  const source = questionSet.googleSource;
  if (source === undefined) {
    throw new SpreadsheetStructureMismatchError("題目集沒有 Google 試算表來源資訊，無法重新定位作答格。");
  }

  const sheet = await readSpreadsheet(sourceUrl(source));
  let parsed: ReturnType<typeof parseGuidedNotes>;
  try {
    parsed = parseGuidedNotes(sheet);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知解析錯誤";
    throw new SpreadsheetStructureMismatchError(`重新解析試算表失敗：${message}`);
  }
  compareQuestionSetStructure(questionSet, parsed);
  return { sheet, parsed };
}

function findSubquestion(
  parsed: ReturnType<typeof parseGuidedNotes>,
  questionNumber: number,
  subquestionNumber: number,
): ParsedSubquestion | undefined {
  return parsed.questions
    .find((question) => question.number === questionNumber)
    ?.subquestions.find((subquestion) => subquestion.number === subquestionNumber);
}

interface StoredPreview {
  readonly questionSet: GuidedNotesQuestionSet;
  readonly preview: SpreadsheetExportPreview;
}

/** Keeps export preview coordinates and answers on the server and validates them again on confirmation. */
export class SpreadsheetExportPreviewService {
  private readonly readSpreadsheet: (url: string) => Promise<GridSheet>;
  private readonly pending = new Map<string, StoredPreview>();

  constructor(readSpreadsheet: (url: string) => Promise<GridSheet>) {
    this.readSpreadsheet = readSpreadsheet;
  }

  async create(
    questionSet: GuidedNotesQuestionSet,
    answers: readonly PlannedSpreadsheetAnswer[],
  ): Promise<SpreadsheetExportPreview> {
    const { sheet, parsed } = await readAndCompare(questionSet, this.readSpreadsheet);
    const seen = new Set<string>();
    const targets: SpreadsheetExportTarget[] = answers.map((answer) => {
      const key = `${answer.questionNumber}:${answer.subquestionNumber}`;
      if (seen.has(key)) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${answer.questionNumber} 題小題 ${answer.subquestionNumber} 重複出現在回寫清單。`,
        );
      }
      seen.add(key);
      const subquestion = findSubquestion(parsed, answer.questionNumber, answer.subquestionNumber);
      if (subquestion === undefined) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${answer.questionNumber} 題小題 ${answer.subquestionNumber} 不存在，無法建立回寫預覽。`,
        );
      }
      const cell = toPreviewCell(subquestion.answerCell);
      const currentValue = getCellValue(sheet, cell.row, cell.column);
      return {
        questionNumber: answer.questionNumber,
        subquestionNumber: answer.subquestionNumber,
        cell,
        currentValue,
        answer: answer.answer,
        status: currentValue === answer.answer ? "same" : "write",
      };
    });
    const preview: SpreadsheetExportPreview = { id: randomUUID(), targets };
    this.pending.set(preview.id, {
      questionSet: structuredClone(questionSet),
      preview: structuredClone(preview),
    });
    return structuredClone(preview);
  }

  async confirm(previewId: string): Promise<SpreadsheetExportPreview> {
    const stored = this.pending.get(previewId);
    if (stored === undefined) throw new SpreadsheetStructureMismatchError("找不到有效的回寫預覽，請重新產生預覽。");
    this.pending.delete(previewId);

    const { sheet, parsed } = await readAndCompare(stored.questionSet, this.readSpreadsheet);
    for (const target of stored.preview.targets) {
      const subquestion = findSubquestion(parsed, target.questionNumber, target.subquestionNumber)!;
      const currentValue = getCellValue(sheet, subquestion.answerCell.row, subquestion.answerCell.column);
      if (currentValue !== target.currentValue) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${target.questionNumber} 題小題 ${target.subquestionNumber}（${cellLocation(target.cell)}）的內容在預覽後已改變，請重新產生預覽。`,
        );
      }
    }
    return structuredClone(stored.preview);
  }
}

export async function validateGoogleQuestionSetStructure(
  questionSet: GuidedNotesQuestionSet,
  readSpreadsheet: (url: string) => Promise<GridSheet>,
): Promise<void> {
  await readAndCompare(questionSet, readSpreadsheet);
}
