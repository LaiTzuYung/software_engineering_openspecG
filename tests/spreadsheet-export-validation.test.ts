import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { readXlsxFile } from "../src/guided-notes/xlsx-adapter.ts";

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

test("標記預覽保留原文並替換答案；確認寫 RAW 完整值且備份可還原標記原文", async () => {
  let current: GridSheet = { name: "學習單", rows: [["題號", "題目", "作答"], [1, "題幹", "答：{{答}}"]], mergedRanges: [] };
  const imported = {
    ...createImportPreview(parseGuidedNotes(current), { spreadsheetId: "marker-sheet", gid: 9 }, "google"),
  };
  const service = new SpreadsheetExportPreviewService(async () => current);
  const preview = await service.create(imported, [{ questionNumber: 1, subquestionNumber: 1, answer: "D3" }], "marker");
  assert.equal(preview.locatingMethod, "定位方式：{{答}} 標記");
  assert.equal(preview.targets[0]?.currentValue, "答：{{答}}");
  assert.equal(preview.targets[0]?.answer, "答：D3");
  const directory = await mkdtemp(path.join(os.tmpdir(), "marker-writeback-"));
  try {
    let write: readonly GoogleSheetsValueRange[] = [];
    const result = await service.confirmAndWrite(preview.id, "marker", async (_id, data) => {
      write = data;
      current = { ...current, rows: [["題號", "題目", "作答"], [1, "題幹", "答：D3"]] };
      return data.length;
    }, directory);
    assert.deepEqual(write, [{ range: "'學習單'!C2", values: [["答：D3"]] }]);
    const backup = JSON.parse(await readFile(result.backupPath!, "utf8")) as { targets: { originalValue: unknown; writtenValue: unknown }[] };
    assert.deepEqual(backup.targets.map(({ originalValue, writtenValue }) => [originalValue, writtenValue]), [["答：{{答}}", "答：D3"]]);
    const repeatedPreview = await service.create(imported, [{ questionNumber: 1, subquestionNumber: 1, answer: "D3" }]);
    assert.deepEqual(repeatedPreview.targets.map(({ currentValue, answer, status }) => [currentValue, answer, status]), [["答：D3", "答：D3", "內容相同略過"]]);
    const writes: GoogleSheetsValueRange[] = [];
    const restorePreview = await service.createRestorePreview(imported, "marker", directory);
    const restored = await service.confirmRestore(restorePreview.id, "marker", async () => current, async (_id, data) => { writes.push(...data); current = { ...current, rows: [["題號", "題目", "作答"], [1, "題幹", data[0]!.values[0]![0] as string]] }; return 1; }, directory);
    assert.deepEqual(restored.restored, [{ address: "學習單!C2" }]);
    assert.deepEqual(writes, [{ range: "'學習單'!C2", values: [["答：{{答}}"]] }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("標記已替換時只在題目與作答座標仍符合匯入快照時容許 Q11 重定位", async () => {
  const marked: GridSheet = { name: "學習單", rows: [["題號", "題目", "作答", null], [1, "題幹", "{{答}}", null]], mergedRanges: [] };
  const imported = { ...createImportPreview(parseGuidedNotes(marked), { spreadsheetId: "marker-sheet", gid: 9 }, "google") };
  let current = marked;
  const good = new SpreadsheetExportPreviewService(async () => current);
  const first = await good.create(imported, [{ questionNumber: 1, subquestionNumber: 1, answer: "D3" }], "q11");
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "q11-write-"));
  try {
    await good.confirmAndWrite(first.id, "q11", async (_id, data) => {
      current = { ...marked, rows: [["題號", "題目", "作答", null], [1, "題幹", data[0]!.values[0]![0] as string, null]] };
      return 1;
    }, backupDirectory);
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
  const repeated = await good.create(imported, [{ questionNumber: 1, subquestionNumber: 1, answer: "D3" }]);
  assert.equal(repeated.targets[0]?.status, "內容相同略過");
  const changedAnswer = await good.create(imported, [{ questionNumber: 1, subquestionNumber: 1, answer: "E4" }]);
  assert.deepEqual(changedAnswer.targets.map(({ currentValue, answer, status }) => [currentValue, answer, status]), [["D3", "E4", "將寫入"]]);

  const moved: GridSheet = { name: "學習單", rows: [["題號", "題目", "作答", null], [null, null, null, null], [1, "題幹", null, "D3"]], mergedRanges: [] };
  await assert.rejects(new SpreadsheetExportPreviewService(async () => moved).create(imported, [
    { questionNumber: 1, subquestionNumber: 1, answer: "E4" },
  ]), /第 1 題.*題號格.*A2.*請先還原再回寫/u);
  const changedNumber: GridSheet = { ...marked, rows: [["題號", "題目", "作答", null], [2, "題幹", "D3", null]] };
  await assert.rejects(new SpreadsheetExportPreviewService(async () => changedNumber).create(imported, [
    { questionNumber: 1, subquestionNumber: 1, answer: "E4" },
  ]), /第 1 題題號格不同.*A2/u);
  const contextualMarked: GridSheet = { ...marked, rows: [["題號", "題目", "作答", null], [1, "題幹", "答：{{答}}!", null]] };
  const contextualImport = { ...createImportPreview(parseGuidedNotes(contextualMarked), { spreadsheetId: "marker-sheet", gid: 9 }, "google") };
  const changedAnswerCell: GridSheet = { ...contextualMarked, rows: [["題號", "題目", "作答", null], [1, "題幹", "人工修改", null]] };
  await assert.rejects(new SpreadsheetExportPreviewService(async () => changedAnswerCell).create(contextualImport, [
    { questionNumber: 1, subquestionNumber: 1, answer: "E4" },
  ]), /第 1 題小題 1.*作答格.*C2.*不同/u);
});

test("T6 的 G11 前綴變體預覽原文與保留前綴的完整預計值", async () => {
  const workbook = await readXlsxFile(fileURLToPath(new URL("./fixtures/guided-notes/T6-marker.xlsx", import.meta.url)));
  const fixtureSheet = workbook.sheets[0]!;
  let current: GridSheet = { ...fixtureSheet, rows: fixtureSheet.rows.map((row, index) => index === 10 ? row.map((value, column) => column === 6 ? "答：{{答}}" : value) : row) };
  const questionSet = { ...createImportPreview(parseGuidedNotes(current), { spreadsheetId: "T6", gid: 1 }, "google") };
  const service = new SpreadsheetExportPreviewService(async () => current);
  const preview = await service.create(questionSet, [{ questionNumber: 3, subquestionNumber: 1, answer: "D3" }], "prefix");
  assert.deepEqual(preview.targets.map(({ cell, currentValue, answer }) => [cell.address, currentValue, answer]), [["G11", "答：{{答}}", "答：D3"]]);
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "t6-prefix-write-"));
  try {
    await service.confirmAndWrite(preview.id, "prefix", async (_id, data) => {
      current = { ...current, rows: current.rows.map((row, index) => index === 10 ? row.map((value, column) => column === 6 ? data[0]!.values[0]![0] as string : value) : row) };
      return 1;
    }, backupDirectory);
    const repeated = await service.create(questionSet, [{ questionNumber: 3, subquestionNumber: 1, answer: "D3" }]);
    assert.equal(repeated.targets[0]?.status, "內容相同略過");
    const changedAnswer = await service.create(questionSet, [{ questionNumber: 3, subquestionNumber: 1, answer: "E4" }]);
    assert.deepEqual(changedAnswer.targets.map(({ currentValue, answer, status }) => [currentValue, answer, status]), [["答：D3", "答：E4", "將寫入"]]);
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
});

test("非標記題目集仍使用原表頭重解析及答案定位", async () => {
  const questionSet = importedSet();
  const preview = await new SpreadsheetExportPreviewService(async () => sheet()).create(questionSet, [
    { questionNumber: 2, subquestionNumber: 1, answer: "A" },
  ]);
  assert.equal(preview.locatingMethod, "定位方式：表頭");
  assert.equal(preview.targets[0]?.cell.address, "D3");
  assert.equal(preview.targets[0]?.answer, "A");
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

test("均分上限 2-15 範例的回寫預覽與確認共用遞補組答案", async () => {
  const activity = createActivityState(importedSet(), {
    activityCode: "1234",
    rankingRule: "cap",
    groupNames: ["第 1 組", "第 2 組"],
  });
  transitionActivityStage(activity, "buzzing");
  submitAnswers(activity, "group-1", 2, { 1: "第 1 組題組答案一", 2: "第 1 組題組答案二" });
  submitAnswers(activity, "group-1", 1, { 1: "第 1 組被跳過答案" });
  submitAnswers(activity, "group-2", 1, { 1: "第 2 組遞補答案" });
  const answers = successfulAnswersForExport(activity);
  assert.deepEqual(answers, [
    { questionNumber: 1, subquestionNumber: 1, answer: "第 2 組遞補答案" },
    { questionNumber: 2, subquestionNumber: 1, answer: "第 1 組題組答案一" },
    { questionNumber: 2, subquestionNumber: 2, answer: "第 1 組題組答案二" },
  ]);

  const service = new SpreadsheetExportPreviewService(async () => sheet());
  const preview = await service.create(importedSet(), answers, "1234");
  assert.deepEqual(preview.targets.map(({ cell, answer }) => [cell.address, answer]), [
    ["C2", "第 2 組遞補答案"],
    ["D3", "第 1 組題組答案一"],
    ["D4", "第 1 組題組答案二"],
  ]);
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "cap-writeback-test-"));
  try {
    const written: string[] = [];
    await service.confirmAndWrite(preview.id, "1234", async (_id, ranges) => {
      written.push(...ranges.map(({ values }) => String(values[0]?.[0] ?? "")));
      return ranges.length;
    }, backupDirectory);
    assert.deepEqual(written, answers.map(({ answer }) => answer));
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("備份每次獨立保存來源、座標、時間、狀態與型別；確認還原含手動修改格並忽略失敗備份", async () => {
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
    const restorePreview = await service.createRestorePreview(originalSet, "1234", backupDirectory);
    const result = await service.confirmRestore(restorePreview.id, "1234", async () => current, async (_id, data) => {
      restoreData.push([...data]);
      for (const item of data) {
        const rowIndex = item.range.includes("D3") ? 2 : 3;
        current = { ...current, rows: current.rows.map((row, index) => index === rowIndex
          ? [...row.slice(0, 3), item.values[0]![0] as string | number | boolean | null]
          : row) };
      }
      return data.length;
    }, backupDirectory);
    assert.deepEqual(result.restored, [{ address: "學習單!D3" }, { address: "學習單!D4" }]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(restoreData, [[
      { range: "'學習單'!D3", values: [[12]] },
      { range: "'學習單'!D4", values: [[""]] },
    ]]);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("沒有成功回寫備份時回報明確結果且不呼叫寫入", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-empty-restore-"));
  try {
    const service = new SpreadsheetExportPreviewService(async () => sheet());
    let writeCalls = 0;
    const result = await service.createRestorePreview(importedSet(), "no-backup", backupDirectory);
    assert.deepEqual(result.targets, []);
    assert.equal(result.message, "沒有可還原的成功回寫紀錄。");
    assert.equal(writeCalls, 0);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("空白原值還原時以空字串寫入並重新讀取確認已清空", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-blank-restore-"));
  let current: GridSheet = { ...sheet(), rows: sheet().rows.map((row, index) => index === 2 ? [...row.slice(0, 3), null] : row) };
  const service = new SpreadsheetExportPreviewService(async () => current);
  try {
    const preview = await service.create(importedSet(), [
      { questionNumber: 2, subquestionNumber: 1, answer: "must-clear" },
    ], "blank-restore");
    const written = await service.confirmAndWrite(preview.id, "blank-restore", async (_id, data) => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "must-clear"] : row) };
      return data.length;
    }, backupDirectory);
    assert.ok(written.backupPath);

    let restoreRequest: readonly GoogleSheetsValueRange[] | undefined;
    let readCount = 0;
    const restorePreview = await service.createRestorePreview(importedSet(), "blank-restore", backupDirectory);
    const result = await service.confirmRestore(restorePreview.id, "blank-restore", async () => {
      readCount += 1;
      return current;
    }, async (_id, data) => {
      restoreRequest = data;
      current = { ...current, rows: current.rows.map((row, index) => index === 2
        ? [...row.slice(0, 3), data[0]!.values[0]![0] as string]
        : row) };
      return 1;
    }, backupDirectory);
    assert.deepEqual(restoreRequest, [{ range: "'學習單'!D3", values: [[""]] }]);
    assert.equal(restoreRequest!.some(({ values }) => values.flat().some((value) => value === null)), false);
    assert.equal(readCount, 2, "confirmation rereads before write and once after write for verification");
    assert.deepEqual(result.restored, [{ address: "學習單!D3" }]);
    assert.deepEqual(result.failed, []);
    assert.equal(current.rows[2]?.[3], "");
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("還原後重新讀取仍不等於原值時列為失敗而非已還原", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "export-restore-mismatch-"));
  let current: GridSheet = { ...sheet(), rows: sheet().rows.map((row, index) => index === 2 ? [...row.slice(0, 3), null] : row) };
  const service = new SpreadsheetExportPreviewService(async () => current);
  try {
    const preview = await service.create(importedSet(), [
      { questionNumber: 2, subquestionNumber: 1, answer: "must-restore" },
    ], "restore-mismatch");
    await service.confirmAndWrite(preview.id, "restore-mismatch", async () => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "must-restore"] : row) };
      return 1;
    }, backupDirectory);
    const restorePreview = await service.createRestorePreview(importedSet(), "restore-mismatch", backupDirectory);
    const result = await service.confirmRestore(restorePreview.id, "restore-mismatch", async () => current, async () => 1, backupDirectory);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.failed, [{
      address: "學習單!D3",
      reason: "還原後重新讀取的內容與備份原值不同。",
      actualValue: "must-restore",
      expectedValue: null,
    }]);
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("同活動兩次回寫與新增格保留首次原值；重建服務後預覽並確認還原含手動修改格", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "restore-first-repeat-"));
  let current: GridSheet = { ...sheet(), rows: sheet().rows.map((row, index) => index === 2
    ? [...row.slice(0, 3), "D3 原值"] : index === 3 ? [...row.slice(0, 3), "D4 原值"] : row) };
  try {
    const questionSet = importedSet();
    const firstService = new SpreadsheetExportPreviewService(async () => current);
    const first = await firstService.create(questionSet, [{ questionNumber: 2, subquestionNumber: 1, answer: "第一次答案" }], "first-activity");
    await firstService.confirmAndWrite(first.id, "first-activity", async (_id, ranges) => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), String(ranges[0]!.values[0]![0])] : row) };
      return ranges.length;
    }, backupDirectory);
    const second = await firstService.create(questionSet, [
      { questionNumber: 2, subquestionNumber: 1, answer: "第二次答案" },
      { questionNumber: 2, subquestionNumber: 2, answer: "新增格答案" },
    ], "first-activity");
    await firstService.confirmAndWrite(second.id, "first-activity", async (_id, ranges) => {
      current = { ...current, rows: current.rows.map((row, index) => {
        const range = ranges.find((item) => item.range.endsWith(index === 2 ? "D3" : "D4"));
        return range === undefined ? row : [...row.slice(0, 3), String(range.values[0]![0])];
      }) };
      return ranges.length;
    }, backupDirectory);
    current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "老師手動修改"] : row) };

    const restartedService = new SpreadsheetExportPreviewService(async () => current);
    const preview = await restartedService.createRestorePreview(questionSet, "first-activity", backupDirectory);
    assert.deepEqual(preview.targets.map(({ cell, currentValue, originalValue, status }) => ({
      address: cell.address, currentValue, originalValue, status,
    })), [
      { address: "D3", currentValue: "老師手動修改", originalValue: "D3 原值", status: "已被手動修改" },
      { address: "D4", currentValue: "新增格答案", originalValue: "D4 原值", status: "將還原" },
    ]);

    const requests: GoogleSheetsValueRange[] = [];
    const result = await restartedService.confirmRestore(preview.id, "first-activity", async () => current, async (_id, ranges) => {
      requests.push(...ranges);
      current = { ...current, rows: current.rows.map((row, index) => {
        const range = ranges.find((item) => item.range.endsWith(index === 2 ? "D3" : "D4"));
        return range === undefined ? row : [...row.slice(0, 3), String(range.values[0]![0])];
      }) };
      return ranges.length;
    }, backupDirectory);
    assert.deepEqual(requests.map(({ range, values }) => [range, values]), [
      ["'學習單'!D3", [["D3 原值"]]], ["'學習單'!D4", [["D4 原值"]]],
    ]);
    assert.deepEqual(result.restored, [{ address: "學習單!D3" }, { address: "學習單!D4" }]);
    assert.deepEqual(result.failed, []);

    const third = await restartedService.create(questionSet, [{ questionNumber: 2, subquestionNumber: 1, answer: "還原後再次回寫" }], "first-activity");
    await restartedService.confirmAndWrite(third.id, "first-activity", async (_id, ranges) => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), String(ranges[0]!.values[0]![0])] : row) };
      return ranges.length;
    }, backupDirectory);
    const finalPreview = await restartedService.createRestorePreview(questionSet, "first-activity", backupDirectory);
    assert.equal(finalPreview.targets.find(({ cell }) => cell.address === "D3")!.originalValue, "D3 原值");
    assert.equal(finalPreview.targets.find(({ cell }) => cell.address === "D3")!.lastWrittenValue, "還原後再次回寫");
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
});

