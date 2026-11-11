import type { CitationSource } from "../types.js";

export function validateCitations(answer: string, sources: CitationSource[]): string {
  return answer.replace(/\[(\d+)\]/g, (match, numberText: string) => {
    const number = Number(numberText);
    return Number.isInteger(number) && number >= 1 && number <= sources.length ? match : "";
  });
}
