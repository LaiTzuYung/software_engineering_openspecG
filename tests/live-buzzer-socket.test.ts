import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { ActivityManager, transitionActivityStage } from "../src/live-buzzer/model.ts";
import { submitAnswers } from "../src/live-buzzer/submissions.ts";
import { createLiveBuzzerSocketServer } from "../src/live-buzzer/socket-server.ts";
import { createStudentStatusResponse } from "../src/live-buzzer/views.ts";
import type { GuidedNotesQuestionSet } from "../src/guided-notes/import-service.ts";

const TEACHER_PIN = "local-test-pin";
const STUDENT_TOKENS = new Map([
  ["team-a-token", { activityCode: "2468", groupId: "group-1" }],
  ["team-b-token", { activityCode: "2468", groupId: "group-2" }],
]);

function questionSet(): GuidedNotesQuestionSet {
  return {
    id: "socket-set",
    createdAt: "2026-11-21T00:00:00.000Z",
    sheetName: "學習單",
    totalQuestionCount: 1,
    singleQuestionCount: 0,
    groupQuestionCount: 1,
    questions: [{
      number: 7,
      description: "題目敘述",
      type: "group",
      subquestions: [
        { number: 1, answerCell: { sheetName: "學習單", address: "H10", row: 10, column: 8 } },
        { number: 2, answerCell: { sheetName: "學習單", address: "H11", row: 11, column: 8 } },
      ],
    }],
    warnings: [],
  };
}

interface SocketHarness {
  readonly httpServer: HttpServer;
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startSocketHarness(manager: ActivityManager): Promise<SocketHarness> {
  const httpServer = createServer();
  const io = createLiveBuzzerSocketServer(httpServer, manager, {
    teacherPin: TEACHER_PIN,
    resolveStudentSession: (token) => STUDENT_TOKENS.get(token),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
}

function client(url: string, auth: Readonly<Record<string, string>> = {}): ClientSocket {
  return createClient(url, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    auth,
  });
}

function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`逾時等待 Socket 事件：${event}`)), 3_000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function nextEvents<T>(socket: ClientSocket, event: string, count: number): Promise<readonly T[]> {
  return new Promise<readonly T[]>((resolve, reject) => {
    const payloads: T[] = [];
    const onEvent = (payload: T) => {
      payloads.push(payload);
      if (payloads.length < count) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payloads);
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`逾時等待 Socket 事件：${event} (${count})`));
    }, 3_000);
    socket.on(event, onEvent);
  });
}

async function connectAndReadStudentView(socket: ClientSocket): Promise<unknown> {
  const viewPromise = nextEvent(socket, "activity:student-view");
  socket.connect();
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return viewPromise;
}

function assertDoesNotContainSecretOrRank(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("SECRET-ANSWER-B"), false);
  assert.equal(serialized.includes("SECOND-SECRET-B"), false);
  assert.equal(serialized.includes("987654"), false);
  assert.equal(serialized.includes('"sequence"'), false);
}

test("student HTTP status payload uses the allowlisted view and rejects invalid identities", () => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  activity.nextSubmissionSequence = 987654;
  assert.equal(submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" }).accepted, true);

  const response = createStudentStatusResponse(activity, "group-1");
  assert.equal(response.statusCode, 200);
  assertDoesNotContainSecretOrRank(response.payload);
  assert.deepEqual(createStudentStatusResponse(activity, "invalid-group"), {
    statusCode: 401,
    payload: { error: "invalid-student-session" },
  });
});

test("initial, update, query and reconnect Socket payloads never include another group's answer or rank", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  activity.nextSubmissionSequence = 987654;
  assert.equal(submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" }).accepted, true);

  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());
  const studentSocket = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  context.after(() => studentSocket.disconnect());

  const initialView = await connectAndReadStudentView(studentSocket);
  assertDoesNotContainSecretOrRank(initialView);

  const stateResponse = await studentSocket.emitWithAck("student:get-state");
  assert.equal(isOkResponse(stateResponse), true);
  assertDoesNotContainSecretOrRank(stateResponse);

  const teacherSocket = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  context.after(() => teacherSocket.disconnect());
  await connectAndReadTeacherView(teacherSocket);
  const nextStudentView = nextEvent(studentSocket, "activity:student-view");
  const settingResponse = await teacherSocket.emitWithAck("teacher:set-question-descriptions", true);
  assert.deepEqual(settingResponse, { ok: true, visible: true });
  const updateView = await nextStudentView;
  assertDoesNotContainSecretOrRank(updateView);

  studentSocket.disconnect();
  const reconnectView = await connectAndReadStudentView(studentSocket);
  assertDoesNotContainSecretOrRank(reconnectView);
});

