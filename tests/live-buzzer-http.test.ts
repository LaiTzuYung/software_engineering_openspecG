import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as createClient } from "socket.io-client";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import { createLiveBuzzerServer } from "../src/live-buzzer/http-server.ts";
import { GuidedNotesImportService } from "../src/guided-notes/import-service.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";
import type { GridSheet } from "../src/guided-notes/model.ts";
import { createImportPreview, type GuidedNotesQuestionSet as QuestionSet } from "../src/guided-notes/import-service.ts";
import { parseGuidedNotes } from "../src/guided-notes/parser.ts";
import type { GoogleSheetsValueRange } from "../src/guided-notes/google-sheets-adapter.ts";
import { GoogleSheetsWriteError } from "../src/guided-notes/google-sheets-adapter.ts";

const PIN = "test-teacher-pin";
const mockSheet: GridSheet = {
  name: "HTTP 匯入測試",
  rows: [["題號", "題目", "作答"], [1, "測試題目", "（1）"]],
  mergedRanges: [],
};

function fixtureSet(): GuidedNotesQuestionSet {
  return {
    id: "seed-set", createdAt: "2026-11-22T00:00:00.000Z", sheetName: "種子題目",
    totalQuestionCount: 1, singleQuestionCount: 1, groupQuestionCount: 0,
    questions: [{ number: 1, description: "HTTP 隔離題", type: "single", subquestions: [{ number: 1, answerCell: { sheetName: "種子題目", address: "C2", row: 2, column: 3 } }] }],
    warnings: [],
  };
}

async function withServer<T>(action: (baseUrl: string, directory: string, app: ReturnType<typeof createLiveBuzzerServer>) => Promise<T>, options: { readSpreadsheet?: () => Promise<GridSheet>; writeSpreadsheetValues?: (id: string, data: readonly GoogleSheetsValueRange[]) => Promise<number> } = {}): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-http-"));
  const questionDirectory = path.join(directory, "guided-notes");
  await mkdir(questionDirectory, { recursive: true });
  await writeFile(path.join(questionDirectory, "seed-set.json"), JSON.stringify(fixtureSet()));
  const app = createLiveBuzzerServer({
    teacherPin: PIN,
    dataDirectory: questionDirectory,
    importService: new GuidedNotesImportService(questionDirectory),
    readSpreadsheet: options.readSpreadsheet ?? (async () => mockSheet),
    ...(options.writeSpreadsheetValues === undefined ? {} : { writeSpreadsheetValues: options.writeSpreadsheetValues }),
    exportBackupDirectory: path.join(questionDirectory, "backups"),
    resolveStudentSession: (token) => token === "team-a-session"
      ? { activityCode: "2468", groupId: "group-1" }
      : token === "team-b-session" ? { activityCode: "2468", groupId: "group-2" } : undefined,
  });
  const baseUrl = await app.listen(0);
  try { return await action(baseUrl, questionDirectory, app); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}

const exportSheet: GridSheet = { name: "匯出測試", rows: [["題號", "題目", "作答"], [1, "匯出題", null]], mergedRanges: [] };
function exportSet(): QuestionSet {
  return { ...createImportPreview(parseGuidedNotes(exportSheet)), googleSource: { spreadsheetId: "spreadsheet-export", gid: 31 } };
}

async function makeEndedExportActivity(app: ReturnType<typeof createLiveBuzzerServer>, set = exportSet()) {
  const activity = app.manager.create(set, { activityCode: "2468" });
  activity.stage = "buzzing";
  assert.equal(submitAnswers(activity, "group-1", 1, { 1: "答案甲" }).accepted, true);
  app.manager.transition("ended");
  return activity;
}

test("回寫預覽 API 顯示 A1、目前值、預計值與中文狀態，並以 RAW 單次批次寫入且先存備份", async () => {
  let writes = 0;
  let backupDirectory = "";
  await withServer(async (base, directory, app) => {
    backupDirectory = path.join(directory, "backups");
    await makeEndedExportActivity(app);
    const previewResponse = await fetch(`${base}/api/teacher/export/preview`, { method: "POST", headers: teacherHeaders(), body: "{}" });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json() as { preview: { id: string; locatingMethod: string; targets: { cell: { address: string }; currentValue: unknown; answer: string; status: string }[] } }).preview;
    assert.equal(preview.locatingMethod, "定位方式：表頭");
    assert.deepEqual(preview.targets.map(({ cell, currentValue, answer, status }) => ({ address: cell.address, currentValue, answer, status })), [
      { address: "C2", currentValue: null, answer: "答案甲", status: "將寫入" },
    ]);
    const confirm = await fetch(`${base}/api/teacher/export/confirm`, { method: "POST", headers: teacherHeaders(), body: JSON.stringify({ previewId: preview.id, targets: [{ cell: { address: "Z99" }, answer: "偽造" }] }) });
    assert.equal(confirm.status, 200);
    assert.equal(writes, 1);
    const files = await readdir(path.join(directory, "backups"));
    assert.equal(files.length, 1);
    const backup = JSON.parse(await readFile(path.join(directory, "backups", files[0]!), "utf8")) as { status: string };
    assert.equal(backup.status, "succeeded");
  }, { readSpreadsheet: async () => exportSheet, writeSpreadsheetValues: async (spreadsheetId, data) => {
    writes += 1;
    assert.equal(spreadsheetId, "spreadsheet-export");
    assert.equal(data.length, 1);
    assert.deepEqual(data[0], { range: "'匯出測試'!C2", values: [["答案甲"]] });
    const files = await readdir(backupDirectory);
    assert.equal(files.length, 1);
    const backup = JSON.parse(await readFile(path.join(backupDirectory, files[0]!), "utf8")) as { status: string };
    assert.equal(backup.status, "pending", "batchUpdate must run only after the pending backup is persisted");
    return 1;
  } });
});

