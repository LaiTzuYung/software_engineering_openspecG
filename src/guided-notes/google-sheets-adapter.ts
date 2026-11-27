import { google } from "googleapis";
import type { CellRange, CellValue, GridSheet } from "./model.ts";
import type { GoogleSpreadsheetSource } from "./import-service.ts";

export const GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV = "GOOGLE_SERVICE_ACCOUNT_KEY_FILE";
const SHEETS_READ_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleSheetsImportErrorCode =
  | "invalid-url"
  | "sheet-not-found"
  | "permission-denied"
  | "credential-config"
  | "api-error";

export class GoogleSheetsImportError extends Error {
  readonly code: GoogleSheetsImportErrorCode;

  constructor(
    code: GoogleSheetsImportErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "GoogleSheetsImportError";
  }
}

export interface ParsedSpreadsheetUrl {
  readonly spreadsheetId: string;
  readonly gid?: number;
}

export interface GoogleGridRange {
  readonly sheetId?: number;
  readonly startRowIndex?: number;
  readonly endRowIndex?: number;
  readonly startColumnIndex?: number;
  readonly endColumnIndex?: number;
}

interface GoogleSheetProperties {
  readonly sheetId?: number;
  readonly title?: string;
  readonly index?: number;
}

interface GoogleSheetMetadata {
  readonly properties?: GoogleSheetProperties;
  readonly merges?: readonly GoogleGridRange[];
}

interface GoogleSpreadsheetMetadata {
  readonly sheets?: readonly GoogleSheetMetadata[];
}

export interface GoogleSheetsApiClient {
  readonly spreadsheets: {
    get(options: {
      readonly spreadsheetId: string;
      readonly fields: string;
    }): Promise<{ readonly data: GoogleSpreadsheetMetadata }>;
    readonly values: {
      get(options: {
        readonly spreadsheetId: string;
        readonly range: string;
        readonly valueRenderOption: "UNFORMATTED_VALUE";
        readonly dateTimeRenderOption: "SERIAL_NUMBER";
      }): Promise<{ readonly data: { readonly values?: readonly (readonly unknown[])[] } }>;
      batchUpdate(options: {
        readonly spreadsheetId: string;
        readonly requestBody: {
          readonly valueInputOption: "RAW";
          readonly data: readonly GoogleSheetsValueRange[];
        };
      }): Promise<{ readonly data?: { readonly totalUpdatedCells?: number } }>;
    };
  };
}

export interface GoogleSheetsValueRange {
  readonly range: string;
  readonly values: readonly (readonly CellValue[])[];
}

interface GoogleAuthLike {
  getCredentials(): Promise<{ readonly client_email?: string }>;
  getClient(): Promise<unknown>;
}

export interface GoogleSheetsAuthOptions {
  readonly keyFile: string;
  readonly scopes: readonly string[];
}

export interface GoogleSheetsReaderFactories {
  readonly createAuth?: (options: GoogleSheetsAuthOptions) => GoogleAuthLike;
  readonly createApiClient?: (authClient: unknown) => GoogleSheetsApiClient;
}

/** Sends a single RAW values batch through an injected Sheets API client. */
export class GoogleSheetsWriter {
  private readonly api: GoogleSheetsApiClient;
  private readonly serviceAccountEmail: string;

  constructor(api: GoogleSheetsApiClient, serviceAccountEmail = "未知服務帳戶") {
    this.api = api;
    this.serviceAccountEmail = serviceAccountEmail;
  }

  async writeRawValues(
    spreadsheetId: string,
    data: readonly GoogleSheetsValueRange[],
  ): Promise<number> {
    try {
      const result = await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data },
      });
      return result.data?.totalUpdatedCells ?? 0;
    } catch (error) {
      throw mapApiWriteError(error, this.serviceAccountEmail);
    }
  }
}

export interface GoogleSheetsReadResult {
  readonly sheet: GridSheet;
  readonly source: GoogleSpreadsheetSource;
}

function invalidUrl(message = "網址無效：請輸入 Google 試算表網址。"): GoogleSheetsImportError {
  return new GoogleSheetsImportError("invalid-url", message);
}

