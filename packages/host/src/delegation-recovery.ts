/** Recovery after a child turn exhausted its own stream retries. Never changes route. */
export const MAX_CHILD_RESUMES = 1;

export function canResumeChildFailure(message: string): boolean {
  if (/stopped$|cancel|abort|credential|unauthoriz|forbidden|permission|approval|model.*(?:unavailable|not found)|\b(?:400|401|403|404)\b/i.test(message)) return false;
  return /engine (?:stopped driving|could not be reached)|stopped sending|stream ended unexpectedly|network error|ECONNRESET|ETIMEDOUT|fetch failed|terminated|\b(?:408|429|500|502|503|504|529)\b/i.test(message);
}
