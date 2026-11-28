import type { PlannedSpreadsheetAnswer } from "../guided-notes/spreadsheet-export-validation.ts";
import type { ActivityState } from "./model.ts";
import { calculateRankingResults } from "./submissions.ts";

/** Builds writes only from each question's first accepted group submission. */
export function successfulAnswersForExport(activity: ActivityState): readonly PlannedSpreadsheetAnswer[] {
  const answers: PlannedSpreadsheetAnswer[] = [];
  for (const result of calculateRankingResults(activity).questions) {
    if (result.successfulGroup === null || result.answers === null) continue;
    for (const [subquestionNumber, answer] of Object.entries(result.answers)) {
      answers.push({
        questionNumber: result.questionNumber,
        subquestionNumber: Number(subquestionNumber),
        answer,
      });
    }
  }
  return answers;
}