test("還原預覽後試算表任一格改變時整批中止且不呼叫寫入", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "restore-first-stale-"));
  let current: GridSheet = { ...sheet(), rows: sheet().rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "格子原值"] : row) };
  try {
    const service = new SpreadsheetExportPreviewService(async () => current);
    const exportPreview = await service.create(importedSet(), [{ questionNumber: 2, subquestionNumber: 1, answer: "系統答案" }], "stale-activity");
    await service.confirmAndWrite(exportPreview.id, "stale-activity", async () => {
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "系統答案"] : row) };
      return 1;
    }, backupDirectory);
    const restorePreview = await service.createRestorePreview(importedSet(), "stale-activity", backupDirectory);
    current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "預覽後修改"] : row) };
    let writes = 0;
    await assert.rejects(service.confirmRestore(restorePreview.id, "stale-activity", async () => current, async () => { writes += 1; return 1; }, backupDirectory), /重新產生還原預覽/u);
    assert.equal(writes, 0);
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
});

test("還原可讀 restore-first 前單次 JSON 備份並略過無效或缺欄位檔案", async () => {
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "restore-first-legacy-"));
  let current: GridSheet = { ...sheet(), rows: sheet().rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "舊版寫入值"] : row) };
  try {
    await writeFile(path.join(backupDirectory, "export-legacy.json"), JSON.stringify({
      id: "export-legacy", createdAt: "2026-01-01T00:00:00.000Z", status: "succeeded",
      spreadsheetId: "mock-spreadsheet", gid: 42, activityCode: "legacy-activity",
      targets: [{ questionNumber: 2, subquestionNumber: 1, sheetName: "學習單", address: "D3", originalValue: "舊版原值", writtenValue: "舊版寫入值" }],
    }));
    await writeFile(path.join(backupDirectory, "broken.json"), "{");
    await writeFile(path.join(backupDirectory, "missing-fields.json"), JSON.stringify({ status: "succeeded", targets: [] }));
    const service = new SpreadsheetExportPreviewService(async () => current);
    const preview = await service.createRestorePreview(importedSet(), "legacy-activity", backupDirectory);
    assert.equal(preview.targets.length, 1);
    assert.equal(preview.targets[0]!.originalValue, "舊版原值");
    const result = await service.confirmRestore(preview.id, "legacy-activity", async () => current, async (_id, ranges) => {
      assert.deepEqual(ranges[0]!.values, [["舊版原值"]]);
      current = { ...current, rows: current.rows.map((row, index) => index === 2 ? [...row.slice(0, 3), "舊版原值"] : row) };
      return 1;
    }, backupDirectory);
    assert.deepEqual(result.restored, [{ address: "學習單!D3" }]);
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
});

