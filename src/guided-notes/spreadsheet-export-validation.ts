import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCellValue } from "./coordinates.ts";
import type { GoogleSpreadsheetSource, GuidedNotesQuestionSet, PreviewCell } from "./import-service.ts";
import type { CellValue, GridSheet, ParsedSubquestion } from "./model.ts";
import type { GoogleSheetsValueRange } from "./google-sheets-adapter.ts";
import { parseGuidedNotes, replaceAnswerMarkers } from "./parser.ts";

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
  readonly status: "將寫入" | "內容相同略過";
}

export interface SpreadsheetExportPreview {
  readonly id: string;
  readonly locatingMethod: string;
  readonly targets: readonly SpreadsheetExportTarget[];
}

export interface SpreadsheetExportWriteResult {
  readonly preview: SpreadsheetExportPreview;
  readonly backupPath?: string;
  readonly updatedCells: number;
}

export interface SpreadsheetExportRestoreResult {
  readonly backupPath?: string;
  readonly restored: readonly { readonly address: string }[];
  readonly skipped: readonly {
    readonly address: string;
    readonly reason: string;
    readonly currentValue: CellValue;
    readonly expectedValue: CellValue;
  }[];
  readonly failed: readonly {
    readonly address: string;
    readonly reason: string;
    readonly actualValue: CellValue;
    readonly expectedValue: CellValue;
  }[];
  readonly message?: string;
}

interface SpreadsheetExportBackup {
  readonly id: string;
  readonly createdAt: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly spreadsheetId: string;
  readonly gid?: number;
  readonly activityCode: string;
  readonly targets: readonly {
    readonly questionNumber: number;
    readonly subquestionNumber: number;
    readonly sheetName: string;
    readonly address: string;
    readonly originalValue: CellValue;
    readonly writtenValue: CellValue;
  }[];
}

export class SpreadsheetExportWriteError extends Error {
  readonly backupPath: string;

