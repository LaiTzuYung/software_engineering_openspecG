import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { toA1 } from "../src/guided-notes/coordinates.ts";
import { GuidedNotesParseError } from "../src/guided-notes/model.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import { readXlsxFile } from "../src/guided-notes/xlsx-adapter.ts";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/guided-notes/${name}`, import.meta.url));
}

async function parseFixture(name: string) {
  const workbook = await readXlsxFile(fixture(name));
  assert.equal(workbook.sheets.length, 1);
  return { workbook, result: parseGuidedNotes(workbook.sheets[0]!) };
}

function answerCells(question: { subquestions: readonly { answerCell: { row: number; column: number } }[] }): string[] {
  return question.subquestions.map(({ answerCell }) => toA1(answerCell));
}

test("ExcelJS 合併範圍轉成一基、起訖包含的內部座標，只有左上角保留值", async () => {
  const workbook = await readXlsxFile(fixture("T1-single.xlsx"));
  const sheet = workbook.sheets[0]!;
  assert.equal(sheet.name, "學習單");
  assert.equal(sheet.rows[3]?.[6], "作答");
  assert.equal(sheet.rows[3]?.[7], null);
  assert.ok(
    sheet.mergedRanges.some(
      ({ start, end }) =>
        start.row === 4 && start.column === 7 && end.row === 4 && end.column === 8,
    ),
  );
});

test("T1-single fixture 預期 6 題單題及作答格", async () => {
  const { result } = await parseFixture("T1-single.xlsx");
  assert.equal(result.questions.length, 6);
  assert.deepEqual(result.questions.map(({ type }) => type), Array(6).fill("single"));
  assert.deepEqual(result.questions.map((question) => answerCells(question)[0]), [
    "G5", "G7", "G9", "G11", "G13", "G15",
  ]);
});

test("T2-group fixture 預期兩題組及兩單題", async () => {
  const { result } = await parseFixture("T2-group.xlsx");
  assert.equal(result.questions.length, 4);
  assert.deepEqual(result.questions.map(({ type }) => type), ["group", "group", "single", "single"]);
  assert.deepEqual(result.questions.slice(0, 2).map(answerCells), [["H5", "H6"], ["H8", "H9"]]);
  assert.deepEqual(result.questions.slice(2).map((question) => answerCells(question)[0]), ["G11", "G13"]);
});

test("T3-shifted fixture 預期位移後題組與單題位置", async () => {
  const { result } = await parseFixture("T3-shifted.xlsx");
  assert.equal(result.questions.length, 4);
  assert.deepEqual(result.questions.slice(0, 2).map(answerCells), [["I3", "I4"], ["I6", "I7"]]);
  assert.deepEqual(result.questions.slice(2).map((question) => answerCells(question)[0]), ["H9", "H11"]);
});

test("T4-large fixture 預期 12 題、15 格與題號正規化", async () => {
  const { result } = await parseFixture("T4-large.xlsx");
  assert.equal(result.questions.length, 12);
  assert.deepEqual(result.questions.map(({ number }) => number), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(result.questions.map(answerCells), [
    ["G5"], ["G6"], ["H7", "H8", "H9"], ["G10"], ["G11"], ["H12", "H13"],
    ["G14"], ["G15"], ["G16"], ["G17"], ["G18"], ["G19"],
  ]);
  assert.equal(result.questions.flatMap(({ subquestions }) => subquestions).length, 15);
});

test("T5 缺少表頭 fixture 顯示找不到表頭", async () => {
  const workbook = await readXlsxFile(fixture("T5-errors-no-header.xlsx"));
  assert.throws(
    () => parseGuidedNotes(workbook.sheets[0]!),
    (error: unknown) => error instanceof GuidedNotesParseError && error.code === "header-not-found",
  );
});

test("T5 重複題號 fixture 顯示第 3 題重複於 B9 與 B11", async () => {
  const workbook = await readXlsxFile(fixture("T5-errors-duplicate.xlsx"));
  assert.throws(
    () => parseGuidedNotes(workbook.sheets[0]!),
    (error: unknown) =>
      error instanceof GuidedNotesParseError &&
      error.code === "question-number-duplicate" &&
      /3: 學習單!B9、學習單!B11/u.test(error.message),
  );
});
