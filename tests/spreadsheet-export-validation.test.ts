import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImportPreview } from "../src/guided-notes/import-service.ts";
import type { GridSheet } from "../src/guided-notes/model.ts";
import type { GoogleSheetsValueRange } from "../src/guided-notes/google-sheets-adapter.ts";
import {
  SpreadsheetExportPreviewService,
  SpreadsheetExportWriteError,
  SpreadsheetStructureMismatchError,
  validateGoogleQuestionSetStructure,
} from "../src/guided-notes/spreadsheet-export-validation.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import { createActivityState, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import { successfulAnswersForExport } from "../src/live-buzzer/result-export.ts";

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

test("題組只寫標籤右側 answerCell；題目無成功組時不產生任何寫入目標", async () => {
  const activity = createActivityState(importedSet(), { activityCode: "1234" });
  assert.equal(transitionActivityStage(activity, "buzzing").ok, true);
  assert.equal(submitAnswers(activity, "group-1", 2, { 1: "第一小題", 2: "第二小題" }).accepted, true);
  const answers = successfulAnswersForExport(activity);
  assert.deepEqual(answers, [
    { questionNumber: 2, subquestionNumber: 1, answer: "第一小題" },
    { questionNumber: 2, subquestionNumber: 2, answer: "第二小題" },
  ]);

  const service = new SpreadsheetExportPreviewService(async () => sheet());
  const preview = await service.create(importedSet(), answers, "1234");
  const ranges: string[] = [];
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-target-test-"));
  try {
    await service.confirmAndWrite(preview.id, "1234", async (_spreadsheetId, data) => {
      ranges.push(...data.map(({ range }) => range));
      return data.length;
    }, backupDirectory);
    assert.deepEqual(ranges, ["'學習單'!D3", "'學習單'!D4"]);
    assert.equal(ranges.some((range) => /!B|!C/u.test(range)), false, "題目格及 C 欄 labelCell 不得寫入");
    assert.equal(ranges.some((range) => /!C2/u.test(range)), false, "沒有成功組的第 1 題不應寫入");
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("備份每次獨立保存來源、座標、時間、狀態與型別；還原只恢復相符格並忽略失敗備份", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-restore-test-"));
  let current: GridSheet = {
    ...sheet(),
    rows: sheet().rows.map((row, index) => index === 2 ? [...row.slice(0, 3), 12] : row),
  };
  const service = new SpreadsheetExportPreviewService(async () => current);
  try {
    const originalSet = importedSet();
    const firstPreview = await service.create(originalSet, [
      { questionNumber: 2, subquestionNumber: 1, answer: "saved-1" },
      { questionNumber: 2, subquestionNumber: 2, answer: "saved-2" },
    ], "1234");
    const first = await service.confirmAndWrite(firstPreview.id, "1234", async (_id, data) => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2
        ? [...row.slice(0, 3), data[0]!.values[0]![0] as string]
        : index === 3 ? [...row.slice(0, 3), data[1]!.values[0]![0] as string] : row) };
      return 2;
    }, backupDirectory);
    assert.ok(first.backupPath);
    const firstBackup = JSON.parse(await readFile(first.backupPath, "utf8")) as {
      createdAt: string; status: string; spreadsheetId: string; gid: number; targets: { address: string; originalValue: unknown; writtenValue: unknown }[];
    };
    assert.equal(firstBackup.status, "succeeded");
    assert.equal(firstBackup.spreadsheetId, "mock-spreadsheet");
    assert.equal(firstBackup.gid, 42);
    assert.match(firstBackup.createdAt, /^\d{4}-\d\d-\d\dT/u);
    assert.deepEqual(firstBackup.targets.map(({ address, originalValue, writtenValue }) => [address, originalValue, writtenValue]), [
      ["D3", 12, "saved-1"], ["D4", null, "saved-2"],
    ]);

    current = { ...current, rows: current.rows.map((row, index) => index === 2
      ? [...row.slice(0, 3), "saved-1"] : index === 3 ? [...row.slice(0, 3), "changed-after-write"] : row) };
    const failedPreview = await service.create(originalSet, [
      { questionNumber: 2, subquestionNumber: 1, answer: "failed-attempt" },
    ], "1234");
    await assert.rejects(service.confirmAndWrite(failedPreview.id, "1234", async () => {
      throw new Error("mock batch failure");
    }, backupDirectory), (error: unknown) => error instanceof SpreadsheetExportWriteError && error.backupPath !== first.backupPath);

    const files = await readdir(backupDirectory);
    assert.equal(files.length, 2, "each write attempt must have its own backup file");
    const statuses = await Promise.all(files.map(async (name) =>
      (JSON.parse(await readFile(path.join(backupDirectory, name), "utf8")) as { status: string }).status));
    assert.deepEqual(statuses.sort(), ["failed", "succeeded"]);
    const allBackupText = (await Promise.all(files.map((name) => readFile(path.join(backupDirectory, name), "utf8")))).join("\n");
    assert.doesNotMatch(allBackupText, /private_key|client_secret|service.account.credentials/iu);

    const restoreData: GoogleSheetsValueRange[][] = [];
    const result = await service.restoreLatest(originalSet, async () => current, async (_id, data) => {
      restoreData.push([...data]);
      return data.length;
    }, backupDirectory);
    assert.equal(result.backupPath, first.backupPath, "failed attempt must not replace latest successful backup");
    assert.deepEqual(result.restored, [{ address: "學習單!D3" }]);
    assert.deepEqual(result.skipped, [{
      address: "學習單!D4",
      reason: "目前內容與當次回寫值不同，為避免覆蓋後續修改而跳過。",
      currentValue: "changed-after-write",
      expectedValue: "saved-2",
    }]);
    assert.deepEqual(restoreData, [[{ range: "'學習單'!D3", values: [[12]] }]]);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("沒有成功回寫備份時回報明確結果且不呼叫寫入", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-empty-restore-"));
  try {
    const service = new SpreadsheetExportPreviewService(async () => sheet());
    let writeCalls = 0;
    const result = await service.restoreLatest(importedSet(), async () => sheet(), async () => { writeCalls += 1; return 1; }, backupDirectory);
    assert.deepEqual(result, { restored: [], skipped: [], message: "沒有可還原的成功回寫紀錄。" });
    assert.equal(writeCalls, 0);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});
