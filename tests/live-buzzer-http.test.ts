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
    assert.match(teacherHtml, /建立活動/u);
    assert.match(teacherHtml, /開始搶答/u);
    assert.match(teacherHtml, /結束活動/u);
    assert.match(teacherHtml, /題目敘述/u);
    assert.match(teacherHtml, /\/api\/teacher\/import\/preview/u);

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