export function parseSpreadsheetUrl(input: string): ParsedSpreadsheetUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidUrl();
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "docs.google.com") {
    throw invalidUrl();
  }
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(url.pathname);
  if (!match) throw invalidUrl();

  const gidValue = url.searchParams.get("gid") ?? /(?:^|[&#])gid=([^&]+)/u.exec(url.hash)?.[1];
  if (gidValue === undefined || gidValue === null) return { spreadsheetId: match[1]! };
  if (!/^\d+$/u.test(gidValue)) {
    throw new GoogleSheetsImportError("sheet-not-found", "找不到工作表（gid）：網址中的 gid 格式無效。");
  }
  const gid = Number(gidValue);
  if (!Number.isSafeInteger(gid)) {
    throw new GoogleSheetsImportError("sheet-not-found", "找不到工作表（gid）：網址中的 gid 格式無效。");
  }
  return { spreadsheetId: match[1]!, gid };
}

export function convertGoogleGridRange(range: GoogleGridRange): CellRange {
  const { startRowIndex, endRowIndex, startColumnIndex, endColumnIndex } = range;
  if (
    endRowIndex === undefined ||
    endColumnIndex === undefined ||
    (startRowIndex !== undefined && startRowIndex < 0) ||
    (startColumnIndex !== undefined && startColumnIndex < 0) ||
    endRowIndex <= (startRowIndex ?? 0) ||
    endColumnIndex <= (startColumnIndex ?? 0)
  ) {
    throw new RangeError("Google API 合併範圍缺少有效的結束列或欄索引。");
  }

  return {
    start: {
      row: (startRowIndex ?? 0) + 1,
      column: (startColumnIndex ?? 0) + 1,
    },
    // Google's exclusive zero-based end index is the one-based inclusive last index.
    end: { row: endRowIndex, column: endColumnIndex },
  };
}

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/gu, "''")}'`;
}

function mapCellValue(value: unknown): CellValue {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new TypeError("Google Sheets API 回傳了不支援的儲存格值型別。");
}

function cellIsMergeSlave(row: number, column: number, range: CellRange): boolean {
  const inRange =
    row >= range.start.row && row <= range.end.row &&
    column >= range.start.column && column <= range.end.column;
  return inRange && (row !== range.start.row || column !== range.start.column);
}

function valuesToGrid(
  title: string,
  values: readonly (readonly unknown[])[],
  merges: readonly CellRange[],
): GridSheet {
  const rowCount = Math.max(values.length, ...merges.map(({ end }) => end.row), 0);
  const columnCount = Math.max(...values.map((row) => row.length), ...merges.map(({ end }) => end.column), 0);
  const rows: CellValue[][] = [];

  for (let row = 1; row <= rowCount; row += 1) {
    const rawRow = values[row - 1] ?? [];
    const cells: CellValue[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      if (merges.some((merge) => cellIsMergeSlave(row, column, merge))) {
        cells.push(null);
      } else {
        cells.push(mapCellValue(rawRow[column - 1]));
      }
    }
    rows.push(cells);
  }

  return { name: title, rows, mergedRanges: merges };
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined;
  const response = error.response;
  if (typeof response !== "object" || response === null || !("status" in response)) return undefined;
  return typeof response.status === "number" ? response.status : undefined;
}

function mapApiError(error: unknown, serviceAccountEmail: string): GoogleSheetsImportError {
  if (responseStatus(error) === 403) {
    return new GoogleSheetsImportError(
      "permission-denied",
      `無法讀取試算表（檢視權限不足）：請將試算表共用給服務帳戶 ${serviceAccountEmail}，並至少設為「檢視者」。`,
    );
  }
  return new GoogleSheetsImportError("api-error", "Google Sheets API 讀取失敗，請確認網址與試算表狀態後重試。");
}

export class GoogleSheetsWriteError extends Error {
  readonly code: "permission-denied" | "api-error";

  constructor(code: "permission-denied" | "api-error", message: string) {
    super(message);
    this.code = code;
    this.name = "GoogleSheetsWriteError";
  }
}

function mapApiWriteError(error: unknown, serviceAccountEmail: string): GoogleSheetsWriteError {
  if (responseStatus(error) === 403) {
    return new GoogleSheetsWriteError(
      "permission-denied",
      `無法寫入試算表（編輯權限不足）：請將試算表共用給服務帳戶 ${serviceAccountEmail}，並將其設為「編輯者」。`,
    );
  }
  return new GoogleSheetsWriteError("api-error", "Google Sheets API 寫入失敗，請檢查試算表後重試。");
}

export class GoogleSheetsReader {
  private readonly api: GoogleSheetsApiClient;
  private readonly serviceAccountEmail: string;

  constructor(api: GoogleSheetsApiClient, serviceAccountEmail: string) {
    this.api = api;
    this.serviceAccountEmail = serviceAccountEmail;
  }

  async read(url: string): Promise<GridSheet> {
    return (await this.readWithSource(url)).sheet;
  }

