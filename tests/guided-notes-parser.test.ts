import assert from "node:assert/strict";
import test from "node:test";
import { columnNumberToLetters, rangeAt, toA1 } from "../src/guided-notes/coordinates.ts";
import { parseGuidedNotes, replaceAnswerMarkers } from "../src/guided-notes/parser.ts";
import { GuidedNotesParseError, type CellRange, type GridSheet } from "../src/guided-notes/model.ts";

function sheet(
  rows: GridSheet["rows"],
  mergedRanges: readonly CellRange[] = [],
  name = "工作表甲",
): GridSheet {
  return { name, rows, mergedRanges };
}

function errorFrom(action: () => unknown): GuidedNotesParseError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GuidedNotesParseError);
    return error;
  }
  assert.fail("預期解析失敗");
}

test("模型可表達工作表、稀疏儲存格值及合併範圍", () => {
  const grid = sheet(
    [[null, "題號", "作答"], [null, 1, null]],
    [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
  );

  assert.equal(grid.name, "工作表甲");
  assert.equal(grid.rows[1]?.[1], 1);
  assert.deepEqual(rangeAt(grid.mergedRanges, 1, 4), grid.mergedRanges[0]);
});

test("A1 座標支援多字母欄與合併格左上角定位", () => {
  assert.equal(columnNumberToLetters(1), "A");
  assert.equal(columnNumberToLetters(26), "Z");
  assert.equal(columnNumberToLetters(27), "AA");
  assert.equal(toA1({ row: 12, column: 28 }), "AB12");
  assert.throws(() => toA1({ row: 0, column: 1 }), RangeError);
});

test("動態定位位移且全半形不一致的表頭與作答合併範圍", () => {
  const grid = sheet(
    [
      ["標題"],
      [null, null, "題 號", "題　目", null, "作 答"],
      [null, null, 1, "說明", null, null, null, null],
    ],
    [{ start: { row: 2, column: 6 }, end: { row: 2, column: 8 } }],
  );

  const parsed = parseGuidedNotes(grid);
  assert.equal(parsed.headerRow, 2);
  assert.deepEqual(parsed.questions[0]?.numberCell, { sheetName: "工作表甲", row: 3, column: 3 });
  assert.deepEqual(parsed.questions[0]?.subquestions[0]?.answerCell, {
    sheetName: "工作表甲",
    row: 3,
    column: 6,
  });
});

test("表頭關鍵字可由呼叫端設定", () => {
  const parsed = parseGuidedNotes(sheet([["編號", "內容", "答案"] , [7, "題幹", null]]), {
    keywords: { question: ["編號"], description: ["內容"], answer: ["答案"] },
  });
  assert.equal(parsed.questions[0]?.number, 7);
  assert.equal(parsed.questions[0]?.description, "題幹");
});

test("合併作答格記錄合併範圍左上角", () => {
  const grid = sheet(
    [["題號", "作答", null], [1, null, null]],
    [
      { start: { row: 1, column: 2 }, end: { row: 1, column: 3 } },
      { start: { row: 2, column: 2 }, end: { row: 2, column: 3 } },
    ],
  );
  const parsed = parseGuidedNotes(grid);
  assert.deepEqual(parsed.questions[0]?.subquestions[0]?.answerCell, {
    sheetName: "工作表甲",
    row: 2,
    column: 2,
  });
});

test("題號正規化接受數值、半形、全形、Q 前綴及第 n 題格式", () => {
  const values: Array<number | string> = [1.0, "1", "1.", "１", "Q1", "第1題"];
  const normalized = values.map((value) =>
    parseGuidedNotes(sheet([["題號", "作答"], [value, null]])).questions[0]?.number,
  );
  assert.deepEqual(normalized, [1, 1, 1, 1, 1, 1]);
});

test("標籤編號來自標籤格，答案位置是其右方第一個空白格", () => {
  const grid = sheet(
    [["題號", "題目", "作答", null], [1, "題幹", "（3）", null]],
    [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
  );
  const parsed = parseGuidedNotes(grid);
  assert.deepEqual(parsed.questions[0]?.subquestions[0], {
    number: 3,
    answerCell: { sheetName: "工作表甲", row: 2, column: 4 },
    labelCell: { sheetName: "工作表甲", row: 2, column: 3 },
  });
});

test("題組小題沒有標籤時，依該題小題順序指派下一個編號", () => {
  const grid = sheet(
    [
      ["題號", "題目", "作答", null],
      [1, "小題一", "（1）", null],
      [null, "小題二", null, null],
    ],
    [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
  );
  const parsed = parseGuidedNotes(grid);
  assert.deepEqual(parsed.questions[0]?.subquestions.map(({ number }) => number), [1, 2]);
  assert.equal(parsed.questions[0]?.subquestions[1]?.labelCell, undefined);
});

test("同一題重複解析到相同作答格時保留一格並產生警告", () => {
  const grid = sheet(
    [
      ["題號", "題目", "作答", null],
      [1, "小題一", "（1）", null],
      [null, "小題二", "（2）", null],
    ],
    [
      { start: { row: 1, column: 3 }, end: { row: 1, column: 4 } },
      { start: { row: 2, column: 4 }, end: { row: 3, column: 4 } },
    ],
  );
  const parsed = parseGuidedNotes(grid);
  assert.equal(parsed.questions[0]?.subquestions.length, 1);
  assert.equal(parsed.warnings.some(({ code }) => code === "duplicate-answer-cell"), true);
});

test("標籤右側候選格已填時取第一格並警告；無右側格時退回標籤格", () => {
  const filled = parseGuidedNotes(
    sheet(
      [["題號", "題目", "作答", null], [1, "題幹", "（1）", "已有內容"]],
      [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
    ),
  );
  assert.equal(filled.warnings.length, 1);
  assert.deepEqual(filled.questions[0]?.subquestions[0]?.answerCell, {
    sheetName: "工作表甲",
    row: 2,
    column: 4,
  });

  const noRightSide = parseGuidedNotes(sheet([["題號", "作答"], [1, "（1）"]]));
  assert.deepEqual(noRightSide.questions[0]?.subquestions[0]?.answerCell, {
    sheetName: "工作表甲",
    row: 2,
    column: 2,
  });
});

test("上下合併的題號下方列延續同題，且空白列略過", () => {
  const grid = sheet(
    [
      ["題號", "題目", "作答", null],
      [1, "主題", "（1）", null],
      [null, null, null, null],
      [null, "小題二", "（2）", null],
    ],
    [
      { start: { row: 1, column: 3 }, end: { row: 1, column: 4 } },
      { start: { row: 2, column: 1 }, end: { row: 4, column: 1 } },
    ],
  );
  const parsed = parseGuidedNotes(grid);
  assert.equal(parsed.questions.length, 1);
  assert.deepEqual(parsed.questions[0]?.subquestions.map(({ number }) => number), [1, 2]);
  assert.equal(parsed.questions[0]?.type, "group");
});

test("一般重複題號失敗並列出該題號全部位置", () => {
  const error = errorFrom(() => parseGuidedNotes(sheet([["題號", "作答"], [2, null], [3, null], [2, null]])));
  assert.equal(error.code, "question-number-duplicate");
  assert.deepEqual(error.cells.map(({ row, column }) => [row, column]), [[2, 1], [4, 1]]);
  assert.match(error.message, /2: 工作表甲!A2、工作表甲!A4/u);
});

test("無效題號有有效題目可解析時警告略過，找不到表頭與零題仍失敗", () => {
  const parsed = parseGuidedNotes(sheet([["題號", "作答"], ["Q-?", null], [1, "答案"]]));
  assert.equal(parsed.warnings[0]?.code, "question-number-invalid");
  assert.deepEqual(parsed.warnings[0]?.cell, { sheetName: "工作表甲", row: 2, column: 1 });

  const missingHeader = errorFrom(() => parseGuidedNotes(sheet([["無關", "標題"]])));
  assert.equal(missingHeader.code, "header-not-found");

  const noQuestions = errorFrom(() => parseGuidedNotes(sheet([["題號", "作答"]])));
  assert.equal(noQuestions.code, "no-questions");
  assert.match(noQuestions.message, /沒有偵測到題目/u);
});

test("無效題號與其同題後續列略過並警告題號格位置", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "題目", "作答"],
    ["Q-?", "無效題敘述", "無效答案"],
    [null, "同題後續敘述", "同題後續答案"],
    [1, "有效題", "答案一"],
    [2, "下一題", "答案二"],
  ]));

  assert.deepEqual(parsed.questions.map(({ number }) => number), [1, 2]);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0]?.code, "question-number-invalid");
  assert.match(parsed.warnings[0]?.message ?? "", /題號無法解析/u);
  assert.deepEqual(parsed.warnings[0]?.cell, { sheetName: "工作表甲", row: 2, column: 1 });
});

