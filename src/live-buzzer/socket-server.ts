import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ActivityManager, ActivityState, RankingRule } from "./model.ts";
import { submitAnswers } from "./submissions.ts";
import { createScreenView, createStudentView, createTeacherView } from "./views.ts";

export interface StudentSocketIdentity {
  readonly activityCode: string;
  readonly groupId: string;
}

export interface LiveBuzzerSocketOptions {
  readonly teacherPin: string;
  readonly resolveStudentSession: (sessionToken: string) => StudentSocketIdentity | undefined;
  readonly persistActivity?: (activity: ActivityState) => Promise<ActivityState>;
}

type SocketRole = "teacher" | "student" | "screen" | "anonymous";

interface AuthPayload {
  readonly role?: unknown;
  readonly pin?: unknown;
  readonly sessionToken?: unknown;
}

interface LiveSocketData {
  role: SocketRole;
  studentIdentity?: StudentSocketIdentity;
}

type Acknowledger = (result: unknown) => void;

function acknowledge(callback: unknown, result: unknown): void {
  if (typeof callback === "function") (callback as Acknowledger)(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnswerMap(value: unknown): value is Readonly<Record<number, string>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((answer) => typeof answer === "string");
}

function isRankingRule(value: unknown): value is RankingRule {
  return value === "speed" || value === "cap";
}

function getActiveActivity(manager: ActivityManager): ActivityState | undefined {
  return manager.getActive();
}

function isValidStudentIdentity(
  activity: ActivityState | undefined,
  identity: StudentSocketIdentity | undefined,
): identity is StudentSocketIdentity {
  return activity !== undefined && identity !== undefined &&
    identity.activityCode === activity.activityCode &&
    activity.groups.some((group) => group.id === identity.groupId);
}

function studentIdentityForSocket(
  socket: Socket,
  manager: ActivityManager,
  options: LiveBuzzerSocketOptions,
): StudentSocketIdentity | undefined {
  const auth = socket.handshake.auth as AuthPayload;
  if (auth.role !== "student" || typeof auth.sessionToken !== "string") return undefined;
  const identity = options.resolveStudentSession(auth.sessionToken);
  if (!isValidStudentIdentity(getActiveActivity(manager), identity)) return undefined;
  return identity;
}

function isTeacher(socket: Socket): boolean {
  const data = socket.data as LiveSocketData;
  return data.role === "teacher";
}

function isStudent(socket: Socket): socket is Socket & { data: LiveSocketData } {
  const data = socket.data as LiveSocketData;
  return data.role === "student" && data.studentIdentity !== undefined;
}

export function countOnlineStudentPages(io: Server, activity: ActivityState): ReadonlyMap<string, number> {
  const counts = new Map(activity.groups.map(({ id }) => [id, 0]));
  for (const socket of io.sockets.sockets.values()) {
    if (!socket.connected || !isStudent(socket)) continue;
    const identity = socket.data.studentIdentity;
    if (identity === undefined || identity.activityCode !== activity.activityCode || !counts.has(identity.groupId)) continue;
    counts.set(identity.groupId, counts.get(identity.groupId)! + 1);
  }
  return counts;
}

function broadcastStudentViews(io: Server, activity: ActivityState, onlyGroupId?: string): void {
  for (const socket of io.sockets.sockets.values()) {
    if (!isStudent(socket)) continue;
    const identity = socket.data.studentIdentity;
    if (identity === undefined || identity.activityCode !== activity.activityCode) continue;
    if (onlyGroupId !== undefined && identity.groupId !== onlyGroupId) continue;
    const studentView = createStudentView(activity, identity.groupId);
    if (studentView !== undefined) socket.emit("activity:student-view", studentView);
  }
}

function broadcastTeacherView(io: Server, activity: ActivityState): void {
  const teacherView = createTeacherView(activity, countOnlineStudentPages(io, activity));
  for (const socket of io.sockets.sockets.values()) {
    if (isTeacher(socket)) socket.emit("activity:teacher-view", teacherView);
  }
}

export function broadcastScreenView(io: Server, activity: ActivityState): void {
  const view = createScreenView(activity);
  for (const socket of io.sockets.sockets.values()) {
    if ((socket.data as LiveSocketData).role === "screen") socket.emit("activity:screen-view", view);
  }
}

function rejectTeacherAction(socket: Socket, callback: unknown): boolean {
  if (isTeacher(socket)) return false;
  acknowledge(callback, { ok: false, reason: "unauthorized" });
  return true;
}

/** Attaches the real-time transport; all student emissions go through createStudentView. */
export function createLiveBuzzerSocketServer(
  httpServer: HttpServer,
  manager: ActivityManager,
  options: LiveBuzzerSocketOptions,
): Server {
  const io = new Server(httpServer, { serveClient: true });
  const persistActivity = options.persistActivity ?? (async (activity) => activity);

  io.on("connection", (socket) => {
    const auth = socket.handshake.auth as AuthPayload;
    const identity = studentIdentityForSocket(socket, manager, options);
    const socketData = socket.data as LiveSocketData;
    socketData.role = auth.role === "teacher" && typeof auth.pin === "string" && auth.pin === options.teacherPin
      ? "teacher"
      : identity === undefined
        ? "anonymous"
        : "student";
    if (auth.role === "screen") socketData.role = "screen";
    if (identity !== undefined && socketData.role === "student") {
      socketData.studentIdentity = identity;
      const activity = getActiveActivity(manager);
      if (activity !== undefined) {
        const studentView = createStudentView(activity, identity.groupId);
        if (studentView !== undefined) socket.emit("activity:student-view", studentView);
        broadcastTeacherView(io, activity);
      }
    } else if (socketData.role === "teacher") {
      const activity = getActiveActivity(manager);
      if (activity !== undefined) {
        socket.emit("activity:teacher-view", createTeacherView(activity, countOnlineStudentPages(io, activity)));
      }
    } else if (socketData.role === "screen") {
      const activity = getActiveActivity(manager);
      if (activity !== undefined) socket.emit("activity:screen-view", createScreenView(activity));
    }

    socket.on("screen:get-state", (callback: unknown) => {
      if (socketData.role !== "screen") {
        acknowledge(callback, { ok: false, reason: "unauthorized" });
        return;
      }
      const activity = getActiveActivity(manager);
      acknowledge(callback, { ok: true, activity: activity === undefined ? null : createScreenView(activity) });
    });

    socket.on("student:get-state", (callback: unknown) => {
      if (!isStudent(socket)) {
        acknowledge(callback, { ok: false, reason: "unauthorized" });
        return;
      }
      const activity = getActiveActivity(manager);
      const view = activity === undefined
        ? undefined
        : createStudentView(activity, socket.data.studentIdentity!.groupId);
      if (view === undefined) {
        acknowledge(callback, { ok: false, reason: "activity-unavailable" });
        return;
      }
      acknowledge(callback, { ok: true, view });
    });

    socket.on("student:submit", async (payload: unknown, callback: unknown) => {
      if (!isStudent(socket)) {
        acknowledge(callback, { ok: false, reason: "unauthorized" });
        return;
      }
      const activity = getActiveActivity(manager);
      if (activity === undefined || !isRecord(payload) ||
          typeof payload.questionNumber !== "number" || !isAnswerMap(payload.answers)) {
        acknowledge(callback, { ok: false, reason: "invalid-request" });
        return;
      }
      const identity = socket.data.studentIdentity!;
      const result = submitAnswers(activity, identity.groupId, payload.questionNumber, payload.answers);
      if (!result.accepted) {
        acknowledge(callback, { ok: false, reason: result.reason });
        return;
      }

      try {
        const persistedActivity = await persistActivity(activity);
        acknowledge(callback, { ok: true, questionNumber: result.submission.questionNumber });
        broadcastStudentViews(io, persistedActivity, identity.groupId);
        broadcastTeacherView(io, persistedActivity);
        broadcastScreenView(io, persistedActivity);
      } catch {
        acknowledge(callback, { ok: false, reason: "persistence-failed" });
      }
    });

    socket.on("teacher:start", async (callback: unknown) => {
      if (rejectTeacherAction(socket, callback)) return;
      const result = manager.transition("buzzing");
      if (!result.ok) {
        acknowledge(callback, { ok: false, reason: result.reason });
        return;
      }
      const activity = getActiveActivity(manager)!;
      try {
        const persistedActivity = await persistActivity(activity);
        acknowledge(callback, { ok: true, stage: persistedActivity.stage });
        broadcastStudentViews(io, persistedActivity);
        broadcastTeacherView(io, persistedActivity);
        broadcastScreenView(io, persistedActivity);
      } catch {
        activity.stage = "preparing";
        acknowledge(callback, { ok: false, reason: "persistence-failed" });
      }
    });

    socket.on("teacher:end", async (callback: unknown) => {
      if (rejectTeacherAction(socket, callback)) return;
      const result = manager.transition("ended");
      if (!result.ok) {
        acknowledge(callback, { ok: false, reason: result.reason });
        return;
      }
      const activity = getActiveActivity(manager)!;
      try {
        const persistedActivity = await persistActivity(activity);
        acknowledge(callback, { ok: true, stage: persistedActivity.stage });
        broadcastStudentViews(io, persistedActivity);
        broadcastTeacherView(io, persistedActivity);
        broadcastScreenView(io, persistedActivity);
      } catch {
        activity.stage = "buzzing";
        acknowledge(callback, { ok: false, reason: "persistence-failed" });
      }
    });

    socket.on("teacher:set-ranking-rule", async (payload: unknown, callback: unknown) => {
      if (rejectTeacherAction(socket, callback)) return;
      if (!isRankingRule(payload)) {
        acknowledge(callback, { ok: false, reason: "invalid-request" });
        return;
      }
      const activityBeforeUpdate = getActiveActivity(manager);
      const previousRule = activityBeforeUpdate?.rankingRule;
      const result = manager.setRankingRule(payload);
      if (!result.ok) {
        acknowledge(callback, result.reason === "ranking-rule-locked"
          ? { ok: false, reason: result.reason, message: result.message }
          : { ok: false, reason: result.reason });
        return;
      }
      const activity = getActiveActivity(manager)!;
      try {
        const persistedActivity = await persistActivity(activity);
        acknowledge(callback, { ok: true, rankingRule: persistedActivity.rankingRule });
        broadcastStudentViews(io, persistedActivity);
        broadcastTeacherView(io, persistedActivity);
        broadcastScreenView(io, persistedActivity);
      } catch {
        if (previousRule !== undefined) activity.rankingRule = previousRule;
        acknowledge(callback, { ok: false, reason: "persistence-failed" });
      }
    });

    socket.on("teacher:set-question-descriptions", async (payload: unknown, callback: unknown) => {
      if (rejectTeacherAction(socket, callback)) return;
      if (typeof payload !== "boolean") {
        acknowledge(callback, { ok: false, reason: "invalid-request" });
        return;
      }
      const activity = getActiveActivity(manager);
      if (activity === undefined) {
        acknowledge(callback, { ok: false, reason: "activity-unavailable" });
        return;
      }
      const previous = activity.showQuestionDescriptions;
      activity.showQuestionDescriptions = payload;
      try {
        const persistedActivity = await persistActivity(activity);
        acknowledge(callback, { ok: true, visible: payload });
        broadcastStudentViews(io, persistedActivity);
        broadcastTeacherView(io, persistedActivity);
        broadcastScreenView(io, persistedActivity);
      } catch {
        activity.showQuestionDescriptions = previous;
        acknowledge(callback, { ok: false, reason: "persistence-failed" });
      }
    });

    socket.on("teacher:get-full-view", (callback: unknown) => {
      if (rejectTeacherAction(socket, callback)) return;
      const activity = getActiveActivity(manager);
      if (activity === undefined) {
        acknowledge(callback, { ok: false, reason: "activity-unavailable" });
        return;
      }
      acknowledge(callback, { ok: true, view: createTeacherView(activity, countOnlineStudentPages(io, activity)) });
    });

    socket.on("disconnect", () => {
      if (!isStudent(socket)) return;
      const activity = getActiveActivity(manager);
      if (activity !== undefined && socket.data.studentIdentity?.activityCode === activity.activityCode) {
        broadcastTeacherView(io, activity);
      }
    });
  });

  return io;
}
