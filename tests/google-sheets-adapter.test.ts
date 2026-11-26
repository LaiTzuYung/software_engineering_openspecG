import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { toA1 } from "../src/guided-notes/coordinates.ts";
import {
  convertGoogleGridRange,
  createGoogleSheetsReader,
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV,
  GoogleSheetsImportError,
  GoogleSheetsReader,
  GoogleSheetsWriter,
  parseSpreadsheetUrl,
  type GoogleSheetsApiClient,
} from "../src/guided-notes/google-sheets-adapter.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import { readXlsxFile } from "../src/guided-notes/xlsx-adapter.ts";

const spreadsheetUrl = "https://docs.google.com/spreadsheets/d/spreadsheet_123/edit";
const serviceEmail = "guided-notes-reader@example.test";

function makeApi(options: {
  sheets?: readonly Record<string, unknown>[];
  values?: readonly (readonly unknown[])[];
  metadataError?: unknown;
  valueError?: unknown;
  batchUpdateError?: unknown;
  onBatchUpdate?: (request: {
    spreadsheetId: string;
    requestBody: {
      valueInputOption: "RAW";
      data: readonly { range: string; values: readonly (readonly (string | number | boolean | null)[])[] }[];
    };
  }) => void;
  onValuesRequest?: (request: {
    spreadsheetId: string;
    range: string;
    valueRenderOption: string;
    dateTimeRenderOption: string;
  }) => void;
} = {}): GoogleSheetsApiClient {
  return {
    spreadsheets: {
      get: async () => {
        if (options.metadataError !== undefined) throw options.metadataError;
        return { data: { sheets: options.sheets ?? [{ properties: { sheetId: 0, title: "學習單", index: 0 } }] } };
      },
      values: {
        get: async (request) => {
          options.onValuesRequest?.(request);
          if (options.valueError !== undefined) throw options.valueError;
          return { data: { values: options.values ?? [] } };
        },
        batchUpdate: async (request) => {
          options.onBatchUpdate?.(request);
          if (options.batchUpdateError !== undefined) throw options.batchUpdateError;
          return { data: { totalUpdatedCells: request.requestBody.data.reduce((sum, range) => sum + range.values.flat().length, 0) } };
        },
      },
    },
  };
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/guided-notes/${name}`, import.meta.url));
}

test("解析試算表網址的 spreadsheet ID 與 query/fragment gid", () => {
  assert.deepEqual(parseSpreadsheetUrl(spreadsheetUrl), { spreadsheetId: "spreadsheet_123" });
  assert.deepEqual(parseSpreadsheetUrl(`${spreadsheetUrl}?gid=42`), {
    spreadsheetId: "spreadsheet_123",
    gid: 42,
  });
  assert.deepEqual(parseSpreadsheetUrl(`${spreadsheetUrl}#gid=43`), {
    spreadsheetId: "spreadsheet_123",
    gid: 43,
  });
  assert.throws(
    () => parseSpreadsheetUrl("https://example.test/spreadsheets/d/not-google"),
    (error: unknown) => error instanceof GoogleSheetsImportError && error.code === "invalid-url",
  );
});

test("無效格式的 gid 回報找不到工作表而非網址無效", () => {
  assert.throws(
    () => parseSpreadsheetUrl(`${spreadsheetUrl}?gid=abc`),
    (error: unknown) =>
      error instanceof GoogleSheetsImportError &&
      error.code === "sheet-not-found" &&
      error.message.includes("找不到工作表（gid）"),
  );
});

test("Google GridRange 0 起算、結束不含轉為 1 起算且結束包含，支援多字母欄", () => {
  const range = convertGoogleGridRange({
    sheetId: 7,
    startRowIndex: 1,
    endRowIndex: 3,
    startColumnIndex: 26,
    endColumnIndex: 28,
  });
  assert.equal(toA1(range.start), "AA2");
  assert.equal(toA1(range.end), "AB3");
});