test("two Socket clients submitting the same question near-simultaneously get server-ordered unique sequences", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const teamA = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const teamB = client(harness.url, { role: "student", sessionToken: "team-b-token" });
  const teacherSocket = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  context.after(() => teamA.disconnect());
  context.after(() => teamB.disconnect());
  context.after(() => teacherSocket.disconnect());
  await Promise.all([
    connectAndReadStudentView(teamA),
    connectAndReadStudentView(teamB),
    connectAndReadTeacherView(teacherSocket),
  ]);

  const teacherUpdates = nextEvents(teacherSocket, "activity:teacher-view", 2);
  const [resultA, resultB] = await Promise.all([
    teamA.emitWithAck("student:submit", { questionNumber: 7, answers: { 1: "ANSWER-A", 2: "SECOND-A" } }),
    teamB.emitWithAck("student:submit", { questionNumber: 7, answers: { 1: "ANSWER-B", 2: "SECOND-B" } }),
  ]);
  assert.deepEqual(resultA, { ok: true, questionNumber: 7 });
  assert.deepEqual(resultB, { ok: true, questionNumber: 7 });

  const submissions = activity.submissions.get(7);
  assert.equal(submissions?.size, 2);
  assert.deepEqual([...submissions!.values()].map(({ sequence }) => sequence).sort((a, b) => a - b), [1, 2]);
  const updates = await teacherUpdates;
  const teacherView = JSON.stringify(updates[updates.length - 1]);
  assert.equal(teacherView.includes("ANSWER-A"), true);
  assert.equal(teacherView.includes("ANSWER-B"), true);
  assert.equal(teacherView.includes('"sequence":1'), true);
  assert.equal(teacherView.includes('"sequence":2'), true);
});

test("authenticated teacher Socket actions update stage and description settings", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());
  const teacherSocket = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  context.after(() => teacherSocket.disconnect());
  await connectAndReadTeacherView(teacherSocket);

  assert.deepEqual(await teacherSocket.emitWithAck("teacher:start"), { ok: true, stage: "buzzing" });
  assert.deepEqual(await teacherSocket.emitWithAck("teacher:set-question-descriptions", true), {
    ok: true,
    visible: true,
  });
  assert.deepEqual(await teacherSocket.emitWithAck("teacher:end"), { ok: true, stage: "ended" });
  assert.deepEqual(await teacherSocket.emitWithAck("teacher:start"), {
    ok: false,
    reason: "invalid-transition",
  });
  assert.equal(activity.stage, "ended");
  assert.equal(activity.showQuestionDescriptions, true);
});

test("student and unauthenticated Socket clients cannot run teacher actions or request full answers", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const studentSocket = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const anonymousSocket = client(harness.url);
  context.after(() => studentSocket.disconnect());
  context.after(() => anonymousSocket.disconnect());
  await Promise.all([connectAndReadStudentView(studentSocket), connectAndReadConnection(anonymousSocket)]);

  for (const socket of [studentSocket, anonymousSocket]) {
    assert.deepEqual(await socket.emitWithAck("teacher:start"), { ok: false, reason: "unauthorized" });
    assert.deepEqual(await socket.emitWithAck("teacher:end"), { ok: false, reason: "unauthorized" });
    assert.deepEqual(await socket.emitWithAck("teacher:set-question-descriptions", true), {
      ok: false,
      reason: "unauthorized",
    });
    assert.deepEqual(await socket.emitWithAck("teacher:get-full-view"), { ok: false, reason: "unauthorized" });
  }
  assert.equal(activity.stage, "preparing");
  assert.equal(activity.showQuestionDescriptions, false);
});

function isOkResponse(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

async function connectAndReadTeacherView(socket: ClientSocket): Promise<unknown> {
  const viewPromise = nextEvent(socket, "activity:teacher-view");
  socket.connect();
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return viewPromise;
}

async function connectAndReadConnection(socket: ClientSocket): Promise<void> {
  socket.connect();
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}
