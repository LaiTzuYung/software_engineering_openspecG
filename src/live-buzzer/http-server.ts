import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { GridSheet } from "../guided-notes/model.ts";
import type { GoogleSheetsValueRange } from "../guided-notes/google-sheets-adapter.ts";
import { GuidedNotesImportService } from "../guided-notes/import-service.ts";
import { createGoogleSheetsReader, createGoogleSheetsWriter } from "../guided-notes/google-sheets-adapter.ts";
import { SpreadsheetExportPreviewService, SpreadsheetExportWriteError } from "../guided-notes/spreadsheet-export-validation.ts";
import { createPreviewFromInput } from "../cli.ts";
import { ActivityManager, transitionActivityStage, type ActivityState, type RankingRule } from "./model.ts";
import { ActivitySnapshotStore, createActivitySnapshot, restoreActivitySnapshot } from "./activity-persistence.ts";
import { QuestionSetRepository } from "./question-sets.ts";
import { broadcastScreenView, countOnlineStudentPages, createLiveBuzzerSocketServer } from "./socket-server.ts";
import { createScreenView, createStudentStatusResponse, createStudentView, createTeacherView } from "./views.ts";
import { successfulAnswersForExport } from "./result-export.ts";
import { createResultsCsv } from "./result-csv.ts";
import { screenPage, studentPage, teacherLoginPage, teacherPage } from "./pages.ts";

export interface LiveBuzzerServerOptions {
  readonly teacherPin?: string;
  readonly dataDirectory?: string;
  /** Root directory for the current-activity snapshot; defaults to <cwd>/data. */
  readonly activityDataDirectory?: string;
  readonly importService?: GuidedNotesImportService;
  readonly readSpreadsheet?: (url: string) => Promise<GridSheet>;
  readonly writeSpreadsheetValues?: (
    spreadsheetId: string,
    data: readonly GoogleSheetsValueRange[],
  ) => Promise<number>;
  readonly exportBackupDirectory?: string;
  readonly resolveStudentSession?: (token: string) => { readonly activityCode: string; readonly groupId: string } | undefined;
}

export interface LiveBuzzerServer {
  readonly server: HttpServer;
  readonly manager: ActivityManager;
  readonly teacherPin: string;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 1_000_000) throw new Error("請求內容過大。");
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("請求格式無效。");
  return parsed as Record<string, unknown>;
}

function cookiePin(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "teacher_pin") return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  return actual === expected;
}

function isRankingRule(value: unknown): value is RankingRule {
  return value === "speed" || value === "cap";
}

function readPin(request: IncomingMessage): string | undefined {
  const header = request.headers["x-teacher-pin"];
  return typeof header === "string" ? header : cookiePin(request);
}

