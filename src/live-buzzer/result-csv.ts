import type { ActivityState } from "./model.ts";
import { calculateRankingResults } from "./submissions.ts";

export const RESULT_CSV_HEADERS = [
  "題號", "小題", "組別", "答案", "原始順位", "最終順位", "是否成功", "送出時間", "說明",
] as const;

/** Formats a server ISO timestamp as Taiwan local time without changing stored submission data. */
export function formatCsvSubmittedAt(submittedAt: string): string {
  const timestamp = Date.parse(submittedAt);
  if (!Number.isFinite(timestamp)) throw new RangeError("提交時間不是有效的 ISO 時間。");
  return `${new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`;
}

function escapeCsv(value: string | number): string {
  const valueText = String(value);
  const text = /^[=+\-@\t\r\n]/u.test(valueText) ? `'${valueText}` : valueText;
  return /[,"\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Builds one CSV row per accepted submission subquestion, reusing question-local ranks. */
export function createResultsCsv(activity: ActivityState): string {
  const ranking = calculateRankingResults(activity);
  const rankedBySequence = new Map(ranking.submissions.map((result) => [result.submission.sequence, result]));
  const rows: { question: number; subquestion: number; rank: number; fields: (string | number)[] }[] = [];
  for (const question of activity.questionSet.questions) {
    const submissions = [...(activity.submissions.get(question.number)?.values() ?? [])];
    let hasExportableSubmission = false;
    for (const submission of submissions) {
      const result = rankedBySequence.get(submission.sequence);
      const group = activity.groups.find(({ id }) => id === submission.groupId);
      if (result === undefined || group === undefined) continue;
      hasExportableSubmission = true;
      for (const subquestion of question.subquestions) {
        rows.push({
          question: question.number,
          subquestion: subquestion.number,
          rank: result.originalRank,
          fields: [
            question.number,
            subquestion.number,
            group.name,
            submission.answers[subquestion.number] ?? "",
            result.originalRank,
            result.finalRank ?? "",
            result.successful ? "是" : "否",
            formatCsvSubmittedAt(submission.submittedAt),
            result.explanation,
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
