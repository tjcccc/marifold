/** Narrow recovery for a short first-person search promise, not a general
 * classifier of whether an answer needs research. Other languages may miss it. */
export function isUnfulfilledSearchPromise(text: string): boolean {
  const reply = text.trim();
  if (reply.length > 600 || /```|^\s*>/m.test(reply)) return false;
  if (/\b(?:cannot|can't|couldn't|unable|don't need|do not need)\b|无法|不能|不需要|无需/i.test(reply)) return false;
  return /\bI\s+(?:need to|must|will|should|have to)\s+(?:first\s+)?(?:search|browse|look up|look into)\b|\b(?:I'll|let me)\s+(?:first\s+)?(?:search|browse|look up|look into)\b/i.test(reply)
    || /(?:我(?:需要|需|得|必须|将|会|要)|让我)(?:先|再|进一步)?(?:搜索|检索|查询|查找|查阅|上网)/.test(reply);
}

export const WEB_RESEARCH_CONTINUATION =
  'Your previous reply said you needed to search but made no tool call. The user requested an answer, not a plan. web_search is available here even though the model has no built-in browsing. Choose a concise query for the latest request and call the tool now if evidence is missing. Then read relevant sources and refine only for remaining gaps, within the existing tool budgets. Otherwise give the supported answer directly. Do not end with another promise to search. Respect tool denials and explicit user restrictions.';
