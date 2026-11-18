export type CellValue = string | number | boolean | null;

/** One-based, inclusive coordinates shared by every data-source adapter. */
export interface CellCoordinate {
  readonly row: number;
  readonly column: number;
}

/** One-based, inclusive rectangular range. */
export interface CellRange {
  readonly start: CellCoordinate;
  readonly end: CellCoordinate;
}

/** Sparse rows are represented by omitted array entries or null values. */
export interface GridSheet {
  readonly name: string;
  readonly rows: readonly (readonly CellValue[])[];
  readonly mergedRanges: readonly CellRange[];
}

export interface GridWorkbook {
  readonly sheets: readonly GridSheet[];
}

export interface LocatedCell {
  readonly sheetName: string;
  readonly row: number;
  readonly column: number;
}

export interface ParsedSubquestion {
  readonly number: number;
  readonly answerCell: LocatedCell;
  readonly labelCell?: LocatedCell;
}

export interface ParsedQuestion {
  readonly number: number;
  readonly numberCell: LocatedCell;
  readonly description: string;
  readonly subquestions: readonly ParsedSubquestion[];
  readonly type: "single" | "group";
}

export interface ParseWarning {
  readonly code: "answer-cell-already-filled" | "duplicate-answer-cell";
  readonly message: string;
  readonly cell: LocatedCell;
}

export interface ParseResult {
  readonly sheetName: string;
  readonly headerRow: number;
  readonly questions: readonly ParsedQuestion[];
  readonly warnings: readonly ParseWarning[];
}

export type ParseErrorCode =
  | "header-not-found"
  | "no-questions"
  | "question-number-invalid"
  | "question-number-duplicate"
  | "question-without-number";

export class GuidedNotesParseError extends Error {
  readonly code: ParseErrorCode;
  readonly cells: readonly LocatedCell[];

  constructor(
    code: ParseErrorCode,
    message: string,
    cells: readonly LocatedCell[] = [],
  ) {
    super(message);
    this.code = code;
    this.cells = cells;
    this.name = "GuidedNotesParseError";
  }
}
