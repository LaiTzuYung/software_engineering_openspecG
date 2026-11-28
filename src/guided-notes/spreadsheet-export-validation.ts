import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCellValue } from "./coordinates.ts";
import type { GoogleSpreadsheetSource, GuidedNotesQuestionSet, PreviewCell } from "./import-service.ts";
import type { CellValue, GridSheet, LocatedCell, ParseResult, ParsedQuestion, ParsedSubquestion } from "./model.ts";
import type { GoogleSheetsValueRange } from "./google-sheets-adapter.ts";
import { matchesAnswerMarkerState, parseGuidedNotes, replaceAnswerMarkers } from "./parser.ts";

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

export interface SpreadsheetExportRestoreTarget {
  readonly questionNumber: number;
  readonly subquestionNumber: number;
  readonly cell: PreviewCell;
  readonly currentValue: CellValue;
  readonly originalValue: CellValue;
  readonly lastWrittenValue: CellValue;
  readonly status: "將還原" | "已被手動修改";
}

export interface SpreadsheetExportRestorePreview {
  readonly id: string;
  readonly targets: readonly SpreadsheetExportRestoreTarget[];
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

interface StoredRestorePreview {
  readonly questionSet: GuidedNotesQuestionSet;
  readonly activityCode: string;
  readonly spreadsheetId: string;
  readonly gid?: number;
  readonly targets: readonly (SpreadsheetExportRestoreTarget & { readonly snapshotValue: CellValue })[];
}

interface ActivityCellBackup {
  readonly questionNumber: number;
  readonly subquestionNumber: number;
  readonly sheetName: string;
  readonly address: string;
  readonly originalValue: CellValue;
  readonly writtenValue: CellValue;
}

interface ValidBackup {
  readonly path: string;
  readonly value: SpreadsheetExportBackup;
}

function isCellValue(value: unknown): value is CellValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSpreadsheetExportBackup(value: unknown): value is SpreadsheetExportBackup {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.createdAt !== "string" ||
      !["pending", "succeeded", "failed"].includes(String(record.status)) ||
      typeof record.spreadsheetId !== "string" || typeof record.activityCode !== "string" ||
      (record.gid !== undefined && typeof record.gid !== "number") || !Array.isArray(record.targets)) return false;
  return record.targets.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const target = item as Record<string, unknown>;
    return typeof target.questionNumber === "number" && typeof target.subquestionNumber === "number" &&
      typeof target.sheetName === "string" && typeof target.address === "string" &&
      isCellValue(target.originalValue) && isCellValue(target.writtenValue);
  });
}

async function readBackupFiles(backupDirectory: string): Promise<ValidBackup[]> {
  let names: string[];
  try { names = await readdir(backupDirectory); }
  catch (error) { if (isMissingDirectory(error)) return []; throw error; }
  const backups: ValidBackup[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const backupPath = path.join(backupDirectory, name);
    try {
      const value: unknown = JSON.parse(await readFile(backupPath, "utf8"));
      if (isSpreadsheetExportBackup(value)) backups.push({ path: backupPath, value });
    } catch { /* Legacy and interrupted files are ignored unless their full shape is valid. */ }
  }
  return backups.sort((left, right) => left.value.createdAt.localeCompare(right.value.createdAt) || left.value.id.localeCompare(right.value.id));
}

async function activityBackups(
  backupDirectory: string,
  source: GoogleSpreadsheetSource,
  activityCode: string,
): Promise<ValidBackup[]> {
  return (await readBackupFiles(backupDirectory)).filter(({ value }) =>
    value.status === "succeeded" && value.activityCode === activityCode &&
    value.spreadsheetId === source.spreadsheetId && value.gid === source.gid);
}

function cellBackupKey(cell: Pick<ActivityCellBackup, "sheetName" | "address">): string {
  return `${cell.sheetName}!${cell.address}`;
}

function originalValueForTarget(
  prior: ActivityCellBackup | undefined,
  markerOriginalValue: CellValue | undefined,
  currentValue: CellValue,
): CellValue {
  if (prior !== undefined) return prior.originalValue;
  return markerOriginalValue === undefined ? currentValue : markerOriginalValue;
}

function q7LabelPrefix(value: CellValue): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\s*[（(]\s*\d+\s*[）)]/u.exec(value)?.[0];
}