test("第一個有效題號前的題目與作答內容略過並分別警告位置", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "題目", "作答"],
    [null, "前置說明", null],
    [null, null, "前置作答說明"],
    [1, "有效題", "答案"],
  ]));

  assert.deepEqual(parsed.questions.map(({ number }) => number), [1]);
  assert.equal(parsed.warnings.length, 2);
  assert.deepEqual(parsed.warnings.map(({ cell }) => [cell.row, cell.column]), [[2, 2], [3, 3]]);
  assert.match(parsed.warnings[0]?.message ?? "", /題號前.*略過/u);
  assert.match(parsed.warnings[1]?.message ?? "", /題號前.*略過/u);
});

test("同一格的題號與作答文字不構成表頭", () => {
  const error = errorFrom(() => parseGuidedNotes(sheet([
    ["題號與作答"],
    [1, "題幹", "答案"],
  ])));
  assert.equal(error.code, "header-not-found");
});

test("標籤接受全半形括號、括號內空白及標籤尾隨文字", () => {
  const parsed = parseGuidedNotes(sheet(
    [
      ["題號", "題目", "作答", null],
      [1, "半形標籤含空白", "( 1 )", null],
      [2, "半形標籤及尾字", "(1)答案", null],
    ],
    [
      { start: { row: 1, column: 3 }, end: { row: 1, column: 4 } },
    ],
  ));

  assert.deepEqual(parsed.questions.map(({ subquestions }) => subquestions[0]?.number), [1, 1]);
  assert.deepEqual(parsed.questions.map(({ subquestions }) => subquestions[0]?.labelCell?.column), [3, 3]);
  assert.deepEqual(parsed.questions.map(({ subquestions }) => subquestions[0]?.answerCell.column), [4, 4]);
});

