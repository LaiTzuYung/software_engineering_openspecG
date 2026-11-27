import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPreviewFromInput } from "../src/cli.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import { GuidedNotesImportService } from "../src/guided-notes/import-service.ts";
import type { GridSheet, ParseResult } from "../src/guided-notes/model.ts";
import { GoogleSheetsImportError } from "../src/guided-notes/google-sheets-adapter.ts";

const grid: GridSheet = {
  name: "離線測試表",
  rows: [
    ["題號", "題目", "作答", null],
    [1, "說明文字", "（1）", "既有內容"],
    [null, null, null, null],
    [2, "另一題", null, null],
  ],
  mergedRanges: [{ start: { row: 1, column: 3 }, end: { row: 1, column: 4 } }],
};

async function withTemporaryDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-notes-import-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("來源無關預覽包含題數、題型、標籤／作答格位置及警告", () => {
  const preview = new GuidedNotesImportService().preview(parseGuidedNotes(grid));
  assert.equal(preview.totalQuestionCount, 2);
  assert.equal(preview.singleQuestionCount, 2);
  assert.equal(preview.groupQuestionCount, 0);
  assert.equal(preview.questions[0]?.subquestions[0]?.labelCell?.address, "C2");
  assert.equal(preview.questions[0]?.subquestions[0]?.answerCell.address, "D2");
  assert.equal(preview.warnings.length, 1);
  assert.equal(preview.warnings[0]?.cell.address, "D2");
});

test("未確認時只有記憶體預覽且沒有 JSON 檔；確認後記憶體與 JSON 完全一致", async () => {
  await withTemporaryDirectory(async (directory) => {
    const service = new GuidedNotesImportService(directory);
    const preview = service.preview(parseGuidedNotes(grid));

    assert.deepEqual(service.getCreatedQuestionSet(preview.id), undefined);
    assert.deepEqual(await readdir(directory), []);

    const created = await service.confirm(preview.id);
    const persisted = await service.readPersistedQuestionSet(preview.id);
    assert.deepEqual(created, preview);
    assert.deepEqual(service.getCreatedQuestionSet(preview.id), persisted);
    assert.deepEqual(persisted, preview);
    assert.deepEqual(await readdir(directory), [`${preview.id}.json`]);
  });
});

test("Google 匯入預覽與確認後的題目集保留 spreadsheet ID 和 gid", async () => {
  await withTemporaryDirectory(async (directory) => {
    const service = new GuidedNotesImportService(directory);
    const result = await createPreviewFromInput(
      "https://docs.google.com/spreadsheets/d/mock-id/edit",
      {
        service,
        readSpreadsheetWithSource: async () => ({
          sheet: grid,
          source: { spreadsheetId: "mock-id", gid: 37 },
        }),
      },
    );

    assert.deepEqual(result.preview.googleSource, { spreadsheetId: "mock-id", gid: 37 });
    const created = await result.service.confirm(result.preview.id);
    assert.deepEqual(created.googleSource, { spreadsheetId: "mock-id", gid: 37 });
    assert.deepEqual((await result.service.readPersistedQuestionSet(result.preview.id)).googleSource, {
      spreadsheetId: "mock-id",
      gid: 37,
    });
  });
});

test("XLSX 匯入預覽不帶 Google 試算表來源", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fixture = fileURLToPath(new URL("./fixtures/guided-notes/T2-group.xlsx", import.meta.url));
    const service = new GuidedNotesImportService(directory);
    const { preview } = await createPreviewFromInput(fixture, { service });
    assert.equal(preview.googleSource, undefined);
    assert.equal(preview.importSource, "xlsx");
    assert.equal((await service.confirm(preview.id)).googleSource, undefined);
  });
});

test("無效或已確認的預覽 ID 不會再建立額外題目集", async () => {
  await withTemporaryDirectory(async (directory) => {
    const service = new GuidedNotesImportService(directory);
    await assert.rejects(service.confirm("missing"), /找不到待確認的匯入預覽/u);
    const preview = service.preview(parseGuidedNotes(grid));
    await service.confirm(preview.id);
    await service.confirm(preview.id);
    assert.deepEqual(await readdir(directory), [`${preview.id}.json`]);
  });
});

test("CLI 共用匯入路徑遇四種錯誤時不建立預覽或 JSON", async () => {
  const noHeader: GridSheet = { name: "錯誤表", rows: [["其他"], [1]], mergedRanges: [] };
  const duplicateNumber: GridSheet = {
    name: "錯誤表",
    rows: [["題號", "作答"], [3, null], [3, null]],
    mergedRanges: [],
  };
  const cases: readonly {
    name: string;
    input: string;
    readSpreadsheet?: (url: string) => Promise<GridSheet>;
  }[] = [
    { name: "無效網址", input: "https://example.test/not-a-sheet" },
    {
      name: "無權限",
      input: "https://docs.google.com/spreadsheets/d/mock-id/edit",
      readSpreadsheet: async () => {
        throw new GoogleSheetsImportError("permission-denied", "mock permission denied");
      },
    },
    {
      name: "找不到表頭",
      input: "https://docs.google.com/spreadsheets/d/mock-id/edit",
      readSpreadsheet: async () => noHeader,
    },
    {
      name: "題號重複",
      input: "https://docs.google.com/spreadsheets/d/mock-id/edit",
      readSpreadsheet: async () => duplicateNumber,
    },
  ];

  for (const scenario of cases) {
    await withTemporaryDirectory(async (directory) => {
      class ObservedService extends GuidedNotesImportService {
        previewCalls = 0;

        override preview(result: ParseResult) {
          this.previewCalls += 1;
          return super.preview(result);
        }
      }
      const service = new ObservedService(directory);
      await assert.rejects(
        createPreviewFromInput(scenario.input, {
          service,
          ...(scenario.readSpreadsheet === undefined ? {} : { readSpreadsheet: scenario.readSpreadsheet }),
        }),
        (error: unknown) => error instanceof Error,
        scenario.name,
      );
      assert.equal(service.previewCalls, 0, `${scenario.name}: 不應建立預覽`);
      assert.deepEqual(await readdir(directory), [], `${scenario.name}: 不應寫入 JSON`);
    });
  }
});