test("標記模式兩階段還原寫回包含 {{答}} 的首次原文", async () => {
  const markedSheet: GridSheet = { name: "學習單", rows: [["題號", "題目", "作答"], [1, "題幹", "答：{{答}}"]], mergedRanges: [] };
  const markedSet = { ...createImportPreview(parseGuidedNotes(markedSheet), { spreadsheetId: "marker-sheet", gid: 9 }, "google") };
  let current = markedSheet;
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "restore-first-marker-"));
  try {
    const service = new SpreadsheetExportPreviewService(async () => current);
    const exportPreview = await service.create(markedSet, [{ questionNumber: 1, subquestionNumber: 1, answer: "D3" }], "marker-activity");
    await service.confirmAndWrite(exportPreview.id, "marker-activity", async (_id, ranges) => {
      current = { ...markedSheet, rows: [["題號", "題目", "作答"], [1, "題幹", String(ranges[0]!.values[0]![0])]] };
      return 1;
    }, backupDirectory);
    const restorePreview = await service.createRestorePreview(markedSet, "marker-activity", backupDirectory);
    assert.equal(restorePreview.targets[0]!.originalValue, "答：{{答}}");
    const result = await service.confirmRestore(restorePreview.id, "marker-activity", async () => current, async (_id, ranges) => {
      assert.equal(ranges[0]!.values[0]![0], "答：{{答}}");
      current = { ...markedSheet, rows: [["題號", "題目", "作答"], [1, "題幹", "答：{{答}}"]] };
      return 1;
    }, backupDirectory);
    assert.deepEqual(result.restored, [{ address: "學習單!C2" }]);
  } finally { await rm(backupDirectory, { recursive: true, force: true }); }
});

