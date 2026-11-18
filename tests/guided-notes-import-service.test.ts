import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import { GuidedNotesImportService } from "../src/guided-notes/import-service.ts";
import type { GridSheet } from "../src/guided-notes/model.ts";

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