test("公開大螢幕頁與 HTTP 狀態端點只提供階段白名單", async () => {
  await withServer(async (base, _directory, app) => {
    const empty = await fetch(`${base}/api/screen/state`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { activity: null });
    const page = await fetch(`${base}/screen`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /大螢幕/);

    const activity = app.manager.create(fixtureSet(), { activityCode: "2468" });
    let view = (await (await fetch(`${base}/api/screen/state`)).json() as { activity: any }).activity;
    assert.equal(view.stage, "preparing");
    assert.equal(view.groupCount, 4);
    assert.equal(view.activityCode, "2468");

    activity.stage = "buzzing";
    assert.equal(submitAnswers(activity, "group-1", 1, { 1: "SCREEN-WINNER" }).accepted, true);
    assert.equal(submitAnswers(activity, "group-2", 1, { 1: "SCREEN-LOSER" }).accepted, true);
    view = (await (await fetch(`${base}/api/screen/state`)).json() as { activity: any }).activity;
    assert.equal(view.stage, "buzzing");
    const buzzing = JSON.stringify(view);
    for (const forbidden of ["SCREEN-WINNER", "SCREEN-LOSER", "group-1", "第 1 組", "originalRank", "finalRank", '"rank"', '"position"', '"finalPosition"', "successful", "answers", "sequence"]) {
      assert.equal(buzzing.includes(forbidden), false, `HTTP 搶答視圖不可包含 ${forbidden}`);
    }

    activity.stage = "ended";
    view = (await (await fetch(`${base}/api/screen/state`)).json() as { activity: any }).activity;
    assert.equal(view.stage, "ended");
    assert.equal(JSON.stringify(view).includes("SCREEN-WINNER"), true);
    assert.equal(JSON.stringify(view).includes("SCREEN-LOSER"), false);
  });
});

test("確認回寫遇到缺少編輯權限時回報中文錯誤並把先前備份標記失敗", async () => {
  await withServer(async (base, _directory, app) => {
    await makeEndedExportActivity(app);
    const preview = (await (await fetch(`${base}/api/teacher/export/preview`, { method: "POST", headers: teacherHeaders(), body: "{}" })).json() as { preview: { id: string } }).preview;
    const response = await fetch(`${base}/api/teacher/export/confirm`, { method: "POST", headers: teacherHeaders(), body: JSON.stringify({ previewId: preview.id }) });
    assert.equal(response.status, 400);
    const result = await response.json() as { error: string; backupPath: string };
    assert.match(result.error, /無法寫入試算表（編輯權限不足）/u);
    assert.match(result.error, /guided-notes-reader@example\.test/u);
    assert.match(result.error, /「編輯者」/u);
    const backup = JSON.parse(await readFile(result.backupPath, "utf8")) as { status: string };
    assert.equal(backup.status, "failed");
  }, { readSpreadsheet: async () => exportSheet, writeSpreadsheetValues: async () => {
    throw new GoogleSheetsWriteError("permission-denied", "無法寫入試算表（編輯權限不足）：請將試算表共用給服務帳戶 guided-notes-reader@example.test，並將其設為「編輯者」。");
  } });
});

test("回寫路由要求老師 PIN、活動結束、Google 來源與有效預覽 ID", async () => {
  let writes = 0;
  await withServer(async (base, _directory, app) => {
    const noPin = await fetch(`${base}/api/teacher/export/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noPin.status, 401);
    const active = app.manager.create(exportSet(), { activityCode: "2468" });
    const activePreview = await fetch(`${base}/api/teacher/export/preview`, { method: "POST", headers: teacherHeaders(), body: "{}" });
    assert.equal(activePreview.status, 409);
    active.stage = "ended";
    const invalid = await fetch(`${base}/api/teacher/export/confirm`, { method: "POST", headers: teacherHeaders(), body: JSON.stringify({ previewId: "not-valid" }) });
    assert.equal(invalid.status, 400);
    const xlsxSet = { ...exportSet(), googleSource: undefined } as unknown as QuestionSet;
    app.manager.create(xlsxSet, { activityCode: "1357" }).stage = "ended";
    const xlsx = await fetch(`${base}/api/teacher/export/preview`, { method: "POST", headers: teacherHeaders(), body: "{}" });
    assert.equal(xlsx.status, 409);
    assert.equal(writes, 0);
  }, { readSpreadsheet: async () => exportSheet, writeSpreadsheetValues: async () => { writes += 1; return 1; } });
});

test("還原最近一次成功回寫路由要求老師 PIN 與已結束活動，無紀錄時回報清楚結果", async () => {
  let writes = 0;
  await withServer(async (base, _directory, app) => {
    app.manager.create(exportSet(), { activityCode: "2468" }).stage = "buzzing";
    const unauthorized = await fetch(`${base}/api/teacher/export/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const active = await fetch(`${base}/api/teacher/export/restore`, { method: "POST", headers: teacherHeaders(), body: "{}" });
    assert.equal(active.status, 409);
    app.manager.getActive()!.stage = "ended";
    const restored = await fetch(`${base}/api/teacher/export/restore`, { method: "POST", headers: teacherHeaders(), body: "{}" });
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { restored: [], skipped: [], failed: [], message: "沒有可還原的成功回寫紀錄。" });
    assert.equal(writes, 0);
  }, { readSpreadsheet: async () => exportSheet, writeSpreadsheetValues: async () => { writes += 1; return 1; } });
});

