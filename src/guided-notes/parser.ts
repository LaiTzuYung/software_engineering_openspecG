import {
  getCellValue,
  hasContent,
  rangeAt,
  rangeContains,
  toA1,
  topLeftOfRange,
} from "./coordinates.ts";
import {
  GuidedNotesParseError,
  type CellRange,
  type CellValue,
  type GridSheet,
  type LocatedCell,
  type ParseResult,
  type ParseWarning,
  type ParsedQuestion,
  type ParsedSubquestion,
} from "./model.ts";

export interface HeaderKeywords {
  readonly question: readonly string[];
  readonly description: readonly string[];
  readonly answer: readonly string[];
}

export interface ParseOptions {
  readonly headerScanRows?: number;
  readonly keywords?: Partial<HeaderKeywords>;
}

interface HeaderLocation {
  readonly row: number;
  readonly questionColumn: number;
  readonly descriptionColumn?: number;
  readonly answerStartColumn: number;
  readonly answerEndColumn: number;
}

const DEFAULT_KEYWORDS: HeaderKeywords = {
  question: ["題號"],
  description: ["題目"],
  answer: ["作答"],
};

function normalizeHeader(value: CellValue): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, "");
}

function headerMatches(value: CellValue, candidates: readonly string[]): boolean {
  const normalized = normalizeHeader(value);
  return candidates.some((candidate) => normalized.includes(normalizeHeader(candidate)));
}

function findHeader(sheet: GridSheet, options: ParseOptions): HeaderLocation {
  const keywords: HeaderKeywords = {
    question: options.keywords?.question ?? DEFAULT_KEYWORDS.question,
    description: options.keywords?.description ?? DEFAULT_KEYWORDS.description,
    answer: options.keywords?.answer ?? DEFAULT_KEYWORDS.answer,
  };
  const scanRows = options.headerScanRows ?? 20;

  for (let row = 1; row <= Math.min(scanRows, sheet.rows.length); row += 1) {
    const values = sheet.rows[row - 1] ?? [];
    const questionColumns: number[] = [];
    let descriptionColumn: number | undefined;
    const answerColumns: number[] = [];

    for (let column = 1; column <= values.length; column += 1) {
      const value = values[column - 1] ?? null;
      if (headerMatches(value, keywords.question)) {
        questionColumns.push(column);
      }
      if (descriptionColumn === undefined && headerMatches(value, keywords.description)) {
        descriptionColumn = column;
      }
      if (headerMatches(value, keywords.answer)) {
        answerColumns.push(column);
      }
    }

    const questionColumn = questionColumns.find((candidate) =>
      answerColumns.some((answerCandidate) => answerCandidate !== candidate),
    );
    const answerColumn = questionColumn === undefined
      ? undefined
      : answerColumns.find((candidate) => candidate !== questionColumn);

    if (questionColumn !== undefined && answerColumn !== undefined) {
      const answerRange = rangeAt(sheet.mergedRanges, row, answerColumn);
      return {
        row,
        questionColumn,
        ...(descriptionColumn === undefined ? {} : { descriptionColumn }),
        answerStartColumn: answerRange?.start.column ?? answerColumn,
        answerEndColumn: answerRange?.end.column ?? answerColumn,
      };
    }
  }

  throw new GuidedNotesParseError("header-not-found", "找不到表頭：前 20 列沒有同時包含題號與作答。");
}

function location(sheet: GridSheet, row: number, column: number): LocatedCell {
  return { sheetName: sheet.name, row, column };
}

function normalizeQuestionNumber(value: CellValue): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  const normalized = value.normalize("NFKC").replace(/\s+/gu, "").toUpperCase();
  const match = /^(?:第)?(?:Q)?(\d+)(?:題)?\.?$/u.exec(normalized);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function stringValue(value: CellValue): string {
  return value === null ? "" : String(value).trim();
}

function rowHasContent(sheet: GridSheet, row: number, header: HeaderLocation): boolean {
  if (
    header.descriptionColumn !== undefined &&
    hasContent(getCellValue(sheet, row, header.descriptionColumn))
  ) {
    return true;
  }
  for (let column = header.answerStartColumn; column <= header.answerEndColumn; column += 1) {
    if (hasContent(getCellValue(sheet, row, column))) return true;
  }
  return false;
}

