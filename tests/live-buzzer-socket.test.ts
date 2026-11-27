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

function assertNoEvent(socket: ClientSocket, event: string, waitMs = 200): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`不應收到 Socket 事件：${event}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, waitMs);
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

  const initialView = await connectAndReadStudentView(studentSocket) as {
    questions: { description?: string }[];
  };
  assert.equal(initialView.questions[0]?.description, undefined);
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
  const updateView = await nextStudentView as {
    questionDescriptionsVisible: boolean;
    questions: { description?: string }[];
  };
  assert.equal(updateView.questionDescriptionsVisible, true);
  assert.equal(updateView.questions[0]?.description, "題目敘述");
  assertDoesNotContainSecretOrRank(updateView);

  studentSocket.disconnect();
  const reconnectView = await connectAndReadStudentView(studentSocket);
  assertDoesNotContainSecretOrRank(reconnectView);
});

test("Socket student views expose only the current group's answers before and after end", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  activity.nextSubmissionSequence = 987654;
  assert.equal(submitAnswers(activity, "group-2", 7, { 1: "SECRET-ANSWER-B", 2: "SECOND-SECRET-B" }).accepted, true);
  assert.equal(submitAnswers(activity, "group-1", 7, { 1: "TEAM-A-ANSWER-1", 2: "TEAM-A-ANSWER-2" }).accepted, true);

  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());
  const student = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  context.after(() => student.disconnect());

  const assertOnlyTeamAAnswers = (view: unknown): void => {
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("TEAM-A-ANSWER-1"), true);
    assert.equal(serialized.includes("TEAM-A-ANSWER-2"), true);
    assert.equal(serialized.includes("SECRET-ANSWER-B"), false);
    assert.equal(serialized.includes("SECOND-SECRET-B"), false);
    assert.equal(serialized.includes("group-2"), false);
    assert.equal(serialized.includes("第 2 組"), false);
    assert.equal(serialized.includes("rank"), false);
    assert.equal(serialized.includes("sequence"), false);
    assert.equal(serialized.includes("987654"), false);
  };

  const initialView = await connectAndReadStudentView(student) as {
    questions: { subquestions: { submitted: boolean; answer?: string }[] }[];
  };
  assert.deepEqual(initialView.questions[0]?.subquestions, [
    { number: 1, submitted: true, answer: "TEAM-A-ANSWER-1" },
    { number: 2, submitted: true, answer: "TEAM-A-ANSWER-2" },
  ]);
  assertOnlyTeamAAnswers(initialView);

  const teacher = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  context.after(() => teacher.disconnect());
  await connectAndReadTeacherView(teacher);
  const endedViewPromise = nextEvent(student, "activity:student-view");
  assert.deepEqual(await teacher.emitWithAck("teacher:end"), { ok: true, stage: "ended" });
  const endedView = await endedViewPromise as {
    stage: string;
    questions: { subquestions: { answer?: string }[] }[];
    results: { questionNumber: number; successfulGroup: { id: string; name: string } | null; answers: { subquestionNumber: number; answer: string }[] | null }[] | null;
  };
  assert.equal(endedView.stage, "ended");
  assert.deepEqual(endedView.results, [{
    questionNumber: 7,
    successfulGroup: { id: "group-2", name: "第 2 組" },
    answers: [
      { subquestionNumber: 1, answer: "SECRET-ANSWER-B" },
      { subquestionNumber: 2, answer: "SECOND-SECRET-B" },
    ],
  }]);
  assert.deepEqual(endedView.questions[0]?.subquestions.map(({ answer }) => answer), ["TEAM-A-ANSWER-1", "TEAM-A-ANSWER-2"]);
  assert.equal(JSON.stringify(endedView.questions).includes("SECRET-ANSWER-B"), false);
  assert.equal(JSON.stringify(endedView.questions).includes("group-2"), false);
  assert.equal(JSON.stringify(endedView).includes("rank"), false);
  assert.equal(JSON.stringify(endedView).includes("sequence"), false);
  assert.equal(JSON.stringify(endedView).includes("987654"), false);
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

test("teacher stage and description broadcasts reach students in every group", async (context) => {
  const manager = new ActivityManager();
  manager.create(questionSet(), { activityCode: "2468" });
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const teacher = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  const groupOne = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const groupTwo = client(harness.url, { role: "student", sessionToken: "team-b-token" });
  context.after(() => teacher.disconnect());
  context.after(() => groupOne.disconnect());
  context.after(() => groupTwo.disconnect());
  await Promise.all([
    connectAndReadTeacherView(teacher),
    connectAndReadStudentView(groupOne),
    connectAndReadStudentView(groupTwo),
  ]);

  const groupOneStarted = nextEvent<{ stage: string }>(groupOne, "activity:student-view");
  const groupTwoStarted = nextEvent<{ stage: string }>(groupTwo, "activity:student-view");
  assert.deepEqual(await teacher.emitWithAck("teacher:start"), { ok: true, stage: "buzzing" });
  assert.equal((await groupOneStarted).stage, "buzzing");
  assert.equal((await groupTwoStarted).stage, "buzzing");

  const groupOneDescription = nextEvent<{ questionDescriptionsVisible: boolean }>(groupOne, "activity:student-view");
  const groupTwoDescription = nextEvent<{ questionDescriptionsVisible: boolean }>(groupTwo, "activity:student-view");
  assert.deepEqual(await teacher.emitWithAck("teacher:set-question-descriptions", true), {
    ok: true,
    visible: true,
  });
  assert.equal((await groupOneDescription).questionDescriptionsVisible, true);
  assert.equal((await groupTwoDescription).questionDescriptionsVisible, true);

  const groupOneEnded = nextEvent<{ stage: string }>(groupOne, "activity:student-view");
  const groupTwoEnded = nextEvent<{ stage: string }>(groupTwo, "activity:student-view");
  assert.deepEqual(await teacher.emitWithAck("teacher:end"), { ok: true, stage: "ended" });
  assert.equal((await groupOneEnded).stage, "ended");
  assert.equal((await groupTwoEnded).stage, "ended");
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

test("student Socket refresh restores stage and submitted state; same-group clients sync and rejection reasons are explicit", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const firstTab = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const secondTab = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const teacher = client(harness.url, { role: "teacher", pin: TEACHER_PIN });
  context.after(() => firstTab.disconnect());
  context.after(() => secondTab.disconnect());
  context.after(() => teacher.disconnect());
  const [firstInitial, secondInitial] = await Promise.all([
    connectAndReadStudentView(firstTab),
    connectAndReadStudentView(secondTab),
    connectAndReadTeacherView(teacher),
  ]).then((views) => [views[0], views[1]] as const);
  assert.equal((firstInitial as { stage: string }).stage, "preparing");
  assert.equal((secondInitial as { group: { id: string } }).group.id, "group-1");
  assert.deepEqual(await firstTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "before start", 2: "no" },
  }), { ok: false, reason: "activity-not-buzzing" });

  const firstStageUpdate = nextEvent<{ stage: string }>(firstTab, "activity:student-view");
  const secondStageUpdate = nextEvent<{ stage: string }>(secondTab, "activity:student-view");
  const stageChangeStartedAt = Date.now();
  assert.deepEqual(await teacher.emitWithAck("teacher:start"), { ok: true, stage: "buzzing" });
  assert.equal((await firstStageUpdate).stage, "buzzing");
  assert.equal((await secondStageUpdate).stage, "buzzing");
  assert.ok(Date.now() - stageChangeStartedAt < 1_000, "所有已連線學生須在 1 秒內收到階段更新");

  assert.deepEqual(await firstTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "  ", 2: "answer" },
  }), { ok: false, reason: "blank-answer" });
  assert.deepEqual(await firstTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "x".repeat(201), 2: "answer" },
  }), { ok: false, reason: "answer-too-long" });

  const syncedView = nextEvent<{ stage: string; questions: { subquestions: { submitted: boolean }[] }[] }>(secondTab, "activity:student-view");
  assert.deepEqual(await firstTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "team answer", 2: "second answer" },
  }), { ok: true, questionNumber: 7 });
  const update = await syncedView;
  assert.equal(update.questions[0]?.subquestions.every(({ submitted }) => submitted), true);
  assert.equal(JSON.stringify(update).includes("team answer"), true);
  assert.equal(JSON.stringify(update).includes("second answer"), true);
  assert.deepEqual(await secondTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "different", 2: "answer" },
  }), { ok: false, reason: "already-submitted" });

  const refreshedTab = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  context.after(() => refreshedTab.disconnect());
  const refreshedView = await connectAndReadStudentView(refreshedTab) as {
    stage: string; group: { id: string }; questions: { subquestions: { submitted: boolean }[] }[];
  };
  assert.equal(refreshedView.stage, "buzzing");
  assert.equal(refreshedView.group.id, "group-1");
  assert.equal(refreshedView.questions[0]?.subquestions.every(({ submitted }) => submitted), true);

  const endedViewPromise = nextEvent<{ stage: string; results: unknown }>(refreshedTab, "activity:student-view");
  assert.deepEqual(await teacher.emitWithAck("teacher:end"), { ok: true, stage: "ended" });
  const endedView = await endedViewPromise;
  assert.equal(endedView.stage, "ended");
  assert.deepEqual(await refreshedTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "late", 2: "late" },
  }), { ok: false, reason: "activity-not-buzzing" });
});

test("submission updates only the submitting group while other groups receive no Socket message", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const submitter = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const sameGroupPeer = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const otherGroup = client(harness.url, { role: "student", sessionToken: "team-b-token" });
  context.after(() => submitter.disconnect());
  context.after(() => sameGroupPeer.disconnect());
  context.after(() => otherGroup.disconnect());
  await Promise.all([
    connectAndReadStudentView(submitter),
    connectAndReadStudentView(sameGroupPeer),
    connectAndReadStudentView(otherGroup),
  ]);

  const submitterUpdate = nextEvent<{ questions: { subquestions: { submitted: boolean }[] }[] }>(submitter, "activity:student-view");
  const peerUpdate = nextEvent<{ questions: { subquestions: { submitted: boolean }[] }[] }>(sameGroupPeer, "activity:student-view");
  const noOtherGroupUpdate = assertNoEvent(otherGroup, "activity:student-view");
  assert.deepEqual(await submitter.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "team one", 2: "team two" },
  }), { ok: true, questionNumber: 7 });

  for (const update of [await submitterUpdate, await peerUpdate]) {
    assert.equal(update.questions[0]?.subquestions.every(({ submitted }) => submitted), true);
  }
  await noOtherGroupUpdate;
});

test("leaving one student Socket tab does not clear the group's accepted answer or affect another tab", async (context) => {
  const manager = new ActivityManager();
  const activity = manager.create(questionSet(), { activityCode: "2468" });
  transitionActivityStage(activity, "buzzing");
  const harness = await startSocketHarness(manager);
  context.after(async () => harness.close());

  const leavingTab = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  const stayingTab = client(harness.url, { role: "student", sessionToken: "team-a-token" });
  context.after(() => leavingTab.disconnect());
  context.after(() => stayingTab.disconnect());
  await Promise.all([connectAndReadStudentView(leavingTab), connectAndReadStudentView(stayingTab)]);

  assert.deepEqual(await leavingTab.emitWithAck("student:submit", {
    questionNumber: 7, answers: { 1: "persist after leave", 2: "also retained" },
  }), { ok: true, questionNumber: 7 });
  const accepted = activity.submissions.get(7)?.get("group-1");
  assert.ok(accepted);
  leavingTab.disconnect();

  const state = await stayingTab.emitWithAck("student:get-state") as {
    ok: boolean; view: { questions: { subquestions: { submitted: boolean }[] }[] };
  };
  assert.equal(state.ok, true);
  assert.equal(state.view.questions[0]?.subquestions.every(({ submitted }) => submitted), true);
  assert.equal(activity.submissions.get(7)?.get("group-1")?.sequence, accepted.sequence);
  assert.deepEqual(activity.submissions.get(7)?.get("group-1")?.answers, {
    1: "persist after leave", 2: "also retained",
  });
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