test("CSV 下載要求老師 PIN 與已結束活動，XLSX 題目集可下載 ASCII 檔名", async () => {
  await withServer(async (base, _directory, app) => {
    const noPin = await fetch(`${base}/api/teacher/export/csv`);
    assert.equal(noPin.status, 401);
    const activity = app.manager.create(fixtureSet(), { activityCode: "2468" });
    activity.stage = "buzzing";
    const active = await fetch(`${base}/api/teacher/export/csv`, { headers: teacherHeaders() });
    assert.equal(active.status, 409);
    assert.equal(submitAnswers(activity, "group-1", 1, { 1: "XLSX 答案" }).accepted, true);
    activity.stage = "ended";
    const response = await fetch(`${base}/api/teacher/export/csv`, { headers: teacherHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="results-2468.csv"');
    const csv = Buffer.from(await response.arrayBuffer()).toString("utf8");
    assert.ok(csv.startsWith("\uFEFF題號,小題,組別,答案,原始順位,最終順位,是否成功,送出時間,說明\r\n"));
    assert.match(csv, /1,1,第 1 組,XLSX 答案,1,1,是,/u);
  });
});

test("老師題目集清單依匯入時間排序並回傳來源類型與時間，舊版資料仍相容", async () => {
  await withServer(async (base, directory) => {
    const xlsx = { ...fixtureSet(), id: "xlsx-set", createdAt: "2026-11-25T14:54:00.000Z", importSource: "xlsx" };
    const google = { ...fixtureSet(), id: "google-set", createdAt: "2026-11-27T10:25:00.000Z", googleSource: { spreadsheetId: "gid-id", gid: 5 }, importSource: "google" };
    await writeFile(path.join(directory, "xlsx-set.json"), JSON.stringify(xlsx));
    await writeFile(path.join(directory, "google-set.json"), JSON.stringify(google));
    const response = await fetch(`${base}/api/teacher/question-sets`, { headers: teacherHeaders() });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { items: { id: string; createdAt: string; source: string }[] }).items.map(({ id, createdAt, source }) => ({ id, createdAt, source })), [
      { id: "google-set", createdAt: "2026-11-27T10:25:00.000Z", source: "google" },
      { id: "xlsx-set", createdAt: "2026-11-25T14:54:00.000Z", source: "xlsx" },
      { id: "seed-set", createdAt: "2026-11-22T00:00:00.000Z", source: "legacy" },
    ]);
  });
});

function teacherHeaders(): HeadersInit { return { "x-teacher-pin": PIN, "content-type": "application/json" }; }

