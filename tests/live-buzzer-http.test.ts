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

async function withServer<T>(action: (baseUrl: string, directory: string, app: ReturnType<typeof createLiveBuzzerServer>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "live-buzzer-http-"));
  const questionDirectory = path.join(directory, "guided-notes");
  await mkdir(questionDirectory, { recursive: true });
  await writeFile(path.join(questionDirectory, "seed-set.json"), JSON.stringify(fixtureSet()));
  const app = createLiveBuzzerServer({
    teacherPin: PIN,
    dataDirectory: questionDirectory,
    importService: new GuidedNotesImportService(questionDirectory),
    readSpreadsheet: async () => mockSheet,
    resolveStudentSession: (token) => token === "team-a-session"
      ? { activityCode: "2468", groupId: "group-1" }
      : token === "team-b-session" ? { activityCode: "2468", groupId: "group-2" } : undefined,
  });
  const baseUrl = await app.listen(0);
  try { return await action(baseUrl, questionDirectory, app); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}

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
    assert.match(teacherHtml, /結束活動/u);
    assert.match(teacherHtml, /題目敘述/u);
    assert.match(teacherHtml, /\/api\/teacher\/import\/preview/u);
    assert.match(teacherHtml, /請輸入網址/u);
    assert.match(teacherHtml, /renderTable/u);
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
    assert.deepEqual(await list.json(), { items: [{ id: "seed-set", sheetName: "種子題目", totalQuestionCount: 1 }] });
    const createdResponse = await fetch(`${base}/api/teacher/activity`, {
      method: "POST", headers: teacherHeaders(), body: JSON.stringify({ questionSetId: "seed-set" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { activity: { activityCode: string; stage: string; groups: unknown[] } };
    assert.match(created.activity.activityCode, /^\d{4}$/u);
    assert.equal(created.activity.stage, "preparing");
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

test("老師透過 HTTP 建立自訂三組活動，且學生可查詢並加入這三組", async () => {
  await withServer(async (base) => {
    const createdResponse = await fetch(`${base}/api/teacher/activity`, {
      method: "POST",
      headers: teacherHeaders(),
      body: JSON.stringify({ questionSetId: "seed-set", groupNames: ["甲", "乙", "丙"] }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      activity: { activityCode: string; groups: { id: string; name: string }[] };
    };
    assert.deepEqual(created.activity.groups.map(({ id, name }) => ({ id, name })), [
      { id: "group-1", name: "甲" },
      { id: "group-2", name: "乙" },
      { id: "group-3", name: "丙" },
    ]);

    const choicesResponse = await fetch(`${base}/api/student/activity?code=${created.activity.activityCode}`);
    assert.equal(choicesResponse.status, 200);
    const choices = await choicesResponse.json() as { groups: { id: string; name: string }[] };
    assert.deepEqual(choices.groups, created.activity.groups);

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
      items: [{ id: "seed-set", sheetName: "種子題目", totalQuestionCount: 1 }],
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
    assert.match(page, /成功組別/u);
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
