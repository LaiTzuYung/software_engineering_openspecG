import assert from "node:assert/strict";
import test from "node:test";
import { createImportPreview } from "../src/guided-notes/import-service.ts";
import type { GridSheet } from "../src/guided-notes/model.ts";
import {
  SpreadsheetExportPreviewService,
  SpreadsheetStructureMismatchError,
  validateGoogleQuestionSetStructure,
} from "../src/guided-notes/spreadsheet-export-validation.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";

function sheet(): GridSheet {
  return {
    name: "學習單",
    rows: [
      ["題號", "題目", "作答", null],
      [1, "單題", null, null],
      [2, "題組", "（1）", null],
      [null, null, "（2）", null],
    ],
    mergedRanges: [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
  };
}

function importedSet() {
  return {
    ...createImportPreview(parseGuidedNotes(sheet())),
    googleSource: { spreadsheetId: "mock-spreadsheet", gid: 42 },
  };
}

test("重新解析後題目新增、刪除或重複時以中文指出題號並拒絕比對", async () => {
  const questionSet = importedSet();
  const added: GridSheet = { ...sheet(), rows: [...sheet().rows, [3, "新增題", null, null]] };
  const deleted: GridSheet = { ...sheet(), rows: sheet().rows.slice(0, 2) };
  const duplicate: GridSheet = { ...sheet(), rows: [...sheet().rows, [2, "重複題", null, null]] };

  await assert.rejects(
    validateGoogleQuestionSetStructure(questionSet, async () => added),
    /新增第 3 題/u,
  );
  await assert.rejects(
    validateGoogleQuestionSetStructure(questionSet, async () => deleted),
    /第 2 題目前不存在/u,
  );
  await assert.rejects(
    validateGoogleQuestionSetStructure(questionSet, async () => duplicate),
    /重新解析試算表失敗：題號重複/u,
  );
});

test("作答格移動時錯誤明確列出題號、小題及前後座標", async () => {
  const changed: GridSheet = {
    name: "學習單",
    rows: [
      ["題號", "題目", "作答", null, null],
      [1, "單題", null, null, null],
      [2, "題組", "（1）", null, null],
      [null, null, "（2）", null, null],
    ],
    mergedRanges: [
      { start: { row: 1, column: 3 }, end: { row: 1, column: 5 } },
      { start: { row: 3, column: 3 }, end: { row: 3, column: 4 } },
      { start: { row: 4, column: 3 }, end: { row: 4, column: 4 } },
    ],
  };

  await assert.rejects(
    validateGoogleQuestionSetStructure(importedSet(), async () => changed),
    (error: unknown) => error instanceof SpreadsheetStructureMismatchError &&
      error.message.includes("第 2 題小題 1") &&
      error.message.includes("學習單!D3") &&
      error.message.includes("學習單!E3"),
  );
});

test("建立與確認快照使用服務端目標，確認會重讀並檢查預覽後的儲存格變更", async () => {
  let current = sheet();
  const urls: string[] = [];
  const service = new SpreadsheetExportPreviewService(async (url) => {
    urls.push(url);
    return current;
  });
  const preview = await service.create(importedSet(), [
    { questionNumber: 2, subquestionNumber: 1, answer: "第一答案" },
    { questionNumber: 2, subquestionNumber: 2, answer: "第二答案" },
  ]);
  assert.deepEqual(preview.targets.map(({ cell, status }) => [cell.address, status]), [
    ["D3", "將寫入"],
    ["D4", "將寫入"],
  ]);
  assert.match(urls[0]!, /mock-spreadsheet\/edit\?gid=42$/u);

  const tampered = structuredClone(preview) as unknown as {
    id: string;
    targets: { answer: string; cell: { address: string } }[];
  };
  tampered.targets[0]!.answer = "客戶端改寫";
  tampered.targets[0]!.cell.address = "Z99";
  const confirmed = await service.confirm(tampered.id);
  assert.deepEqual(confirmed.targets.map(({ cell, answer }) => [cell.address, answer]), [
    ["D3", "第一答案"],
    ["D4", "第二答案"],
  ]);
  await assert.rejects(service.confirm(preview.id), /找不到有效的回寫預覽/u);

  const stale = await service.create(importedSet(), [
    { questionNumber: 2, subquestionNumber: 1, answer: "第一答案" },
  ]);
  current = {
    ...current,
    rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "人工修改"] : row),
  };
  await assert.rejects(
    service.confirm(stale.id),
    (error: unknown) => error instanceof SpreadsheetStructureMismatchError &&
      error.message.includes("第 2 題小題 1") && error.message.includes("學習單!D3") &&
      error.message.includes("內容在預覽後已改變"),
  );
});

test("預覽建立時找不到題目集指定的小題會以中文中止", async () => {
  const service = new SpreadsheetExportPreviewService(async () => sheet());
  await assert.rejects(
    service.create(importedSet(), [{ questionNumber: 9, subquestionNumber: 1, answer: "答案" }]),
    /第 9 題小題 1 不存在/u,
  );
});

test("確認預覽時若試算表結構已新增題目，會要求重新預覽且不能重用舊快照", async () => {
  let current = sheet();
  const service = new SpreadsheetExportPreviewService(async () => current);
  const preview = await service.create(importedSet(), [
    { questionNumber: 2, subquestionNumber: 1, answer: "第一答案" },
  ]);
  current = { ...current, rows: [...current.rows, [3, "新增題", null, null]] };

  await assert.rejects(service.confirm(preview.id), /新增第 3 題/u);
  await assert.rejects(service.confirm(preview.id), /找不到有效的回寫預覽/u);
});