export function createLiveBuzzerServer(options: LiveBuzzerServerOptions = {}): LiveBuzzerServer {
  const teacherPin = options.teacherPin ?? process.env.TEACHER_PIN ?? randomBytes(4).toString("hex").toUpperCase();
  const manager = new ActivityManager();
  const dataDirectory = options.dataDirectory;
  const activityStore = new ActivitySnapshotStore(options.activityDataDirectory);
  const repository = new QuestionSetRepository(dataDirectory);
  const importService = options.importService ?? new GuidedNotesImportService(dataDirectory);
  const exportReadSpreadsheet = options.readSpreadsheet ?? (async (url: string) =>
    (await createGoogleSheetsReader()).read(url));
  const exportPreviews = new SpreadsheetExportPreviewService(exportReadSpreadsheet);
  const studentSessions = new Map<string, { readonly activityCode: string; readonly groupId: string }>();
  const persistActivity = async (activity: ActivityState): Promise<ActivityState> => {
    const snapshot = createActivitySnapshot(activity, studentSessions);
    await activityStore.save(snapshot);
    return restoreActivitySnapshot(snapshot).activity;
  };
  let activitySnapshotLoaded = false;
  const loadActivitySnapshot = async (): Promise<void> => {
    if (activitySnapshotLoaded) return;
    const restored = await activityStore.load();
    manager.replace(restored?.activity);
    studentSessions.clear();
    for (const [token, identity] of restored?.studentSessions ?? []) studentSessions.set(token, identity);
    activitySnapshotLoaded = true;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const route = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && route === "/") {
      response.writeHead(302, { location: "/student" }); response.end(); return;
    }
    if (method === "GET" && route === "/student") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(studentPage); return;
    }
    if (method === "GET" && route === "/screen") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(screenPage); return;
    }
    if (method === "GET" && route === "/api/screen/state") {
      const activity = manager.getActive();
      sendJson(response, 200, { activity: activity === undefined ? null : createScreenView(activity) }); return;
    }
    if (method === "GET" && route === "/teacher-login") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(teacherLoginPage); return;
    }
    if (method === "POST" && route === "/api/teacher/session") {
      try {
        const body = await readJson(request);
        if (!safeEqual(typeof body.pin === "string" ? body.pin : undefined, teacherPin)) {
          sendJson(response, 401, { error: "invalid-teacher-pin" }); return;
        }
        sendJson(response, 200, { ok: true }, { "set-cookie": `teacher_pin=${encodeURIComponent(teacherPin)}; HttpOnly; SameSite=Strict; Path=/` });
      } catch { sendJson(response, 400, { error: "invalid-request" }); }
      return;
    }

    if (route === "/teacher" || route.startsWith("/api/teacher/")) {
      if (!safeEqual(readPin(request), teacherPin)) {
        if (method === "GET" && route === "/teacher") {
          response.writeHead(302, { location: "/teacher-login?reason=invalid-teacher-pin", "cache-control": "no-store" }); response.end(); return;
        }
        sendJson(response, 401, { error: "invalid-teacher-pin" }); return;
      }
      if (method === "GET" && route === "/teacher") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(teacherPage); return;
      }
      try {
        if (method === "GET" && route === "/api/teacher/question-sets") {
          const questionSets = [...await repository.list()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
          const items = questionSets.map(({ id, sheetName, totalQuestionCount, createdAt, googleSource, importSource }) => ({
            id, sheetName, totalQuestionCount, createdAt,
            source: googleSource !== undefined ? "google" : importSource ?? "legacy",
          }));
          sendJson(response, 200, { items }); return;
        }
        if (method === "POST" && route === "/api/teacher/activity") {
          const body = await readJson(request);
          if (typeof body.questionSetId !== "string") { sendJson(response, 400, { error: "invalid-request" }); return; }
          const rankingRule = body.rankingRule === undefined ? "speed" : body.rankingRule;
          if (!isRankingRule(rankingRule)) { sendJson(response, 400, { error: "invalid-request" }); return; }
          const set = await repository.get(body.questionSetId);
          if (set === undefined) { sendJson(response, 404, { error: "question-set-not-found" }); return; }
          const groupNames = Array.isArray(body.groupNames) && body.groupNames.every((name) => typeof name === "string")
            ? body.groupNames as string[] : undefined;
          const previousActivity = manager.getActive();
          const previousSessions = new Map(studentSessions);
          studentSessions.clear();
          const activity = manager.create(set, {
            ...(groupNames === undefined ? {} : { groupNames }),
            rankingRule,
          });
          let persistedActivity: ActivityState;
          try {
            persistedActivity = await persistActivity(activity);
          } catch (error) {
            manager.replace(previousActivity);
            studentSessions.clear();
            for (const [token, identity] of previousSessions) studentSessions.set(token, identity);
            throw error;
          }
          for (const socket of socketServer.sockets.sockets.values()) {
            if ((socket.data as { role?: string; studentIdentity?: { activityCode: string } }).role !== "student") continue;
            const identity = (socket.data as { studentIdentity?: { activityCode: string } }).studentIdentity;
            if (identity?.activityCode === persistedActivity.activityCode) continue;
            socket.emit("auth:invalid", { code: "invalid-student-session" });
            socket.disconnect(true);
          }
          broadcastScreenView(socketServer, persistedActivity);
          sendJson(response, 201, { activity: createTeacherView(persistedActivity, countOnlineStudentPages(socketServer, persistedActivity)) }); return;
        }
        if (method === "POST" && route === "/api/teacher/ranking-rule") {
          const body = await readJson(request);
          if (!isRankingRule(body.rankingRule)) { sendJson(response, 400, { error: "invalid-request" }); return; }
          const activityBeforeUpdate = manager.getActive();
          const previousRule = activityBeforeUpdate?.rankingRule;
          const result = manager.setRankingRule(body.rankingRule);
          if (!result.ok) {
            sendJson(response, 409, { error: result.reason === "ranking-rule-locked" ? result.message : "activity-unavailable" }); return;
          }
          const activity = manager.getActive()!;
          let persistedActivity: ActivityState;
          try {
            persistedActivity = await persistActivity(activity);
          } catch (error) {
            if (previousRule !== undefined) activity.rankingRule = previousRule;
            throw error;
          }
          broadcastScreenView(socketServer, persistedActivity);
          for (const client of socketServer.sockets.sockets.values()) {
            if (client.data.role === "student" && client.data.studentIdentity?.activityCode === persistedActivity.activityCode) {
              const view = createStudentView(persistedActivity, client.data.studentIdentity.groupId);
              if (view !== undefined) client.emit("activity:student-view", view);
            } else if (client.data.role === "teacher") {
              client.emit("activity:teacher-view", createTeacherView(persistedActivity, countOnlineStudentPages(socketServer, persistedActivity)));
            }
          }
          sendJson(response, 200, { activity: createTeacherView(persistedActivity, countOnlineStudentPages(socketServer, persistedActivity)) }); return;
        }
        if (method === "POST" && (route === "/api/teacher/start" || route === "/api/teacher/end")) {
          const activity = manager.getActive();
          const previousStage = activity?.stage;
          const result = manager.transition(route.endsWith("/start") ? "buzzing" : "ended");
          if (!result.ok || activity === undefined) { sendJson(response, 409, { error: "invalid-transition" }); return; }
          let persistedActivity: ActivityState;
          try {
            persistedActivity = await persistActivity(activity);
          } catch (error) {
            if (previousStage !== undefined) activity.stage = previousStage;
            throw error;
          }
          const io = socketServer;
          broadcastScreenView(io, persistedActivity);
          for (const client of io.sockets.sockets.values()) {
            if (client.data.role === "student" && client.data.studentIdentity?.activityCode === persistedActivity.activityCode) {
              const view = createStudentView(persistedActivity, client.data.studentIdentity.groupId);
              if (view !== undefined) client.emit("activity:student-view", view);
            } else if (client.data.role === "teacher") client.emit("activity:teacher-view", createTeacherView(persistedActivity, countOnlineStudentPages(io, persistedActivity)));
          }
          sendJson(response, 200, { activity: createTeacherView(persistedActivity, countOnlineStudentPages(io, persistedActivity)) }); return;
        }
        if (method === "POST" && route === "/api/teacher/descriptions") {
          const body = await readJson(request);
          const activity = manager.getActive();
          if (activity === undefined || typeof body.visible !== "boolean") { sendJson(response, 409, { error: "invalid-request" }); return; }
          const previous = activity.showQuestionDescriptions;
          activity.showQuestionDescriptions = body.visible;
          let persistedActivity: ActivityState;
          try {
            persistedActivity = await persistActivity(activity);
          } catch (error) {
            activity.showQuestionDescriptions = previous;
            throw error;
          }
          broadcastScreenView(socketServer, persistedActivity);
          for (const client of socketServer.sockets.sockets.values()) {
            if (client.data.role === "student" && client.data.studentIdentity?.activityCode === persistedActivity.activityCode) {
              const view = createStudentView(persistedActivity, client.data.studentIdentity.groupId);
              if (view !== undefined) client.emit("activity:student-view", view);
            } else if (client.data.role === "teacher") client.emit("activity:teacher-view", createTeacherView(persistedActivity, countOnlineStudentPages(socketServer, persistedActivity)));
          }
          sendJson(response, 200, { activity: createTeacherView(persistedActivity, countOnlineStudentPages(socketServer, persistedActivity)) }); return;
        }
        if (method === "GET" && route === "/api/teacher/view") {
          const activity = manager.getActive();
          sendJson(response, 200, activity === undefined ? { activity: null } : { activity: createTeacherView(activity, countOnlineStudentPages(socketServer, activity)) }); return;
        }
        if (method === "POST" && route === "/api/teacher/import/preview") {
          const body = await readJson(request);
          if (typeof body.input !== "string" || body.input.trim() === "") { sendJson(response, 400, { error: "invalid-request" }); return; }
          const result = await createPreviewFromInput(body.input, {
            service: importService,
            ...(options.readSpreadsheet === undefined ? {} : { readSpreadsheet: options.readSpreadsheet }),
          });
          sendJson(response, 200, { preview: result.preview }); return;
        }
        if (method === "POST" && route === "/api/teacher/import/confirm") {
          const body = await readJson(request);
          if (typeof body.previewId !== "string") { sendJson(response, 400, { error: "invalid-request" }); return; }
          const questionSet = await importService.confirm(body.previewId);
          sendJson(response, 200, { questionSet }); return;
        }
        if (method === "POST" && route === "/api/teacher/export/preview") {
          const activity = manager.getActive();
          if (activity === undefined || activity.stage !== "ended") {
            sendJson(response, 409, { error: "請先結束活動再預覽回寫。" }); return;
          }
          if (activity.questionSet.googleSource === undefined) {
            sendJson(response, 409, { error: "此題目集沒有 Google 試算表來源，無法回寫。" }); return;
          }
          const preview = await exportPreviews.create(
            activity.questionSet,
            successfulAnswersForExport(activity),
            activity.activityCode,
          );
          sendJson(response, 200, { preview }); return;
        }
        if (method === "POST" && route === "/api/teacher/export/confirm") {
          const body = await readJson(request);
          if (typeof body.previewId !== "string" || body.previewId.length === 0) {
            sendJson(response, 400, { error: "請提供有效的回寫預覽 ID。" }); return;
          }
          const activity = manager.getActive();
          if (activity === undefined || activity.stage !== "ended") {
            sendJson(response, 409, { error: "請先結束活動再確認回寫。" }); return;
          }
          if (activity.questionSet.googleSource === undefined) {
            sendJson(response, 409, { error: "此題目集沒有 Google 試算表來源，無法回寫。" }); return;
          }
          const writeRawValues = options.writeSpreadsheetValues ?? (async (spreadsheetId, ranges) =>
            (await createGoogleSheetsWriter()).writeRawValues(spreadsheetId, ranges));
          try {
            const result = await exportPreviews.confirmAndWrite(
              body.previewId,
              activity.activityCode,
              writeRawValues,
              options.exportBackupDirectory,
            );
            sendJson(response, 200, result); return;
          } catch (error) {
            if (error instanceof SpreadsheetExportWriteError) {
              sendJson(response, 400, { error: error.message, backupPath: error.backupPath }); return;
            }
            throw error;
          }
        }
        if (method === "POST" && route === "/api/teacher/export/restore") {
          const activity = manager.getActive();
          if (activity === undefined || activity.stage !== "ended") {
            sendJson(response, 409, { error: "請先結束活動再預覽還原。" }); return;
          }
          if (activity.questionSet.googleSource === undefined) {
            sendJson(response, 409, { error: "此題目集沒有 Google 試算表來源，無法還原。" }); return;
          }
          const preview = await exportPreviews.createRestorePreview(
            activity.questionSet,
            activity.activityCode,
            options.exportBackupDirectory,
          );
          sendJson(response, 200, preview); return;
        }
        if (method === "POST" && route === "/api/teacher/export/restore/confirm") {
          const body = await readJson(request);
          if (typeof body.previewId !== "string" || body.previewId.length === 0) {
            sendJson(response, 400, { error: "請提供有效的還原預覽 ID。" }); return;
          }
          const activity = manager.getActive();
          if (activity === undefined || activity.stage !== "ended") {
            sendJson(response, 409, { error: "請先結束活動再確認還原。" }); return;
          }
          if (activity.questionSet.googleSource === undefined) {
            sendJson(response, 409, { error: "此題目集沒有 Google 試算表來源，無法還原。" }); return;
          }
          const writeRawValues = options.writeSpreadsheetValues ?? (async (spreadsheetId, ranges) =>
            (await createGoogleSheetsWriter()).writeRawValues(spreadsheetId, ranges));
          const result = await exportPreviews.confirmRestore(
            body.previewId,
            activity.activityCode,
            exportReadSpreadsheet,
            writeRawValues,
            options.exportBackupDirectory,
          );
          sendJson(response, 200, result); return;
        }
        if (method === "GET" && route === "/api/teacher/export/csv") {
          const activity = manager.getActive();
          if (activity === undefined || activity.stage !== "ended") {
            sendJson(response, 409, { error: "請先結束活動再下載 CSV。" }); return;
          }
          const filename = `results-${activity.activityCode}.csv`;
          response.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "no-store",
          });
          response.end(createResultsCsv(activity), "utf8"); return;
        }
        sendJson(response, 404, { error: "not-found" }); return;
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "request-failed" }); return;
      }
    }
    if (method === "GET" && route === "/api/student/activity") {
      const code = url.searchParams.get("code") ?? "";
      if (!/^\d{4}$/u.test(code)) { sendJson(response, 400, { error: "invalid-activity-code" }); return; }
      const activity = manager.getActive();
      if (activity === undefined || code !== activity.activityCode) {
        sendJson(response, 404, { error: "activity-not-found" }); return;
      }
      sendJson(response, 200, {
        found: true,
        groups: activity.groups.map((group) => ({ id: group.id, name: group.name })),
      });
      return;
    }
    if (method === "POST" && route === "/api/student/join") {
      try {
        const body = await readJson(request);
        const activity = manager.getActive();
        if (activity === undefined || body.activityCode !== activity.activityCode) {
          sendJson(response, 404, { error: "activity-not-found" }); return;
        }
        const group = activity.groups.find(({ id }) => id === body.groupId);
        if (group === undefined) { sendJson(response, 400, { error: "group-not-found" }); return; }
        const sessionToken = randomUUID();
        studentSessions.set(sessionToken, { activityCode: activity.activityCode, groupId: group.id });
        try {
          await persistActivity(activity);
        } catch {
          studentSessions.delete(sessionToken);
          sendJson(response, 500, { error: "persistence-failed" }); return;
        }
        sendJson(response, 201, {
          sessionToken,
          activityCode: activity.activityCode,
          groupId: group.id,
          groupName: group.name,
        });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid-request" });
      }
      return;
    }
    if (method === "GET" && route === "/api/student/state") {
      const activity = manager.getActive();
      if (activity === undefined || url.searchParams.get("code") !== activity.activityCode) {
        sendJson(response, 404, { error: "activity-not-found" }); return;
      }
      const token = request.headers["x-student-session"];
      const identity = typeof token === "string"
        ? studentSessions.get(token) ?? options.resolveStudentSession?.(token)
        : undefined;
      if (identity === undefined || identity.activityCode !== activity.activityCode) {
        sendJson(response, 401, { error: "invalid-student-session" }); return;
      }
      const result = createStudentStatusResponse(activity, identity.groupId);
      sendJson(response, result.statusCode, result.payload); return;
    }
    sendJson(response, 404, { error: "not-found" });
  });
  const socketServer = createLiveBuzzerSocketServer(server, manager, {
    teacherPin,
    persistActivity,
    resolveStudentSession: (token) => studentSessions.get(token) ?? options.resolveStudentSession?.(token),
  });
  return {
    server,
    manager,
    teacherPin,
    async listen(port = 3000, host = "127.0.0.1"): Promise<string> {
      await loadActivitySnapshot();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
      const address = server.address() as AddressInfo;
      return `http://${host}:${address.port}`;
    },
    async close(): Promise<void> {
      await activityStore.flush();
      await new Promise<void>((resolve, reject) => socketServer.close((error) => error ? reject(error) : resolve()));
    },
  };
}