function aggregateActivityCells(backups: readonly ValidBackup[]): Map<string, ActivityCellBackup> {
  const cells = new Map<string, ActivityCellBackup>();
  for (const { value } of backups) {
    for (const target of value.targets) {
      const key = cellBackupKey(target);
      const previous = cells.get(key);
      cells.set(key, {
        ...target,
        originalValue: previous === undefined ? target.originalValue : previous.originalValue,
      });
    }
  }
  return cells;
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
  if (questionSet.locatingMode === "marker") {
    return { sheet, parsed: validateMarkerQuestionSet(questionSet, sheet) };
  }
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

function toLocatedCell(cell: PreviewCell): LocatedCell {
  return { sheetName: cell.sheetName, row: cell.row, column: cell.column };
}

function validateMarkerQuestionSet(questionSet: GuidedNotesQuestionSet, sheet: GridSheet): ParseResult {
  if (sheet.name !== questionSet.sheetName) {
    throw new SpreadsheetStructureMismatchError(`工作表名稱不同：匯入時為「${questionSet.sheetName}」，目前為「${sheet.name}」。`);
  }
  const questions: ParsedQuestion[] = questionSet.questions.map((question) => {
    const numberCell = question.numberCell;
    if (numberCell === undefined || question.numberCellValue === undefined) {
      throw new SpreadsheetStructureMismatchError(`第 ${question.number} 題缺少匯入時的題號格快照，請重新匯入。`);
    }
    const currentNumber = getCellValue(sheet, numberCell.row, numberCell.column);
    if (currentNumber !== question.numberCellValue) {
      throw new SpreadsheetStructureMismatchError(
        `第 ${question.number} 題題號格不同：匯入時為「${numberCell.sheetName}!${numberCell.address}=${String(question.numberCellValue)}」，目前為「${numberCell.sheetName}!${numberCell.address}=${String(currentNumber ?? "（空白）")}」。請先還原再回寫。`,
      );
    }
    const subquestions: ParsedSubquestion[] = question.subquestions.map((subquestion) => {
      const answerCell = subquestion.answerCell;
      const template = questionSet.answerMarkerTemplates?.find((item) =>
        item.questionNumber === question.number && item.subquestionNumber === subquestion.number &&
        item.answerCell.sheetName === answerCell.sheetName && item.answerCell.address === answerCell.address);
      const currentValue = getCellValue(sheet, answerCell.row, answerCell.column);
      if (template === undefined || typeof currentValue !== "string" || !matchesAnswerMarkerState(template.originalValue, currentValue)) {
        throw new SpreadsheetStructureMismatchError(
          `第 ${question.number} 題小題 ${subquestion.number} 的作答格「${answerCell.sheetName}!${answerCell.address}」內容與匯入標記模板不同，請先還原再回寫。`,
        );
      }
      return {
        number: subquestion.number,
        answerCell: toLocatedCell(answerCell),
        ...(subquestion.labelCell === undefined ? {} : { labelCell: toLocatedCell(subquestion.labelCell) }),
      };
    });
    return {
      number: question.number,
      numberCell: toLocatedCell(numberCell),
      numberCellValue: question.numberCellValue,
      description: question.description,
      type: question.type,
      subquestions,
    };
  });
  return { mode: "marker", sheetName: sheet.name, headerRow: 0, questions, warnings: [], answerMarkerTemplates: [] };
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
  private readonly pendingRestores = new Map<string, StoredRestorePreview>();

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
      const labelIsAnswerCell = subquestion.labelCell !== undefined &&
        subquestion.labelCell.sheetName === subquestion.answerCell.sheetName &&
        subquestion.labelCell.row === subquestion.answerCell.row &&
        subquestion.labelCell.column === subquestion.answerCell.column;
      const writtenValue = template !== undefined
        ? replaceAnswerMarkers(template.originalValue, answer.answer)
        : labelIsAnswerCell
          ? `${q7LabelPrefix(currentValue) ?? String(currentValue ?? "")}${answer.answer}`
          : answer.answer;
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

    const previousCells = source === undefined
      ? new Map<string, ActivityCellBackup>()
      : aggregateActivityCells(await activityBackups(backupDirectory, source, activityCode));

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
        originalValue: originalValueForTarget(
          previousCells.get(`${target.cell.sheetName}!${target.cell.address}`),
          stored?.questionSet.answerMarkerTemplates?.find((template) =>
          template.questionNumber === target.questionNumber && template.subquestionNumber === target.subquestionNumber &&
          template.answerCell.address === target.cell.address)?.originalValue,
          target.currentValue,
        ),
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

  async createRestorePreview(
    questionSet: GuidedNotesQuestionSet,
    activityCode: string,
    backupDirectory = path.join(process.cwd(), "data", "spreadsheet-export-backups"),
  ): Promise<SpreadsheetExportRestorePreview> {
    const source = questionSet.googleSource;
    if (source === undefined) throw new SpreadsheetStructureMismatchError("題目集沒有 Google 試算表來源資訊，無法還原。");
    const cells = aggregateActivityCells(await activityBackups(backupDirectory, source, activityCode));
    if (cells.size === 0) return { id: randomUUID(), targets: [], message: "沒有可還原的成功回寫紀錄。" };

    const { sheet, parsed } = await readAndCompare(questionSet, this.readSpreadsheet);
    const targets: (SpreadsheetExportRestoreTarget & { snapshotValue: CellValue })[] = [];
    for (const record of cells.values()) {
      const subquestion = findSubquestion(parsed, record.questionNumber, record.subquestionNumber);
      const address = `${record.sheetName}!${record.address}`;
      if (subquestion === undefined || subquestion.answerCell.sheetName !== record.sheetName ||
          toPreviewCell(subquestion.answerCell).address !== record.address) {
        throw new SpreadsheetStructureMismatchError(`目前作答格位置與備份不一致：${address}。請重新匯入題目集後再還原。`);
      }
      const currentValue = getCellValue(sheet, subquestion.answerCell.row, subquestion.answerCell.column);
      targets.push({
        questionNumber: record.questionNumber,
        subquestionNumber: record.subquestionNumber,
        cell: toPreviewCell(subquestion.answerCell),
        currentValue,
        originalValue: record.originalValue,
        lastWrittenValue: record.writtenValue,
        status: currentValue === record.writtenValue ? "將還原" : "已被手動修改",
        snapshotValue: currentValue,
      });
    }
    targets.sort((left, right) => left.cell.sheetName.localeCompare(right.cell.sheetName) ||
      left.cell.row - right.cell.row || left.cell.column - right.cell.column);
    const id = randomUUID();
    const preview: SpreadsheetExportRestorePreview = { id, targets: targets.map(({ snapshotValue: _snapshot, ...target }) => target) };
    this.pendingRestores.set(id, {
      questionSet: structuredClone(questionSet),
      activityCode,
      spreadsheetId: source.spreadsheetId,
      ...(source.gid === undefined ? {} : { gid: source.gid }),
      targets: structuredClone(targets),
    });
    return preview;
  }

  async confirmRestore(
    previewId: string,
    activityCode: string,
    readSpreadsheet: (url: string) => Promise<GridSheet>,
    writeRawValues: (spreadsheetId: string, data: readonly GoogleSheetsValueRange[]) => Promise<number>,
    backupDirectory = path.join(process.cwd(), "data", "spreadsheet-export-backups"),
  ): Promise<SpreadsheetExportRestoreResult> {
    const stored = this.pendingRestores.get(previewId);
    if (stored === undefined) throw new SpreadsheetStructureMismatchError("找不到有效的還原預覽，請重新產生還原預覽。");
    this.pendingRestores.delete(previewId);
    if (stored.activityCode !== activityCode) throw new SpreadsheetStructureMismatchError("還原預覽不屬於目前活動，請重新產生還原預覽。");
    const source = stored.questionSet.googleSource;
    if (source === undefined || source.spreadsheetId !== stored.spreadsheetId || source.gid !== stored.gid) {
      throw new SpreadsheetStructureMismatchError("還原預覽的試算表來源已改變，請重新產生還原預覽。");
    }
    if (stored.targets.length === 0) return { restored: [], skipped: [], failed: [], message: "沒有可還原的成功回寫紀錄。" };

    const { sheet, parsed } = await readAndCompare(stored.questionSet, readSpreadsheet);
    const resolved: { target: StoredRestorePreview["targets"][number]; row: number; column: number }[] = [];
    for (const target of stored.targets) {
      const subquestion = findSubquestion(parsed, target.questionNumber, target.subquestionNumber);
      if (subquestion === undefined || subquestion.answerCell.sheetName !== target.cell.sheetName ||
          toPreviewCell(subquestion.answerCell).address !== target.cell.address) {
        throw new SpreadsheetStructureMismatchError(`還原作答格 ${cellLocation(target.cell)} 位置已改變，請重新產生還原預覽。`);
      }
      const currentValue = getCellValue(sheet, subquestion.answerCell.row, subquestion.answerCell.column);
      if (currentValue !== target.snapshotValue) {
        throw new SpreadsheetStructureMismatchError(`還原預覽後試算表內容已改變（${cellLocation(target.cell)}），請重新產生還原預覽。`);
      }
      resolved.push({ target, row: subquestion.answerCell.row, column: subquestion.answerCell.column });
    }

    const ranges: GoogleSheetsValueRange[] = resolved.map(({ target }) => ({
      range: `'${target.cell.sheetName.replace(/'/gu, "''")}'!${target.cell.address}`,
      values: [[target.originalValue === null ? "" : target.originalValue]],
    }));
    await writeRawValues(source.spreadsheetId, ranges);
    const afterRestore = await readSpreadsheet(sourceUrl(source));
    const restored: { address: string }[] = [];
    const failed: SpreadsheetExportRestoreResult["failed"][number][] = [];
    for (const { target, row, column } of resolved) {
      const actualValue = getCellValue(afterRestore, row, column);
      const actualBlank = actualValue === null || actualValue === "";
      const expectedBlank = target.originalValue === null || target.originalValue === "";
      const address = cellLocation(target.cell);
      if ((actualBlank && expectedBlank) || actualValue === target.originalValue) restored.push({ address });
      else failed.push({ address, reason: "還原後重新讀取的內容與備份原值不同。", actualValue, expectedValue: target.originalValue });
    }
    return { restored, skipped: [], failed };
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
