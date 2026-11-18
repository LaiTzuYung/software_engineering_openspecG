import type { CellCoordinate, CellRange, CellValue, GridSheet } from "./model.ts";

export function columnNumberToLetters(column: number): string {
  if (!Number.isInteger(column) || column < 1) {
    throw new RangeError("欄號必須是大於 0 的整數");
  }

  let current = column;
  let letters = "";
  while (current > 0) {
    current -= 1;
    letters = String.fromCharCode(65 + (current % 26)) + letters;
    current = Math.floor(current / 26);
  }
  return letters;
}

export function toA1(coordinate: CellCoordinate): string {
  if (!Number.isInteger(coordinate.row) || coordinate.row < 1) {
    throw new RangeError("列號必須是大於 0 的整數");
  }
  return `${columnNumberToLetters(coordinate.column)}${coordinate.row}`;
}

export function fromA1(address: string): CellCoordinate {
  const match = /^([A-Z]+)([1-9]\d*)$/iu.exec(address);
  if (!match) throw new RangeError(`無效的 A1 儲存格座標：${address}`);
  let column = 0;
  for (const character of match[1]!.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]), column };
}

export function rangeAt(
  ranges: readonly CellRange[],
  row: number,
  column: number,
): CellRange | undefined {
  return ranges.find(
    ({ start, end }) =>
      row >= start.row && row <= end.row && column >= start.column && column <= end.column,
  );
}

export function rangeContains(range: CellRange, row: number, column: number): boolean {
  return (
    row >= range.start.row &&
    row <= range.end.row &&
    column >= range.start.column &&
    column <= range.end.column
  );
}

export function topLeftOfRange(range: CellRange): CellCoordinate {
  return range.start;
}

export function getCellValue(sheet: GridSheet, row: number, column: number): CellValue {
  if (row < 1 || column < 1) return null;
  return sheet.rows[row - 1]?.[column - 1] ?? null;
}

export function hasContent(value: CellValue): boolean {
  return value !== null && value !== "" && !(typeof value === "string" && value.trim() === "");
}