test("Google GridRange 可表示單格合併", () => {
  const range = convertGoogleGridRange({
    startRowIndex: 4,
    endRowIndex: 5,
    startColumnIndex: 26,
    endColumnIndex: 27,
  });
  assert.equal(toA1(range.start), "AA5");
  assert.equal(toA1(range.end), "AA5");
});

test("未帶 gid 時選 metadata 中 index 最小的工作表，並以 UNFORMATTED_VALUE 讀值", async () => {
  let requestSeen: {
    spreadsheetId: string;
    range: string;
    valueRenderOption: string;
    dateTimeRenderOption: string;
  } | undefined;
  const reader = new GoogleSheetsReader(
    makeApi({
      sheets: [
        { properties: { sheetId: 12, title: "第二張", index: 1 } },
        { properties: { sheetId: 2, title: "第一張", index: 0 } },
      ],
      values: [["題號", "作答"], [1, null]],
      onValuesRequest: (request) => { requestSeen = request; },
    }),
    serviceEmail,
  );
  const grid = await reader.read(spreadsheetUrl);
  assert.equal(grid.name, "第一張");
  assert.equal(grid.rows[1]?.[0], 1);
  assert.deepEqual(requestSeen, {
    spreadsheetId: "spreadsheet_123",
    range: "'第一張'",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
});

test("readWithSource 回傳 spreadsheet ID 與實際選取工作表 gid", async () => {
  const reader = new GoogleSheetsReader(
    makeApi({
      sheets: [
        { properties: { sheetId: 12, title: "第二張", index: 1 } },
        { properties: { sheetId: 2, title: "第一張", index: 0 } },
      ],
    }),
    serviceEmail,
  );

  const defaultSheet = await reader.readWithSource(spreadsheetUrl);
  assert.equal(defaultSheet.sheet.name, "第一張");
  assert.deepEqual(defaultSheet.source, { spreadsheetId: "spreadsheet_123", gid: 2 });

  const selectedSheet = await reader.readWithSource(`${spreadsheetUrl}?gid=12`);
  assert.equal(selectedSheet.sheet.name, "第二張");
  assert.deepEqual(selectedSheet.source, { spreadsheetId: "spreadsheet_123", gid: 12 });
});

test("GoogleSheetsWriter 只透過注入的 API client 發送一次 RAW 批次寫入", async () => {
  let observedRequest: {
    spreadsheetId: string;
    requestBody: {
      valueInputOption: "RAW";
      data: readonly { range: string; values: readonly (readonly (string | number | boolean | null)[])[] }[];
    };
  } | undefined;
  const api = makeApi({ onBatchUpdate: (request) => { observedRequest = request; } });
  const writer = new GoogleSheetsWriter(api);
  const data = [
    { range: "'學習單'!D3", values: [["答案"]] },
    { range: "'學習單'!D4", values: [["第二小題"]] },
  ];

  assert.equal(await writer.writeRawValues("spreadsheet_123", data), 2);
  assert.deepEqual(observedRequest, {
    spreadsheetId: "spreadsheet_123",
    requestBody: { valueInputOption: "RAW", data },
  });
});

test("帶 gid 時讀取指定工作表，不存在時不呼叫 values API", async () => {
  let valueCalls = 0;
  const reader = new GoogleSheetsReader(
    makeApi({
      sheets: [
        { properties: { sheetId: 10, title: "第一張", index: 0 } },
        { properties: { sheetId: 42, title: "指定表", index: 1 } },
      ],
      values: [["指定內容"]],
      onValuesRequest: () => { valueCalls += 1; },
    }),
    serviceEmail,
  );
  assert.equal((await reader.read(`${spreadsheetUrl}?gid=42`)).name, "指定表");
  assert.equal(valueCalls, 1);

  const missingReader = new GoogleSheetsReader(
    makeApi({
      sheets: [{ properties: { sheetId: 10, title: "第一張", index: 0 } }],
      onValuesRequest: () => { valueCalls += 1; },
    }),
    serviceEmail,
  );
  await assert.rejects(
    missingReader.read(`${spreadsheetUrl}?gid=99`),
    (error: unknown) => error instanceof GoogleSheetsImportError && error.code === "sheet-not-found",
  );
  assert.equal(valueCalls, 1);
});

test("Google 數值題號 1 與 XLSX 數值 1.0 經解析後同為整數 1", async () => {
  let renderOption = "";
  const googleGrid = await new GoogleSheetsReader(
    makeApi({
      values: [["題號", "作答"], [1, null]],
      onValuesRequest: ({ valueRenderOption }) => { renderOption = valueRenderOption; },
    }),
    serviceEmail,
  ).read(spreadsheetUrl);
  const xlsx = await readXlsxFile(fixture("T1-single.xlsx"));
  const googleNumber = parseGuidedNotes(googleGrid).questions[0]?.number;
  const xlsxNumber = parseGuidedNotes(xlsx.sheets[0]!).questions[0]?.number;
  assert.equal(renderOption, "UNFORMATTED_VALUE");
  assert.equal(typeof xlsx.sheets[0]?.rows[4]?.[1], "number");
  assert.equal(googleNumber, 1);
  assert.equal(xlsxNumber, 1);
  assert.equal(googleNumber, xlsxNumber);
});

test("合併子格值清空、保留合併範圍及左上角值", async () => {
  const grid = await new GoogleSheetsReader(
    makeApi({
      sheets: [{
        properties: { sheetId: 5, title: "工作表", index: 0 },
        merges: [{
          sheetId: 5,
          startRowIndex: 0,
          endRowIndex: 2,
          startColumnIndex: 26,
          endColumnIndex: 28,
        }],
      }],
      values: Array.from({ length: 2 }, (_, row) =>
        Array.from({ length: 28 }, (_, column) => (row === 0 && column === 26 ? "主值" : "重複值")),
      ),
    }),
    serviceEmail,
  ).read(spreadsheetUrl);
  assert.equal(grid.rows[0]?.[26], "主值");
  assert.equal(grid.rows[0]?.[27], null);
  assert.equal(grid.rows[1]?.[26], null);
  assert.deepEqual(grid.mergedRanges.map(({ start, end }) => [toA1(start), toA1(end)]), [["AA1", "AB2"]]);
});

test("權限錯誤從憑證 client_email 取得服務帳號 email", async () => {
  const reader = new GoogleSheetsReader(
    makeApi({ metadataError: { response: { status: 403 } } }),
    serviceEmail,
  );
  await assert.rejects(
    reader.read(spreadsheetUrl),
    (error: unknown) =>
      error instanceof GoogleSheetsImportError &&
      error.code === "permission-denied" &&
      error.message.includes(serviceEmail),
  );
});

test("建立 reader 僅以環境變數中的檔案路徑初始化 GoogleAuth，並讀取 client_email 欄位", async () => {
  let authOptions: { keyFile: string; scopes: readonly string[] } | undefined;
  const api = makeApi();
  const reader = await createGoogleSheetsReader(
    { [GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV]: "../outside/service-account.json" },
    {
      createAuth: (options) => {
        authOptions = options;
        return {
          getCredentials: async () => ({ client_email: serviceEmail }),
          getClient: async () => ({ authClient: true }),
        };
      },
      createApiClient: (authClient) => {
        assert.deepEqual(authClient, { authClient: true });
        return api;
      },
    },
  );
  assert.ok(reader instanceof GoogleSheetsReader);
  assert.equal(authOptions?.keyFile, "../outside/service-account.json");
  assert.deepEqual(authOptions?.scopes, ["https://www.googleapis.com/auth/spreadsheets"]);
});

test("缺少憑證檔路徑環境變數時回報設定錯誤", async () => {
  await assert.rejects(
    createGoogleSheetsReader({}, { createAuth: () => assert.fail("不應建立 auth") }),
    (error: unknown) => error instanceof GoogleSheetsImportError && error.code === "credential-config",
  );
});
