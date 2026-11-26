import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseGuidedNotes } from "./guided-notes/parser.ts";
import { readXlsxFile } from "./guided-notes/xlsx-adapter.ts";
import { createGoogleSheetsReader, parseSpreadsheetUrl } from "./guided-notes/google-sheets-adapter.ts";
import { GuidedNotesImportService } from "./guided-notes/import-service.ts";
import type { GoogleSpreadsheetSource } from "./guided-notes/import-service.ts";
import type { GridSheet } from "./guided-notes/model.ts";

export interface ImportPreviewDependencies {
  readonly readSpreadsheet?: (url: string) => Promise<GridSheet>;
  readonly readSpreadsheetWithSource?: (url: string) => Promise<{
    readonly sheet: GridSheet;
    readonly source: GoogleSpreadsheetSource;
  }>;
  readonly service?: GuidedNotesImportService;
}

/** Shared source-to-preview path used by the CLI and integration tests. */
export async function createPreviewFromInput(
  input: string,
  dependencies: ImportPreviewDependencies = {},
) {
  let result;
  let googleSource: GoogleSpreadsheetSource | undefined;
  if (/\.xlsx$/iu.test(input)) {
    const workbook = await readXlsxFile(input);
    const sheet = workbook.sheets[0];
    if (sheet === undefined) throw new Error("XLSX 檔案沒有工作表。");
    result = parseGuidedNotes(sheet);
  } else {
    const parsedUrl = parseSpreadsheetUrl(input);
    if (dependencies.readSpreadsheetWithSource !== undefined) {
      const readResult = await dependencies.readSpreadsheetWithSource(input);
      result = parseGuidedNotes(readResult.sheet);
      googleSource = readResult.source;
    } else if (dependencies.readSpreadsheet !== undefined) {
      const grid = await dependencies.readSpreadsheet(input);
      result = parseGuidedNotes(grid);
      if (parsedUrl.gid !== undefined) {
        googleSource = { spreadsheetId: parsedUrl.spreadsheetId, gid: parsedUrl.gid };
      }
    } else {
      const readResult = await (await createGoogleSheetsReader()).readWithSource(input);
      result = parseGuidedNotes(readResult.sheet);
      googleSource = readResult.source;
    }
  }

  const service = dependencies.service ?? new GuidedNotesImportService();
  const preview = service.preview(result, googleSource);
  return { preview, service };
}

export async function runImportCli(args: readonly string[]): Promise<void> {
  const input = args[0];
  if (input === undefined || args.length !== 1) {
    throw new Error("用法：npm run import -- <Google 試算表網址或 .xlsx 路徑>");
  }

  const { preview, service } = await createPreviewFromInput(input);
  stdout.write(`${JSON.stringify(preview, null, 2)}\n`);

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question("確認建立此題目集？(y/N) ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      stdout.write("已取消；未建立題目集。\n");
      return;
    }
    const created = await service.confirm(preview.id);
    stdout.write(`已建立題目集：data/guided-notes/${created.id}.json\n`);
  } finally {
    prompt.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runImportCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "匯入失敗。";
    console.error(message);
    process.exitCode = 1;
  });
}