  constructor(message: string, backupPath: string) {
    super(`${message}（備份檔：${backupPath}）`);
    this.backupPath = backupPath;
    this.name = "SpreadsheetExportWriteError";
  }
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
    const restoreHint = questionSet.locatingMode === "marker" ? "請先還原再回寫。" : "";
    throw new SpreadsheetStructureMismatchError(`重新解析試算表失敗：${message}${restoreHint}`);
  }
  try {
    compareQuestionSetStructure(questionSet, parsed);
  } catch (error) {
    if (questionSet.locatingMode === "marker") {
      throw new SpreadsheetStructureMismatchError(`${error instanceof Error ? error.message : "定位結構不同。"}請先還原再回寫。`);
    }
    throw error;
  }
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
  readonly activityCode?: string;
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
    activityCode?: string,
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
      const template = questionSet.answerMarkerTemplates?.find((item) =>
        item.questionNumber === answer.questionNumber && item.subquestionNumber === answer.subquestionNumber &&
        item.answerCell.address === cell.address && item.answerCell.sheetName === cell.sheetName);
      const writtenValue = template === undefined
        ? answer.answer
        : replaceAnswerMarkers(template.originalValue, answer.answer);
      return {
        questionNumber: answer.questionNumber,
        subquestionNumber: answer.subquestionNumber,
        cell,
        currentValue,
        answer: writtenValue,
        status: currentValue === writtenValue ? "內容相同略過" : "將寫入",
      };
    });
    const preview: SpreadsheetExportPreview = { id: randomUUID(), locatingMethod: questionSet.locatingMode === "marker" ? "定位方式：{{答}} 標記" : "定位方式：表頭", targets };
    this.pending.set(preview.id, {
      questionSet: structuredClone(questionSet),
      preview: structuredClone(preview),
      ...(activityCode === undefined ? {} : { activityCode }),
    });
    return structuredClone(preview);
  }

  async confirm(previewId: string, activityCode?: string): Promise<SpreadsheetExportPreview> {
    const stored = this.pending.get(previewId);
    if (stored === undefined) throw new SpreadsheetStructureMismatchError("找不到有效的回寫預覽，請重新產生預覽。");
    this.pending.delete(previewId);
    if (stored.activityCode !== activityCode) {
      throw new SpreadsheetStructureMismatchError("回寫預覽不屬於目前活動，請重新產生預覽。");
    }

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

  async confirmAndWrite(
    previewId: string,
    activityCode: string,
    writeRawValues: (spreadsheetId: string, data: readonly GoogleSheetsValueRange[]) => Promise<number>,
    backupDirectory = path.join(process.cwd(), "data", "spreadsheet-export-backups"),
  ): Promise<SpreadsheetExportWriteResult> {
    const stored = this.pending.get(previewId);
    const preview = await this.confirm(previewId, activityCode);
    const source = stored?.questionSet.googleSource;
    if (source === undefined) {
      throw new SpreadsheetStructureMismatchError("題目集沒有 Google 試算表來源資訊，無法回寫。");
    }
    const targets = preview.targets.filter(({ status }) => status === "將寫入");
    if (targets.length === 0) return { preview, updatedCells: 0 };

    const backupPath = path.join(backupDirectory, `export-${randomUUID()}.json`);
    const backup = {
      id: path.basename(backupPath, ".json"),
      createdAt: new Date().toISOString(),
      status: "pending" as "pending" | "succeeded" | "failed",
      spreadsheetId: source.spreadsheetId,
      gid: source.gid,
      activityCode,
      targets: targets.map((target) => ({
        questionNumber: target.questionNumber,
        subquestionNumber: target.subquestionNumber,
        sheetName: target.cell.sheetName,
        address: target.cell.address,
        originalValue: stored?.questionSet.answerMarkerTemplates?.find((template) =>
          template.questionNumber === target.questionNumber && template.subquestionNumber === target.subquestionNumber &&
          template.answerCell.address === target.cell.address)?.originalValue ?? target.currentValue,
        writtenValue: target.answer,
      })),
    };
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    const data: GoogleSheetsValueRange[] = targets.map((target) => ({
      range: `'${target.cell.sheetName.replace(/'/gu, "''")}'!${target.cell.address}`,
      values: [[target.answer]],
    }));
    try {
      const updatedCells = await writeRawValues(source.spreadsheetId, data);
      backup.status = "succeeded";
      await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
      return { preview, backupPath, updatedCells };
    } catch (error) {
      backup.status = "failed";
      const message = error instanceof Error ? error.message : "Google Sheets API 寫入失敗。";
      await writeFile(backupPath, `${JSON.stringify({ ...backup, error: message }, null, 2)}\n`, "utf8");
      throw new SpreadsheetExportWriteError(message, backupPath);
    }
  }

  async restoreLatest(
    questionSet: GuidedNotesQuestionSet,
    readSpreadsheet: (url: string) => Promise<GridSheet>,
    writeRawValues: (spreadsheetId: string, data: readonly GoogleSheetsValueRange[]) => Promise<number>,
    backupDirectory = path.join(process.cwd(), "data", "spreadsheet-export-backups"),
  ): Promise<SpreadsheetExportRestoreResult> {
    const source = questionSet.googleSource;
    if (source === undefined) throw new SpreadsheetStructureMismatchError("題目集沒有 Google 試算表來源資訊，無法還原。");
    let names: string[];
    try {
      names = await readdir(backupDirectory);
    } catch (error) {
      if (isMissingDirectory(error)) {
        return { restored: [], skipped: [], failed: [], message: "沒有可還原的成功回寫紀錄。" };
      }
      throw error;
    }
    const backups: { path: string; value: SpreadsheetExportBackup }[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const backupPath = path.join(backupDirectory, name);
      try {
        const value = JSON.parse(await readFile(backupPath, "utf8")) as SpreadsheetExportBackup;
        if (value.status === "succeeded" && value.spreadsheetId === source.spreadsheetId && value.gid === source.gid && Array.isArray(value.targets)) {
          backups.push({ path: backupPath, value });
        }
      } catch { /* Ignore incomplete or malformed backup files. */ }
    }
    backups.sort((left, right) => right.value.createdAt.localeCompare(left.value.createdAt));
    const latest = backups[0];
    if (latest === undefined) return { restored: [], skipped: [], failed: [], message: "沒有可還原的成功回寫紀錄。" };

    const { sheet, parsed } = await readAndCompare(questionSet, readSpreadsheet);
    const restored: { address: string }[] = [];
    const skipped: { address: string; reason: string; currentValue: CellValue; expectedValue: CellValue }[] = [];
    const candidates: { address: string; sheetName: string; cellAddress: string; row: number; column: number; originalValue: CellValue }[] = [];
    const data: GoogleSheetsValueRange[] = [];
    for (const target of latest.value.targets) {
      const subquestion = findSubquestion(parsed, target.questionNumber, target.subquestionNumber);
      const address = `${target.sheetName}!${target.address}`;
      if (subquestion === undefined || subquestion.answerCell.sheetName !== target.sheetName ||
          toPreviewCell(subquestion.answerCell).address !== target.address) {
        skipped.push({ address, reason: "目前作答格位置與備份不一致。", currentValue: null, expectedValue: target.writtenValue });
        continue;
      }
      const currentValue = getCellValue(sheet, subquestion.answerCell.row, subquestion.answerCell.column);
      if (currentValue !== target.writtenValue) {
        skipped.push({ address, reason: "目前內容與當次回寫值不同，為避免覆蓋後續修改而跳過。", currentValue, expectedValue: target.writtenValue });
        continue;
      }
      data.push({
        range: `'${target.sheetName.replace(/'/gu, "''")}'!${target.address}`,
        values: [[target.originalValue === null ? "" : target.originalValue]],
      });
      candidates.push({
        address, sheetName: target.sheetName, cellAddress: target.address,
        row: subquestion.answerCell.row, column: subquestion.answerCell.column,
        originalValue: target.originalValue,
      });
    }
    const failed: { address: string; reason: string; actualValue: CellValue; expectedValue: CellValue }[] = [];
    if (data.length > 0) {
      await writeRawValues(source.spreadsheetId, data);
      const afterRestore = await readSpreadsheet(sourceUrl(source));
      for (const candidate of candidates) {
        const actualValue = getCellValue(afterRestore, candidate.row, candidate.column);
        const actualBlank = actualValue === null || actualValue === "";
        const expectedBlank = candidate.originalValue === null || candidate.originalValue === "";
        if ((actualBlank && expectedBlank) || actualValue === candidate.originalValue) {
          restored.push({ address: candidate.address });
        } else {
          failed.push({
            address: candidate.address,
            reason: "還原後重新讀取的內容與備份原值不同。",
            actualValue,
            expectedValue: candidate.originalValue,
          });
        }
      }
    }
    return { backupPath: latest.path, restored, skipped, failed };
  }
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function validateGoogleQuestionSetStructure(
  questionSet: GuidedNotesQuestionSet,
  readSpreadsheet: (url: string) => Promise<GridSheet>,
): Promise<void> {
  await readAndCompare(questionSet, readSpreadsheet);
}