test("老師頁與老師 API 均需 PIN；學生 HTML 不含老師控制項或老師 API 程式碼", async () => {
  await withServer(async (base) => {
    const unauthorizedPage = await fetch(`${base}/teacher`);
    assert.equal(unauthorizedPage.status, 401);
    assert.equal(await unauthorizedPage.text(), JSON.stringify({ error: "unauthorized" }));
    const unauthorizedAction = await fetch(`${base}/api/teacher/start`, { method: "POST", body: "{}" });
    assert.equal(unauthorizedAction.status, 401);
    assert.equal((await unauthorizedAction.text()).includes("開始搶答"), false);

    const invalidLogin = await fetch(`${base}/api/teacher/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "wrong" }),
    });
    assert.equal(invalidLogin.status, 401);
    const login = await fetch(`${base}/api/teacher/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: PIN }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authorizedPage = await fetch(`${base}/teacher`, { headers: { cookie } });
    assert.equal(authorizedPage.status, 200);
    const teacherHtml = await authorizedPage.text();
    for (const match of teacherHtml.matchAll(/<script>([\s\S]*?)<\/script>/gu)) {
      assert.doesNotThrow(() => new Function(match[1]));
    }
    assert.match(teacherHtml, /建立活動/u);
    assert.match(teacherHtml, /開始搶答/u);
    assert.match(teacherHtml, /線上頁面：/u);
    assert.match(teacherHtml, /結束活動/u);
    assert.match(teacherHtml, /題目敘述/u);
    assert.match(teacherHtml, /\/api\/teacher\/import\/preview/u);
    assert.match(teacherHtml, /請輸入網址/u);
    assert.match(teacherHtml, /renderTable/u);
    assert.match(teacherHtml, /結果匯出/u);
    assert.match(teacherHtml, /回寫預覽/u);
    assert.match(teacherHtml, /確認回寫/u);
    assert.match(teacherHtml, /還原最近一次回寫/u);
    assert.match(teacherHtml, /下載 CSV/u);
    assert.match(teacherHtml, /活動資料只存在伺服器記憶體，重啟後消失/u);
    assert.match(teacherHtml, /題目集來源為 XLSX/u);
    assert.match(teacherHtml, /fetch\('\/api\/teacher\/export\/csv',\{headers:\{'x-teacher-pin'/u);
    assert.match(teacherHtml, /URL\.createObjectURL\(blob\)/u);
    assert.match(teacherHtml, /document\.querySelector\('#export-preview-button'\)\.disabled=!canWrite/u);
    assert.match(teacherHtml, /Asia\/Taipei/u);
    assert.match(teacherHtml, /Google 試算表/u);
    assert.match(teacherHtml, /舊版匯入（無來源資訊）/u);
    assert.match(teacherHtml, /此題目集匯入時未記錄試算表來源，請重新匯入 Google 試算表後再建立活動/u);
    assert.match(teacherHtml, /題目集來源為 XLSX，無法回寫或還原試算表/u);
    assert.match(teacherHtml, /select\.selectedIndex=0/u);
    assert.doesNotMatch(teacherHtml, /\/api\/teacher\/export\/csv\?[^'" ]*pin=/u);
    assert.doesNotMatch(teacherHtml, /view\.textContent=JSON\.stringify/u);

    const studentHtml = await (await fetch(`${base}/student`)).text();
    assert.doesNotMatch(studentHtml, /開始搶答|結束活動|組別設定|\/api\/teacher|teacher:get-full-view|teacher:start/u);
  });
});

test("npm server factory 在同一 HTTP server 提供頁面及 Socket.IO", async () => {
  await withServer(async (base) => {
    const socketScript = await fetch(`${base}/socket.io/socket.io.js`);
    assert.equal(socketScript.status, 200);
    assert.match(socketScript.headers.get("content-type") ?? "", /javascript/u);
    const socket = createClient(base, { transports: ["websocket"], reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      assert.equal(socket.connected, true);
    } finally {
      socket.disconnect();
    }
  });
});

test("老師頁 HTTP 流程可建立活動、開始／結束、切換題目敘述並檢視答案", async () => {
  await withServer(async (base, _directory, app) => {
    const list = await fetch(`${base}/api/teacher/question-sets`, { headers: teacherHeaders() });
    assert.deepEqual(await list.json(), { items: [{ id: "seed-set", sheetName: "種子題目", totalQuestionCount: 1, createdAt: "2026-11-22T00:00:00.000Z", source: "legacy" }] });
    const createdResponse = await fetch(`${base}/api/teacher/activity`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ questionSetId: "seed-set" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      activity: { activityCode: string; stage: string; groups: unknown[]; rankingRule: { name: string; explanation: string } };
    };
    assert.match(created.activity.activityCode, /^\d{4}$/u);
    assert.equal(created.activity.stage, "preparing");
    assert.deepEqual(created.activity.rankingRule, { name: "純速度", explanation: "" });
    assert.equal((created.activity as { canWriteSpreadsheet?: boolean }).canWriteSpreadsheet, false);
    assert.equal((created.activity as { questionSetSource?: string }).questionSetSource, "legacy");
    assert.equal(created.activity.groups.length, 4);

    assert.equal((await fetch(`${base}/api/teacher/start`, { method: "POST", headers: teacherHeaders(), body: "{}" })).status, 200);
    assert.equal((await fetch(`${base}/api/teacher/descriptions`, { method: "POST", headers: teacherHeaders(), body: JSON.stringify({ visible: true }) })).status, 200);
    const activity = (await (await fetch(`${base}/api/teacher/view`, { headers: teacherHeaders() })).json()) as { activity: { stage: string; questionDescriptionsVisible: boolean } };
    assert.equal(activity.activity.stage, "buzzing");
    assert.equal(activity.activity.questionDescriptionsVisible, true);
    const current = app.manager.getActive()!;
    assert.equal(submitAnswers(current, "group-1", 1, { 1: "Teacher-visible answer" }).accepted, true);
    const fullView = (await (await fetch(`${base}/api/teacher/view`, { headers: teacherHeaders() })).json()) as { activity: { questions: { groups: { answers: { answer: string }[] | null }[] }[] } };
    assert.equal(fullView.activity.questions[0]?.groups[0]?.answers?.[0]?.answer, "Teacher-visible answer");
    assert.equal((await fetch(`${base}/api/teacher/end`, { method: "POST", headers: teacherHeaders(), body: "{}" })).status, 200);
    const afterEnd = (await (await fetch(`${base}/api/teacher/view`, { headers: teacherHeaders() })).json()) as { activity: { stage: string } };
    assert.equal(afterEnd.activity.stage, "ended");
  });
});

test("HTTP 建立與更新排名規則，並在搶答開始或結束後拒絕更改", async () => {
  await withServer(async (base, _directory, app) => {
    const unauthorized = await fetch(`${base}/api/teacher/ranking-rule`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rankingRule: "cap" }),
    });
    assert.equal(unauthorized.status, 401);

    const createdResponse = await fetch(`${base}/api/teacher/activity`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ questionSetId: "seed-set", rankingRule: "cap" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { activity: { rankingRule: { name: string; explanation: string } } };
    assert.deepEqual(created.activity.rankingRule, { name: "均分上限", explanation: "每組最多成功 1 題" });
    assert.equal(app.manager.getActive()?.rankingRule, "cap");

    const preparingUpdate = await fetch(`${base}/api/teacher/ranking-rule`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ rankingRule: "speed" }),
    });
    assert.equal(preparingUpdate.status, 200);
    assert.equal(app.manager.getActive()?.rankingRule, "speed");

    assert.equal((await fetch(`${base}/api/teacher/start`, { method: "POST", headers: teacherHeaders(), body: "{}" })).status, 200);
    const buzzingUpdate = await fetch(`${base}/api/teacher/ranking-rule`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ rankingRule: "cap" }),
    });
    assert.equal(buzzingUpdate.status, 409);
    assert.deepEqual(await buzzingUpdate.json(), { error: "搶答開始後不能更改排名規則" });
    assert.equal(app.manager.getActive()?.rankingRule, "speed");

    assert.equal((await fetch(`${base}/api/teacher/end`, { method: "POST", headers: teacherHeaders(), body: "{}" })).status, 200);
    const endedUpdate = await fetch(`${base}/api/teacher/ranking-rule`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ rankingRule: "cap" }),
    });
    assert.equal(endedUpdate.status, 409);
    assert.deepEqual(await endedUpdate.json(), { error: "搶答開始後不能更改排名規則" });
    assert.equal(app.manager.getActive()?.rankingRule, "speed");
  });
});

