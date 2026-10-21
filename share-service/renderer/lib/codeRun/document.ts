import type { RunRecord } from "../../store/useRunStore";
export const outputText = (record: RunRecord): string => record.segs.map(s => s.text).join("").replace(/\s+$/, "");
