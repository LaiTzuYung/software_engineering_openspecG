import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { parseGuidedNotes } from "./guided-notes/parser.ts";
import { readXlsxFile } from "./guided-notes/xlsx-adapter.ts";
import { createGoogleSheetsReader, parseSpreadsheetUrl } from "./guided-notes/google-sheets-adapter.ts";
import { GuidedNotesImportService } from "./guided-notes/import-service.ts";

export async function runImportCli(args: readonly string[]): Promise<void> {
  const input = args[0];
  if (input === undefined || args.length !== 1) {
    throw new Error("用法：npm run import -- <Google 試算表網址或 .xlsx 路徑>");
  }

  let result;
  if (/\.xlsx$/iu.test(input)) {
    const workbook = await readXlsxFile(input);
    const sheet = workbook.sheets[0];
    if (sheet === undefined) throw new Error("XLSX 檔案沒有工作表。");
    result = parseGuidedNotes(sheet);
  } else {
    parseSpreadsheetUrl(input);
    const grid = await (await createGoogleSheetsReader()).read(input);
    result = parseGuidedNotes(grid);
  }

  const service = new GuidedNotesImportService();
  const preview = service.preview(result);
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
