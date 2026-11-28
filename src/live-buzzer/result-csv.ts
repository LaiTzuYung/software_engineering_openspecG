import type { ActivityState } from "./model.ts";
import { getQuestionRanks, getQuestionResults } from "./submissions.ts";

export const RESULT_CSV_HEADERS = [
  "題號", "小題", "組別", "答案", "原始順位", "最終順位", "是否成功", "送出時間", "說明",
] as const;

function escapeCsv(value: string | number): string {
  const valueText = String(value);
  const text = /^[=+\-@\t\r\n]/u.test(valueText) ? `'${valueText}` : valueText;
  return /[,"\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Builds one CSV row per accepted submission subquestion, reusing question-local ranks. */
export function createResultsCsv(activity: ActivityState): string {
  const successfulGroups = new Map(
    getQuestionResults(activity).map(({ questionNumber, successfulGroup }) => [questionNumber, successfulGroup?.id]),
  );
  const rows: { question: number; subquestion: number; rank: number; fields: (string | number)[] }[] = [];
  for (const question of activity.questionSet.questions) {
    const ranks = getQuestionRanks(activity, question.number);
    const submissions = [...(activity.submissions.get(question.number)?.values() ?? [])];
    let hasExportableSubmission = false;
    for (const submission of submissions) {
      const rank = ranks.get(submission.groupId);
      const group = activity.groups.find(({ id }) => id === submission.groupId);
      if (rank === undefined || group === undefined) continue;
      hasExportableSubmission = true;
      for (const subquestion of question.subquestions) {
        rows.push({
          question: question.number,
          subquestion: subquestion.number,
          rank,
          fields: [
            question.number,
            subquestion.number,
            group.name,
            submission.answers[subquestion.number] ?? "",
            rank,
            rank,
            successfulGroups.get(question.number) === submission.groupId ? "是" : "否",
            submission.submittedAt,
            "",
          ],
        });
      }
    }
    if (!hasExportableSubmission) {
      rows.push({
        question: question.number,
        subquestion: 0,
        rank: 0,
        fields: [question.number, "", "", "", "", "", "", "", "沒有組別送出"],
      });
    }
  }
  rows.sort((left, right) => left.question - right.question || left.subquestion - right.subquestion || left.rank - right.rank);
  const csv = [RESULT_CSV_HEADERS, ...rows.map(({ fields }) => fields)]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n");
  return `\uFEFF${csv}\r\n`;
}
