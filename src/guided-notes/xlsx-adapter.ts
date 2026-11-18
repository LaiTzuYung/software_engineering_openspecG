import ExcelJS from "exceljs";
import { fromA1 } from "./coordinates.ts";
import type { CellRange, CellValue, GridSheet, GridWorkbook } from "./model.ts";

function rangeFromExcelJs(address: string): CellRange {
  const [startAddress, endAddress = startAddress] = address.split(":");
  return { start: fromA1(startAddress!), end: fromA1(endAddress) };
}

function scalarCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "result" in value) {
    return scalarCellValue(value.result);
  }
  if (typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  throw new TypeError("XLSX 含有無法轉換成格狀資料的儲存格值。");
}

function sheetToGrid(worksheet: ExcelJS.Worksheet): GridSheet {
  const rowCount = worksheet.rowCount;
  const columnCount = worksheet.columnCount;
  const rows: CellValue[][] = [];

  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const values: CellValue[] = Array.from({ length: columnCount }, () => null);
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      const cell = worksheet.getCell(rowNumber, columnNumber);
      if (cell.isMerged && cell.master.address !== cell.address) continue;
      values[columnNumber - 1] = scalarCellValue(cell.value);
    }
    rows.push(values);
  }

  return {
    name: worksheet.name,
    rows,
    mergedRanges: worksheet.model.merges.map(rangeFromExcelJs),
  };
}

/** Reads an XLSX workbook into the source-neutral grid model used by the parser. */
export async function readXlsxFile(filePath: string): Promise<GridWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return { sheets: workbook.worksheets.map(sheetToGrid) };
}