function firstContentCell(sheet: GridSheet, row: number, header: HeaderLocation): LocatedCell {
  if (header.descriptionColumn !== undefined && hasContent(getCellValue(sheet, row, header.descriptionColumn))) {
    return location(sheet, row, header.descriptionColumn);
  }
  for (let column = header.answerStartColumn; column <= header.answerEndColumn; column += 1) {
    if (hasContent(getCellValue(sheet, row, column))) return location(sheet, row, column);
  }
  return location(sheet, row, header.questionColumn);
}

function subquestionLabel(value: CellValue): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\(\s*(\d+)\s*\)/u.exec(value.normalize("NFKC").trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function answerCellForRow(
  sheet: GridSheet,
  row: number,
  header: HeaderLocation,
  warnings: ParseWarning[],
  defaultSubquestionNumber: number,
): { answerCell: LocatedCell; labelCell?: LocatedCell; number: number } {
  const firstColumn = header.answerStartColumn;
  const labelValue = getCellValue(sheet, row, firstColumn);
  const labelNumber = subquestionLabel(labelValue);

  if (labelNumber !== undefined) {
    const labelRange = rangeAt(sheet.mergedRanges, row, firstColumn);
    const firstCandidate = labelRange?.end.column !== undefined
      ? labelRange.end.column + 1
      : firstColumn + 1;
    const candidates: number[] = [];
    for (let column = firstCandidate; column <= header.answerEndColumn; column += 1) {
      if (labelRange && rangeContains(labelRange, row, column)) continue;
      const mergedAnswerRange = rangeAt(sheet.mergedRanges, row, column);
      const answerColumn = mergedAnswerRange?.start.column ?? column;
      if (answerColumn < firstCandidate || answerColumn > header.answerEndColumn) continue;
      if (!candidates.includes(answerColumn)) candidates.push(answerColumn);
    }

    if (candidates.length === 0) {
      const labelCell = location(sheet, row, firstColumn);
      return { answerCell: labelCell, labelCell, number: labelNumber };
    }

    const emptyCandidate = candidates.find((column) => !hasContent(getCellValue(sheet, row, column)));
    const selectedColumn = emptyCandidate ?? candidates[0]!;
    if (emptyCandidate === undefined) {
      warnings.push({
        code: "answer-cell-already-filled",
        message: "標籤右側候選作答格均已有內容，已取第一格。",
        cell: location(sheet, row, selectedColumn),
      });
    }
    const selectedRange = rangeAt(sheet.mergedRanges, row, selectedColumn);
    const answerCoordinate = selectedRange ? topLeftOfRange(selectedRange) : { row, column: selectedColumn };
    return {
      answerCell: location(sheet, answerCoordinate.row, answerCoordinate.column),
      labelCell: location(sheet, row, firstColumn),
      number: labelNumber,
    };
  }

  const answerRange = rangeAt(sheet.mergedRanges, row, firstColumn);
  const answerCoordinate = answerRange ? topLeftOfRange(answerRange) : { row, column: firstColumn };
  return {
    answerCell: location(sheet, answerCoordinate.row, answerCoordinate.column),
    number: defaultSubquestionNumber,
  };
}

function sameCoordinate(left: LocatedCell, right: LocatedCell): boolean {
  return left.sheetName === right.sheetName && left.row === right.row && left.column === right.column;
}

function duplicateNumberErrors(questions: readonly ParsedQuestion[]): Map<number, LocatedCell[]> {
  const locationsByNumber = new Map<number, LocatedCell[]>();
  for (const question of questions) {
    const locations = locationsByNumber.get(question.number) ?? [];
    locations.push(question.numberCell);
    locationsByNumber.set(question.number, locations);
  }
  return new Map([...locationsByNumber].filter(([, locations]) => locations.length > 1));
}

function attachSubquestion(
  question: ParsedQuestion,
  subquestion: ParsedSubquestion,
  warnings: ParseWarning[],
): ParsedQuestion {
  if (question.subquestions.some(({ answerCell }) => sameCoordinate(answerCell, subquestion.answerCell))) {
    warnings.push({
      code: "duplicate-answer-cell",
      message: `同一題的多個小題定位到相同作答格，保留首次解析（${subquestion.answerCell.sheetName}!${toA1(subquestion.answerCell)}）。`,
      cell: subquestion.answerCell,
    });
    return question;
  }
  const subquestions = [...question.subquestions, subquestion];
  return { ...question, subquestions, type: subquestions.length === 1 ? "single" : "group" };
}

export function parseGuidedNotes(sheet: GridSheet, options: ParseOptions = {}): ParseResult {
  const header = findHeader(sheet, options);
  const questions: ParsedQuestion[] = [];
  const warnings: ParseWarning[] = [];
  let currentQuestion: ParsedQuestion | undefined;
  let skippingInvalidQuestion = false;

  for (let row = header.row + 1; row <= sheet.rows.length; row += 1) {
    const questionValue = getCellValue(sheet, row, header.questionColumn);
    const questionRange = rangeAt(sheet.mergedRanges, row, header.questionColumn);
    const isContinuationOfMergedQuestion = questionRange !== undefined && questionRange.start.row < row;
    const meaningful = rowHasContent(sheet, row, header);

    if (!hasContent(questionValue) && !meaningful) continue;

    if (hasContent(questionValue) && !isContinuationOfMergedQuestion) {
      const number = normalizeQuestionNumber(questionValue);
      if (number === undefined) {
        const cell = location(sheet, row, header.questionColumn);
        warnings.push({
          code: "question-number-invalid",
          message: `題號無法解析：${String(questionValue)}（${sheet.name}!${toA1(cell)}），已略過該題及後續同題列。`,
          cell,
        });
        currentQuestion = undefined;
        skippingInvalidQuestion = true;
        continue;
      }
      skippingInvalidQuestion = false;
      currentQuestion = {
        number,
        numberCell: location(sheet, row, header.questionColumn),
        description:
          header.descriptionColumn === undefined
            ? ""
            : stringValue(getCellValue(sheet, row, header.descriptionColumn)),
        subquestions: [],
        type: "single",
      };
      questions.push(currentQuestion);
    } else if (meaningful && currentQuestion === undefined) {
      if (skippingInvalidQuestion) continue;
      const cell = firstContentCell(sheet, row, header);
      warnings.push({
        code: "content-before-first-question",
        message: `第一個有效題號前的內容已略過（${sheet.name}!${toA1(cell)}）。`,
        cell,
      });
      continue;
    }

    const shouldCreateSubquestion = meaningful || (hasContent(questionValue) && !isContinuationOfMergedQuestion);
    if (shouldCreateSubquestion && currentQuestion !== undefined) {
      const resolved = answerCellForRow(
        sheet,
        row,
        header,
        warnings,
        currentQuestion.subquestions.length + 1,
      );
      currentQuestion = attachSubquestion(currentQuestion, {
        number: resolved.number,
        answerCell: resolved.answerCell,
        ...(resolved.labelCell === undefined ? {} : { labelCell: resolved.labelCell }),
      }, warnings);
      questions[questions.length - 1] = currentQuestion;
    }
  }

  const duplicates = duplicateNumberErrors(questions);
  if (duplicates.size > 0) {
    const allLocations = [...duplicates.values()].flat();
    const detail = [...duplicates]
      .map(([number, cells]) => `${number}: ${cells.map((cell) => `${cell.sheetName}!${toA1(cell)}`).join("、")}`)
      .join("；");
    throw new GuidedNotesParseError(
      "question-number-duplicate",
      `題號重複：${detail}。`,
      allLocations,
    );
  }

  if (questions.length === 0) {
    throw new GuidedNotesParseError("no-questions", "沒有偵測到題目。表頭下方沒有可解析的題目。");
  }

  const orderedNumbers = [...new Set(questions.map(({ number }) => number))].sort((left, right) => left - right);
  let previousNumber = 0;
  for (const questionNumber of orderedNumbers) {
    if (questionNumber > previousNumber + 1) {
      const firstMissing = previousNumber + 1;
      const lastMissing = questionNumber - 1;
      const range = firstMissing === lastMissing ? String(firstMissing) : `${firstMissing}～${lastMissing}`;
      const question = questions.find(({ number }) => number === questionNumber)!;
      warnings.push({
        code: "question-number-gap",
        message: `題號缺號：${range}。`,
        cell: question.numberCell,
      });
    }
    previousNumber = questionNumber;
  }

  return { sheetName: sheet.name, headerRow: header.row, questions, warnings };
}

export type { CellRange };