test("老師透過 HTTP 建立自訂三組活動，且學生可查詢並加入這三組", async () => {
  await withServer(async (base) => {
    const createdResponse = await fetch(`${base}/api/teacher/activity`, {
      method: "POST",
      headers: teacherHeaders(),
      body: JSON.stringify({ questionSetId: "seed-set", groupNames: ["甲", "乙", "丙"] }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      activity: { activityCode: string; groups: { id: string; name: string; onlineStudentPages: number }[] };
    };
    assert.deepEqual(created.activity.groups.map(({ id, name }) => ({ id, name })), [
      { id: "group-1", name: "甲" },
      { id: "group-2", name: "乙" },
      { id: "group-3", name: "丙" },
    ]);

    const choicesResponse = await fetch(`${base}/api/student/activity?code=${created.activity.activityCode}`);
    assert.equal(choicesResponse.status, 200);
    const choices = await choicesResponse.json() as { groups: { id: string; name: string }[] };
    assert.deepEqual(choices.groups, created.activity.groups.map(({ id, name }) => ({ id, name })));

    const joinedResponse = await fetch(`${base}/api/student/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityCode: created.activity.activityCode, groupId: "group-3" }),
    });
    assert.equal(joinedResponse.status, 201);
    const joined = await joinedResponse.json() as {
      sessionToken: string; activityCode: string; groupId: string; groupName: string;
    };
    assert.equal(joined.groupId, "group-3");
    assert.equal(joined.groupName, "丙");
    assert.equal(joined.activityCode, created.activity.activityCode);
    assert.equal(typeof joined.sessionToken, "string");
    assert.ok(joined.sessionToken.length > 0);
  });
});

test("老師建立活動拒絕 1 或 11 組並回傳中文組數說明", async () => {
  await withServer(async (base, _directory, app) => {
    const create = (groupNames: string[]) => fetch(`${base}/api/teacher/activity`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ questionSetId: "seed-set", groupNames }),
    });
    const lowerBound = await create(["一組"]);
    assert.equal(lowerBound.status, 400);
    assert.deepEqual(await lowerBound.json(), { error: "活動組數須為 2～10 組。" });
    assert.equal(app.manager.getActive(), undefined);

    const minimum = await create(["一組", "二組"]);
    assert.equal(minimum.status, 201);
    const active = app.manager.getActive();
    assert.equal(active?.groups.length, 2);

    const upperBound = await create(Array.from({ length: 11 }, (_, index) => `第 ${index + 1} 組`));
    assert.equal(upperBound.status, 400);
    assert.deepEqual(await upperBound.json(), { error: "活動組數須為 2～10 組。" });
    assert.equal(app.manager.getActive(), active);

    const maximum = await create(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 組`));
    assert.equal(maximum.status, 201);
    assert.equal(app.manager.getActive()?.groups.length, 10);
  });
});

test("認證老師 HTTP 活動畫面取得各組線上學生頁面數", async () => {
  await withServer(async (base, _directory, app) => {
    app.manager.create(fixtureSet(), { activityCode: "2468" });
    const student = createClient(base, {
      autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"],
      auth: { role: "student", sessionToken: "team-a-session" },
    });
    try {
      const studentView = new Promise<unknown>((resolve) => student.once("activity:student-view", resolve));
      student.connect();
      await new Promise<void>((resolve, reject) => {
        student.once("connect", resolve);
        student.once("connect_error", reject);
      });
      assert.equal(JSON.stringify(await studentView).includes("onlineStudentPages"), false);

      const response = await fetch(`${base}/api/teacher/view`, { headers: teacherHeaders() });
      assert.equal(response.status, 200);
      const view = (await response.json() as { activity: { groups: { onlineStudentPages: number }[] } }).activity;
      assert.deepEqual(view.groups.map(({ onlineStudentPages }) => onlineStudentPages), [1, 0, 0, 0]);
    } finally {
      student.disconnect();
    }
  });
});

test("同一活動提交後 HTTP 與 Socket 老師視圖欄位一致", async () => {
  await withServer(async (base, _directory, app) => {
    const activity = app.manager.create(fixtureSet(), { activityCode: "2468", rankingRule: "cap" });
    activity.stage = "buzzing";
    const teacher = createClient(base, {
      autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"],
      auth: { role: "teacher", pin: PIN },
    });
    const student = createClient(base, {
      autoConnect: false, forceNew: true, reconnection: false, transports: ["websocket"],
      auth: { role: "student", sessionToken: "team-a-session" },
    });
    const nextTeacherView = () => new Promise<unknown>((resolve) => teacher.once("activity:teacher-view", resolve));
    const connect = (socket: ReturnType<typeof createClient>) => new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
      socket.connect();
    });
    try {
      const initialView = nextTeacherView();
      await connect(teacher);
      await initialView;
      const joinedView = nextTeacherView();
      await connect(student);
      await joinedView;

      const pushedView = nextTeacherView();
      assert.deepEqual(await student.emitWithAck("student:submit", {
        questionNumber: 1, answers: { 1: "Socket 即時答案" },
      }), { ok: true, questionNumber: 1 });
      const socketView = await pushedView;
      const response = await fetch(`${base}/api/teacher/view`, { headers: teacherHeaders() });
      assert.equal(response.status, 200);
      const httpView = (await response.json() as { activity: Record<string, unknown> }).activity;

      assert.equal((httpView.rankingRule as { name: string }).name, "均分上限");
      assert.deepEqual(socketView, httpView);
      const table = (socketView as { stage: string; questions: { groups: { submitted: boolean; originalRank: number | null; finalRank: number | null; answers: { answer: string }[] | null }[] }[] });
      assert.equal(table.stage, "buzzing");
      assert.deepEqual(table.questions[0]?.groups[0], {
        groupId: "group-1", groupName: "第 1 組", submitted: true,
        sequence: 1, rank: 1, originalRank: 1, finalRank: 1,
        successful: true, skipped: false, explanation: "",
        answers: [{ subquestionNumber: 1, answer: "Socket 即時答案" }],
      });
    } finally {
      teacher.disconnect();
      student.disconnect();
    }
  });
});