test("題號缺號時警告缺少編號", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "作答"],
    [1, "A"],
    [2, "B"],
    [4, "D"],
  ]));

  assert.deepEqual(parsed.questions.map(({ number }) => number), [1, 2, 4]);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0]?.code, "question-number-gap");
  assert.equal(parsed.warnings[0]?.message, "題號缺號：3。");
});

test("題號順序打亂但沒有缺號時不警告", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "作答"],
    [3, "C"],
    [1, "A"],
    [2, "B"],
  ]));

  assert.deepEqual(parsed.questions.map(({ number }) => number), [3, 1, 2]);
  assert.equal(parsed.warnings.some(({ code }) => code === "question-number-gap"), false);
});

test("答案標記接受全形及含空白 token，並以標記格前綴小題標籤", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "題目", "作答", null, null],
    [1, "題組", "（1）", "答：{{ 答 }}", null],
    [null, "第二小題", "（2）", null, "｛｛答｝｝"],
  ], [{ start: { row: 1, column: 3 }, end: { row: 1, column: 5 } }]));
  assert.equal(parsed.mode, "marker");
  assert.deepEqual(parsed.questions[0]?.subquestions.map(({ number, answerCell }) => [number, answerCell.column]), [[1, 4], [2, 5]]);
  assert.equal(replaceAnswerMarkers("{{答}}", "D3"), "D3");
  assert.equal(replaceAnswerMarkers("答案 {{ 答 }}／｛｛答｝｝ 後", "D3"), "答案 D3／D3 後");
});

test("答案標記歸最近有效題號且同題依列欄排序，純標記不算已有內容", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "題目", "作答", null, null],
    [null, null, null, null, "{{答}}"],
    [2, "題幹", null, "{{答}}", "{{答}}"],
    [null, null, null, "{{答}}", null],
  ]));
  assert.deepEqual(parsed.questions[0]?.subquestions.map(({ answerCell }) => [answerCell.row, answerCell.column]), [[3, 4], [3, 5], [4, 4]]);
  assert.equal(parsed.warnings.some(({ code }) => code === "answer-cell-already-filled"), false);
  const preQuestion = parsed.warnings.find(({ code }) => code === "answer-marker-before-question");
  assert.deepEqual(preQuestion?.cell, { sheetName: "工作表甲", row: 2, column: 5 });
  assert.equal(parsed.questions[0]?.subquestions.some(({ answerCell }) => answerCell.row === 2), false);
});

test("標記模式對無效題號與缺少標記題目提供帶位置警告", () => {
  const parsed = parseGuidedNotes(sheet([
    ["題號", "題目", "作答", null],
    [1, "有標記題", "{{答}}", null],
    ["Q-?", "無效題", null, "{{答}}"],
    [3, "缺少標記題", null, null],
  ]));
  assert.deepEqual(parsed.warnings.map(({ code, cell }) => [code, cell.row, cell.column]), [
    ["question-number-invalid", 3, 1], ["answer-marker-unassigned", 3, 4], ["question-without-answer-marker", 4, 1],
  ]);
  assert.deepEqual(parsed.questions.map(({ number }) => number), [1, 3]);
});
