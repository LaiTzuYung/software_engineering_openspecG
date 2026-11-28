import assert from "node:assert/strict";
import test from "node:test";
import { studentPage, teacherPage } from "../src/live-buzzer/pages.ts";

test("teacher and student pages render ranking controls, results and no-success reasons", () => {
  assert.match(teacherPage, /id="create"[^>]*>建立活動/u);
  assert.match(teacherPage, /id="create-ranking-rule"[\s\S]*?<option value="speed">純速度<\/option>[\s\S]*?<option value="cap">均分上限<\/option>/u);
  assert.match(teacherPage, /每組最多成功 /u);
  assert.match(teacherPage, /已達上限（跳過）/u);
  assert.match(teacherPage, /原始順位：/u);
  assert.match(teacherPage, /最終順位：/u);
  assert.match(teacherPage, /data\.stage==='preparing'/u);
  assert.match(studentPage, /排名規則：/u);
  assert.match(studentPage, /result\.explanation/u);
  assert.match(studentPage, /view\.stage==='ended'/u);

  for (const page of [teacherPage, studentPage]) {
    const script = page.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  }
  const buzzingRender = studentPage.split("if(view.stage==='buzzing'){")[1]?.split("\n  }\n}\nfunction connectStudent")[0];
  assert.ok(buzzingRender);
  assert.doesNotMatch(buzzingRender, /順位|已達上限|跳過|遞補|成功組|不成功/u);
});