  async readWithSource(url: string): Promise<GoogleSheetsReadResult> {
    const { spreadsheetId, gid } = parseSpreadsheetUrl(url);
    let metadata: GoogleSpreadsheetMetadata;
    try {
      ({ data: metadata } = await this.api.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title,index),merges)",
      }));
    } catch (error) {
      throw mapApiError(error, this.serviceAccountEmail);
    }

    const sheets = metadata.sheets ?? [];
    const selectedSheet = gid === undefined
      ? [...sheets].sort((left, right) => (left.properties?.index ?? 0) - (right.properties?.index ?? 0))[0]
      : sheets.find(({ properties }) => properties?.sheetId === gid);
    const title = selectedSheet?.properties?.title;
    if (selectedSheet === undefined || title === undefined || title.length === 0) {
      throw new GoogleSheetsImportError("sheet-not-found", "找不到工作表（gid）：試算表中沒有該工作表。");
    }

    let rawValues: readonly (readonly unknown[])[];
    try {
      const result = await this.api.spreadsheets.values.get({
        spreadsheetId,
        range: quoteSheetTitle(title),
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      rawValues = result.data.values ?? [];
    } catch (error) {
      throw mapApiError(error, this.serviceAccountEmail);
    }

    const sheetId = selectedSheet.properties?.sheetId;
    const merges = (selectedSheet.merges ?? [])
      .filter((range) => range.sheetId === undefined || range.sheetId === sheetId)
      .map(convertGoogleGridRange);
    return {
      sheet: valuesToGrid(title, rawValues, merges),
      source: { spreadsheetId, gid: sheetId! },
    };
  }
}

function defaultAuthFactory(options: GoogleSheetsAuthOptions): GoogleAuthLike {
  return new google.auth.GoogleAuth({
    keyFile: options.keyFile,
    scopes: [...options.scopes],
  }) as unknown as GoogleAuthLike;
}

function defaultApiFactory(authClient: unknown): GoogleSheetsApiClient {
  return google.sheets({ version: "v4", auth: authClient as never }) as unknown as GoogleSheetsApiClient;
}

/** Creates an authenticated reader using only the credential file path from the environment. */
export async function createGoogleSheetsReader(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  factories: GoogleSheetsReaderFactories = {},
): Promise<GoogleSheetsReader> {
  const keyFile = environment[GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV];
  if (keyFile === undefined || keyFile.trim().length === 0) {
    throw new GoogleSheetsImportError(
      "credential-config",
      `缺少環境變數 ${GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV}（服務帳號憑證檔案路徑）。`,
    );
  }

  let credentials: { readonly client_email?: string };
  let authClient: unknown;
  try {
    const auth = (factories.createAuth ?? defaultAuthFactory)({
      keyFile,
      scopes: [SHEETS_READ_WRITE_SCOPE],
    });
    [credentials, authClient] = await Promise.all([auth.getCredentials(), auth.getClient()]);
  } catch {
    throw new GoogleSheetsImportError(
      "credential-config",
      `無法使用 ${GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV} 指定的服務帳號憑證檔案。`,
    );
  }

  const serviceAccountEmail = credentials.client_email;
  if (serviceAccountEmail === undefined || serviceAccountEmail.trim().length === 0) {
    throw new GoogleSheetsImportError(
      "credential-config",
      "服務帳號憑證檔缺少有效的 client_email 欄位。",
    );
  }

  return new GoogleSheetsReader(
    (factories.createApiClient ?? defaultApiFactory)(authClient),
    serviceAccountEmail,
  );
}

export async function createGoogleSheetsWriter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  factories: GoogleSheetsReaderFactories = {},
): Promise<GoogleSheetsWriter> {
  const keyFile = environment[GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV];
  if (keyFile === undefined || keyFile.trim().length === 0) {
    throw new GoogleSheetsImportError(
      "credential-config",
      `缺少環境變數 ${GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV}（服務帳戶憑證檔案路徑）。`,
    );
  }

  let credentials: { readonly client_email?: string };
  let authClient: unknown;
  try {
    const auth = (factories.createAuth ?? defaultAuthFactory)({
      keyFile,
      scopes: [SHEETS_READ_WRITE_SCOPE],
    });
    [credentials, authClient] = await Promise.all([auth.getCredentials(), auth.getClient()]);
  } catch {
    throw new GoogleSheetsImportError(
      "credential-config",
      `無法使用 ${GOOGLE_SERVICE_ACCOUNT_KEY_FILE_ENV} 指定的服務帳戶憑證檔案。`,
    );
  }
  const serviceAccountEmail = credentials.client_email;
  if (serviceAccountEmail === undefined || serviceAccountEmail.trim().length === 0) {
    throw new GoogleSheetsImportError("credential-config", "服務帳戶憑證檔缺少有效的 client_email 欄位。");
  }
  return new GoogleSheetsWriter(
    (factories.createApiClient ?? defaultApiFactory)(authClient),
    serviceAccountEmail,
  );
}