test("HTTP server 重啟後活動與提交歸零，匯入題目集仍可讀取", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-restart-"));
  const questionDirectory = path.join(directory, "guided-notes");
  await mkdir(questionDirectory, { recursive: true });
  await writeFile(path.join(questionDirectory, "seed-set.json"), JSON.stringify(fixtureSet()));
  let first: ReturnType<typeof createLiveBuzzerServer> | undefined = createLiveBuzzerServer({ teacherPin: PIN, dataDirectory: questionDirectory });
  let second: ReturnType<typeof createLiveBuzzerServer> | undefined;
  try {
    const firstBase = await first.listen(0);
    const activity = first.manager.create(fixtureSet(), { activityCode: "2468" });
    activity.stage = "buzzing";
    assert.equal(submitAnswers(activity, "group-1", 1, { 1: "will be cleared" }).accepted, true);
    assert.equal(activity.submissions.get(1)?.size, 1);
    await first.close();

    second = createLiveBuzzerServer({ teacherPin: PIN, dataDirectory: questionDirectory });
    const secondBase = await second.listen(0);
    assert.equal(second.manager.getActive(), undefined);
    const activityLookup = await fetch(`${secondBase}/api/student/activity?code=2468`);
    assert.equal(activityLookup.status, 404);
    assert.deepEqual(await activityLookup.json(), { error: "activity-not-found" });
    const questionSets = await fetch(`${secondBase}/api/teacher/question-sets`, { headers: teacherHeaders() });
    assert.deepEqual(await questionSets.json(), {
      items: [{ id: "seed-set", sheetName: "種子題目", totalQuestionCount: 1, createdAt: "2026-11-22T00:00:00.000Z", source: "legacy" }],
    });
    first = undefined;
  } finally {
    if (second !== undefined) await second.close();
    if (first !== undefined) await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("真實 HTTP 學生路由在結束前回應不含他組答案與順位", async () => {
  await withServer(async (base, _directory, app) => {
    const activity = app.manager.create(fixtureSet(), { activityCode: "2468" });
    activity.stage = "buzzing";
    activity.nextSubmissionSequence = 987654;
    assert.equal(submitAnswers(activity, "group-2", 1, { 1: "SECRET-ANSWER-B" }).accepted, true);
    const studentRoutes = [
      `${base}/student`,
      `${base}/api/student/state?code=2468&group=group-1`,
    ];
    for (const route of studentRoutes) {
      const response = await fetch(route, route.includes("/api/student/") ? { headers: { "x-student-session": "team-a-session" } } : undefined);
      const payload = await response.text();
      assert.equal(response.status, 200, route);
      assert.equal(payload.includes("SECRET-ANSWER-B"), false, route);
      assert.equal(payload.includes("987654"), false, route);
      assert.equal(payload.includes('"sequence"'), false, route);
    }
  });
});

test("HTTP 學生視圖在活動進行中及結束後只包含本組已提交答案", async () => {
  await withServer(async (base, _directory, app) => {
    const activity = app.manager.create(fixtureSet(), { activityCode: "2468" });
    activity.stage = "buzzing";
    activity.nextSubmissionSequence = 987654;
    assert.equal(submitAnswers(activity, "group-2", 1, { 1: "SECRET-ANSWER-B" }).accepted, true);
    assert.equal(submitAnswers(activity, "group-1", 1, { 1: "TEAM-A-ANSWER" }).accepted, true);

    for (const stage of ["buzzing", "ended"] as const) {
      activity.stage = stage;
      const response = await fetch(`${base}/api/student/state?code=2468&group=group-1`, {
        headers: { "x-student-session": "team-a-session" },
      });
      assert.equal(response.status, 200);
      const view = await response.json() as {
        questions: { subquestions: { submitted: boolean; answer?: string }[] }[];
        results: { questionNumber: number; successfulGroup: { id: string; name: string } | null; answers: { subquestionNumber: number; answer: string }[] | null; otherSubmissions: { group: { id: string; name: string }; originalRank: number; skipped: boolean }[]; explanation: string | null }[] | null;
      };
      assert.equal(view.questions[0]?.subquestions[0]?.answer, "TEAM-A-ANSWER");
      if (stage === "buzzing") {
        assert.equal(view.results, null);
        const ownAnswers = JSON.stringify(view.questions.flatMap(({ subquestions }) => subquestions.map(({ answer }) => answer)));
        assert.equal(ownAnswers.includes("SECRET-ANSWER-B"), false);
        assert.equal(JSON.stringify(view).includes("group-2"), false);
        assert.doesNotMatch(JSON.stringify(view), /"(?:rank|originalRank|finalRank)"\s*:/u);
        assert.equal(JSON.stringify(view).includes("sequence"), false);
        assert.equal(JSON.stringify(view).includes("987654"), false);
      } else {
        assert.deepEqual(view.results, [{
          questionNumber: 1,
          successfulGroup: { id: "group-2", name: "第 2 組" },
          answers: [{ subquestionNumber: 1, answer: "SECRET-ANSWER-B" }],
          otherSubmissions: [{ group: { id: "group-1", name: "第 1 組" }, originalRank: 2, skipped: false }],
          explanation: null,
        }]);
        const ownAnswers = view.questions.flatMap(({ subquestions }) => subquestions.map(({ answer }) => answer));
        assert.deepEqual(ownAnswers, ["TEAM-A-ANSWER"]);
        assert.doesNotMatch(JSON.stringify(view), /"finalRank"\s*:/u);
        assert.equal(JSON.stringify(view).includes("sequence"), false);
        assert.equal(JSON.stringify(view).includes("987654"), false);
      }
    }
  });
});

test("活動代碼查詢成功時只回傳所有組別 id／名稱，不含作答資料或順位", async () => {
  await withServer(async (base, _directory, app) => {
    const activity = app.manager.create(fixtureSet(), { activityCode: "2468" });
    activity.stage = "buzzing";
    activity.nextSubmissionSequence = 987654;
    assert.equal(submitAnswers(activity, "group-2", 1, { 1: "SECRET-ANSWER-B" }).accepted, true);

    const response = await fetch(`${base}/api/student/activity?code=2468`);
    assert.equal(response.status, 200);
    const payload = await response.text();
    assert.deepEqual(JSON.parse(payload), {
      found: true,
      groups: [
        { id: "group-1", name: "第 1 組" },
        { id: "group-2", name: "第 2 組" },
        { id: "group-3", name: "第 3 組" },
        { id: "group-4", name: "第 4 組" },
      ],
    });
    assert.equal(payload.includes("SECRET-ANSWER-B"), false);
    assert.equal(payload.includes("987654"), false);
    assert.equal(payload.includes('"sequence"'), false);
  });
});

test("活動代碼查詢回傳建立活動時設定的自訂組名", async () => {
  await withServer(async (base, _directory, app) => {
    app.manager.create(fixtureSet(), { activityCode: "8642", groupNames: ["紅隊", "藍隊"] });
    const response = await fetch(`${base}/api/student/activity?code=8642`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      found: true,
      groups: [{ id: "group-1", name: "紅隊" }, { id: "group-2", name: "藍隊" }],
    });
  });
});

test("無效活動代碼查詢回傳明確錯誤", async () => {
  await withServer(async (base, _directory, app) => {
    app.manager.create(fixtureSet(), { activityCode: "2468" });
    const response = await fetch(`${base}/api/student/activity?code=1357`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "activity-not-found" });
  });
});