test("Q7 無右側格時寫入沿用標籤格式，並可還原原標籤", async () => {
  for (const [label, expected] of [["（1）", "（1）答案"], ["(1)", "(1)答案"]] as const) {
    const q7Sheet: GridSheet = { name: "學習單", rows: [["題號", "題目", "作答"], [2, "小題", label]], mergedRanges: [] };
    const questionSet = { ...createImportPreview(parseGuidedNotes(q7Sheet), { spreadsheetId: "q7-sheet", gid: 11 }, "google") };
    const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "restore-first-q7-"));
    let current = q7Sheet;
    try {
      const service = new SpreadsheetExportPreviewService(async () => current);
      const exportPreview = await service.create(questionSet, [{ questionNumber: 2, subquestionNumber: 1, answer: "答案" }], "q7-activity");
      assert.equal(exportPreview.targets[0]!.cell.address, "C2");
      assert.equal(exportPreview.targets[0]!.answer, expected);
      await service.confirmAndWrite(exportPreview.id, "q7-activity", async (_id, ranges) => {
        current = { ...q7Sheet, rows: [["題號", "題目", "作答"], [2, "小題", String(ranges[0]!.values[0]![0])]] };
        return 1;
      }, backupDirectory);
      const secondExport = await service.create(questionSet, [{ questionNumber: 2, subquestionNumber: 1, answer: "第二答案" }], "q7-activity");
      assert.equal(secondExport.targets[0]!.answer, `${label}第二答案`);
      await service.confirmAndWrite(secondExport.id, "q7-activity", async (_id, ranges) => {
        current = { ...q7Sheet, rows: [["題號", "題目", "作答"], [2, "小題", String(ranges[0]!.values[0]![0])]] };
        return 1;
      }, backupDirectory);
      const restorePreview = await service.createRestorePreview(questionSet, "q7-activity", backupDirectory);
      assert.equal(restorePreview.targets[0]!.originalValue, label);
      const result = await service.confirmRestore(restorePreview.id, "q7-activity", async () => current, async (_id, ranges) => {
        assert.equal(ranges[0]!.values[0]![0], label);
        current = { ...q7Sheet, rows: [["題號", "題目", "作答"], [2, "小題", label]] };
        return 1;
      }, backupDirectory);
      assert.deepEqual(result.restored, [{ address: "學習單!C2" }]);
    } finally { await rm(backupDirectory, { recursive: true, force: true }); }
  }
});
