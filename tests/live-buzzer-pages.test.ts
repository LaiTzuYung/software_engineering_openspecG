import assert from "node:assert/strict";
import test from "node:test";
import { screenPage, studentPage, teacherLoginPage, teacherPage } from "../src/live-buzzer/pages.ts";

function createTeacherPageHarness(fetchImpl: (url: string, ...args: any[]) => Promise<any> = () => new Promise(() => {})) {
  const elements = new Map<string, any>();
  const ioCalls: unknown[] = [];
  const socketHandlers = new Map<string, (payload: unknown) => void>();
  const document = {
    querySelector(selector: string) {
      let element = elements.get(selector);
      if (element === undefined) {
        element = {
          children: [], textContent: "", className: "", value: "", dataset: {}, selectedOptions: [],
          append(...children: unknown[]) { this.children.push(...children); },
          replaceChildren(...children: unknown[]) { this.children = [...children]; },
        };
        elements.set(selector, element);
      }
      return element;
    },
    createElement(tag: string) {
      return { tag, children: [] as unknown[], textContent: "", className: "", style: {}, classList: { add() {} }, append(...children: unknown[]) { this.children.push(...children); } };
    },
  };
  const script = teacherPage.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const socket = {
    on(event: string, handler: (payload: unknown) => void) { socketHandlers.set(event, handler); return this; },
  };
  const runtime = new Function("document", "io", "sessionStorage", "fetch", "Option", `${script};return {show,renderImportPreview,renderExportPreview,renderRestorePreview};`)(
    document,
    (options: unknown) => { ioCalls.push(options); return socket; },
    { getItem() { return "test-pin"; } },
    fetchImpl,
    class Option {},
  ) as { show: (view: unknown) => void; renderImportPreview: (preview: unknown) => void; renderExportPreview: (preview: unknown) => void; renderRestorePreview: (preview: unknown) => void };
  return { elements, ioCalls, socketHandlers, show: runtime.show, renderImportPreview: runtime.renderImportPreview, renderExportPreview: runtime.renderExportPreview, renderRestorePreview: runtime.renderRestorePreview };
}

test("匯入摘要與回寫預覽都顯示定位方式及標記替換值", () => {
  const harness = createTeacherPageHarness();
  harness.renderImportPreview({ locatingMode: "marker", importSource: "xlsx", sheetName: "學習單", totalQuestionCount: 1, singleQuestionCount: 1, groupQuestionCount: 0, questions: [], warnings: [] });
  const serialize = (element: any): string => `${element.textContent}${element.children.map(serialize).join("")}`;
  assert.match(serialize(harness.elements.get("#import-preview")), /定位方式：\{\{答\}\} 標記/u);
  harness.renderExportPreview({ locatingMethod: "定位方式：{{答}} 標記", targets: [{ cell: { sheetName: "學習單", address: "G11" }, currentValue: "答：{{答}}", answer: "答：D3", status: "將寫入" }] });
  assert.match(serialize(harness.elements.get("#export-preview")), /定位方式：\{\{答\}\} 標記/u);
  assert.match(serialize(harness.elements.get("#export-preview")), /答：\{\{答\}\}.*答：D3/u);
});

