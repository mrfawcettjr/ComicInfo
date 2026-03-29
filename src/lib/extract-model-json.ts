/**
 * Strips optional markdown fences so JSON.parse succeeds when models wrap output.
 */
export function extractJsonFromModelOutput(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  return trimmed;
}