test("學生頁加入時將代碼與所選組別送至伺服器並把回傳身分存於分頁 sessionStorage", async () => {
  await withServer(async (base, _directory, app) => {
    app.manager.create(fixtureSet(), { activityCode: "2468", groupNames: ["紅隊", "藍隊"] });
    const page = await (await fetch(`${base}/student`)).text();
    for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/gu)) {
      assert.doesNotThrow(() => new Function(match[1]));
    }
    assert.match(page, /\/api\/student\/activity\?code=/u);
    assert.match(page, /\/api\/student\/join/u);
    assert.match(page, /maxlength="4"/u);
    assert.match(page, /找不到此活動代碼/u);
    assert.match(page, /joinButton\.disabled=groupSelect\.value===''?/u);
    assert.match(page, /sessionStorage\.setItem\('liveBuzzerSession'/u);
    assert.match(page, /sessionStorage\.removeItem\('liveBuzzerSession'/u);
    assert.match(page, /activity:student-view/u);
    assert.match(page, /等待老師開始/u);
    assert.match(page, /本組已送出/u);
    assert.match(page, /查看本組答案/u);
    assert.match(page, /answerInputs\.some\(input=>input\.value\.trim\(\)===''/u);
    assert.match(page, /submit\.disabled=answerInputs/u);
    assert.match(page, /答案不可空白/u);
    assert.match(page, /超過 200 字/u);
    assert.match(page, /不能重複提交/u);
    assert.match(page, /目前階段不能作答/u);
    assert.match(page, /id="leave-button"[^>]*>離開活動/u);
    assert.match(page, /leaveButton\.addEventListener\('click',leaveActivity\)/u);
    assert.match(page, /function leaveActivity\(\)\{clearSavedIdentity\(\)/u);
    assert.match(page, /function clearSavedIdentity\(\)\{sessionStorage\.removeItem\('liveBuzzerSession'\);sessionStorage\.removeItem\('liveBuzzerActivityCode'\);sessionStorage\.removeItem\('liveBuzzerGroupId'\)\}/u);
    assert.match(page, /oldSocket\.disconnect\(\)/u);
    assert.match(page, /currentView=null;content\.replaceChildren\(\);joinForm\.hidden=false;leaveButton\.hidden=true;codeInput\.value=''/u);
    assert.doesNotMatch(page, /\/api\/student\/leave/u);

    const joined = await fetch(`${base}/api/student/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityCode: "2468", groupId: "group-2" }),
    });
    assert.equal(joined.status, 201);
    const identity = await joined.json() as { sessionToken: string; activityCode: string; groupId: string; groupName: string };
    assert.match(identity.sessionToken, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ activityCode: identity.activityCode, groupId: identity.groupId, groupName: identity.groupName }, {
      activityCode: "2468", groupId: "group-2", groupName: "藍隊",
    });
    const invalidJoin = await fetch(`${base}/api/student/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityCode: "2468", groupId: "not-a-group" }),
    });
    assert.equal(invalidJoin.status, 400);
    assert.deepEqual(await invalidJoin.json(), { error: "group-not-found" });
    const invalidActivityJoin = await fetch(`${base}/api/student/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityCode: "1357", groupId: "group-1" }),
    });
    assert.equal(invalidActivityJoin.status, 404);
    assert.deepEqual(await invalidActivityJoin.json(), { error: "activity-not-found" });
  });
});

test("老師匯入 HTTP 預覽未確認不落檔，確認後沿用既有 import-service 寫入 JSON", async () => {
  await withServer(async (base, directory) => {
    const previewResponse = await fetch(`${base}/api/teacher/import/preview`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ input: "https://docs.google.com/spreadsheets/d/mock-id/edit" }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json() as { preview: { id: string; sheetName: string } }).preview;
    assert.equal(preview.sheetName, "HTTP 匯入測試");
    assert.deepEqual((await readdir(directory)).sort(), ["seed-set.json"]);

    const confirmedResponse = await fetch(`${base}/api/teacher/import/confirm`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ previewId: preview.id }),
    });
    assert.equal(confirmedResponse.status, 200);
    const confirmed = (await confirmedResponse.json() as { questionSet: GuidedNotesQuestionSet }).questionSet;
    assert.equal(confirmed.id, preview.id);
    assert.deepEqual((await readdir(directory)).sort(), [`${preview.id}.json`, "seed-set.json"].sort());
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${preview.id}.json`), "utf8")), confirmed);
  });
});