test("teacher and student pages render ranking controls, results and no-success reasons", () => {
  assert.match(teacherPage, /preview\.locatingMethod/u);
  assert.match(teacherPage, /id="create"[^>]*>建立活動/u);
  assert.match(teacherPage, /id="create-ranking-rule"[\s\S]*?<option value="speed">純速度<\/option>[\s\S]*?<option value="cap">均分上限<\/option>/u);
  assert.match(teacherPage, /每組最多成功 /u);
  assert.match(teacherPage, /已達上限（跳過）/u);
  assert.match(teacherPage, /原始順位：/u);
  assert.match(teacherPage, /最終順位：/u);
  assert.match(teacherPage, /data\.stage==='preparing'/u);
  assert.match(teacherPage, /id="export-restore-button"[^>]*>還原預覽/u);
  assert.match(teacherPage, /id="export-restore-confirm-button"[^>]*>確認還原/u);
  assert.match(teacherPage, /\.restore-will\{[^}]*background:/u);
  assert.match(teacherPage, /\.restore-manual\{[^}]*background:/u);
  assert.match(studentPage, /排名規則：/u);
  assert.match(studentPage, /result\.explanation/u);
  assert.match(studentPage, /view\.stage==='ended'/u);
  assert.match(studentPage, /function leaveActivity\(\)/u);
  assert.match(studentPage, /leaveButton\.addEventListener\('click',leaveActivity\)/u);
  assert.match(studentPage, /drafts\[questionNumber\]=\{\}/u);
  assert.match(studentPage, /input\.value=drafts\[question\.number\]\?\./u);
  assert.match(studentPage, /socket\.emitWithAck\('student:submit'/u);

  for (const page of [teacherPage, studentPage]) {
    const script = page.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  }
  const buzzingRender = studentPage.split("if(view.stage==='buzzing'){")[1]?.split("\n  }\n}\nfunction connectStudent")[0];
  assert.ok(buzzingRender);
  assert.doesNotMatch(buzzingRender, /順位|已達上限|跳過|遞補|成功組|不成功/u);
});

test("teacher login stores the PIN and the teacher page connects on load, handles views, and enables reconnect", () => {
  assert.match(teacherLoginPage, /sessionStorage\.setItem\('teacherPin',pin\);location\.href='\/teacher'/u);
  assert.match(teacherPage, /<script src="\/socket\.io\/socket\.io\.js"><\/script><script>/u);
  const firstLoad = createTeacherPageHarness();
  assert.deepEqual(firstLoad.ioCalls, [{ auth: { role: "teacher", pin: "test-pin" }, reconnection: true }]);
  assert.equal(typeof firstLoad.socketHandlers.get("activity:teacher-view"), "function");
  assert.equal(typeof firstLoad.socketHandlers.get("connect_error"), "function");
  for (const [id, event] of [
    ["#create", "onclick"], ["#start", "onclick"], ["#end", "onclick"],
    ["#descriptions", "onchange"], ["#preview", "onclick"], ["#confirm", "onclick"],
    ["#export-preview-button", "onclick"], ["#export-confirm-button", "onclick"],
    ["#export-restore-button", "onclick"], ["#export-csv-button", "onclick"],
    ["#export-restore-confirm-button", "onclick"],
  ]) assert.equal(typeof firstLoad.elements.get(id)?.[event], "function", `${id} ${event} should remain registered`);
  assert.match(teacherPage, /refreshSets\(\)\.then\(\(\)=>api\('\/api\/teacher\/view'\)\)\.then\(show\)/u);

  const afterReload = createTeacherPageHarness();
  assert.equal(afterReload.ioCalls.length, 1, "重新載入老師頁時會依 sessionStorage 重新建立 Socket 連線");
});

test("還原預覽依手動修改狀態顯示不同顏色及原值欄，且預覽不會送出確認", async () => {
  const calls: string[] = [];
  const harness = createTeacherPageHarness(async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: "restore-preview", targets: [
      { cell: { sheetName: "學習單", address: "G5" }, currentValue: "答案", originalValue: "（1）", status: "已被手動修改" },
      { cell: { sheetName: "學習單", address: "G6" }, currentValue: "第二答案", originalValue: "(2)", status: "將還原" },
    ] }) };
  });
  await harness.elements.get("#export-restore-button").onclick();
  assert.equal(calls.includes("/api/teacher/export/restore"), true);
  assert.equal(calls.includes("/api/teacher/export/restore/confirm"), false);
  assert.equal(harness.elements.get("#export-restore-confirm-button").disabled, false);
  harness.renderRestorePreview({ id: "restore-preview", targets: [
    { cell: { sheetName: "學習單", address: "G5" }, currentValue: "答案", originalValue: "（1）", status: "已被手動修改" },
    { cell: { sheetName: "學習單", address: "G6" }, currentValue: "第二答案", originalValue: "(2)", status: "將還原" },
  ] });
  const container = harness.elements.get("#export-preview");
  const table = container.children[0];
  const rows = table.children.at(-1).children;
  assert.equal(rows[0].children.at(-1).className, "restore-manual");
  assert.equal(rows[1].children.at(-1).className, "restore-will");
  assert.equal(rows[0].children[2].textContent, "（1）");
});

test("screen page connects as a read-only screen and renders all three stages with projection styling", () => {
  assert.match(screenPage, /目前沒有進行中的活動/u);
  assert.match(screenPage, /等待老師開始/u);
  assert.match(screenPage, /已送出 /u);
  assert.match(screenPage, /原始順位/u);
  assert.match(screenPage, /沒有組別送出/u);
  assert.match(screenPage, /role:'screen'/u);
  assert.match(screenPage, /activity:screen-view/u);
  assert.match(screenPage, /font:30px/u);
  const script = screenPage.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(studentPage, /otherSubmissions/u);
  assert.match(studentPage, /已達上限（跳過）/u);
  const resultRendering = studentPage.split("if(view.stage==='ended'){ ")[1]?.split("if(view.stage==='buzzing')")[0]
    ?? studentPage.split("if(view.stage==='ended'){\n")[1]?.split("if(view.stage==='buzzing')")[0];
  assert.ok(resultRendering);
  assert.match(resultRendering, /result\.answers/u);
  assert.match(resultRendering, /submitted\.group\.name/u);
  assert.doesNotMatch(resultRendering, /submitted\.answer/u);
});

test("teacher page renders buzzing submissions even when an update omits the ranking descriptor", () => {
  const harness = createTeacherPageHarness();
  harness.socketHandlers.get("activity:teacher-view")?.({
    activityCode: "2468", stage: "buzzing", canWriteSpreadsheet: false, questionSetSource: "legacy",
    questionDescriptionsVisible: false,
    groups: [{ id: "group-1", name: "第 1 組", onlineStudentPages: 1 }],
    questions: [{
      number: 7,
      explanation: null,
      subquestions: [{ number: 1 }],
      groups: [{
        groupId: "group-1", groupName: "第 1 組", submitted: true, sequence: 1,
        rank: 1, originalRank: 1, finalRank: 1, successful: true, skipped: false,
        explanation: "", answers: [{ subquestionNumber: 1, answer: "即時答案" }],
      }],
    }],
  });

  const serialize = (element: any): string => `${element.textContent}${element.children.map(serialize).join("")}`;
  assert.match(serialize(harness.elements.get("#view")), /已送出/u);
  assert.match(serialize(harness.elements.get("#view")), /原始順位：1/u);
  assert.match(serialize(harness.elements.get("#view")), /答案：即時答案/u);
  assert.match(serialize(harness.elements.get("#view")), /本題成功組/u);
});
