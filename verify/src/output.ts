/**
 * Output formatters for the verifier CLI.
 *
 * Two modes:
 *   - human (default): one line per visited event, prefixed `OK` or
 *     `FAIL`; a final summary line.
 *   - json (`--json`): a single line of JSON ready for CI consumption.
 */

import type { WalkResult } from "./walk.js";

export interface CliSummary {
  readonly url: string;
  readonly startEventId: string;
  readonly result: WalkResult;
}

export function formatHuman(s: CliSummary): string {
  const lines: string[] = [];
  lines.push(`vanta-verify ${s.url}`);
  lines.push(`start: ${s.startEventId}`);
  for (const p of s.result.progress) {
    if (p.ok) {
      const note = p.reason ? `  (${p.reason})` : "";
      lines.push(`OK   ${p.id} ${p.type}${note}`);
    } else {
      lines.push(`FAIL ${p.id} ${p.type} — ${p.reason ?? "unknown"}`);
    }
  }
  lines.push(`---`);
  lines.push(`depth: ${String(s.result.depth)}`);
  lines.push(`genesis: ${s.result.genesisId ?? "<none>"}`);
  if (s.result.errors.length === 0) {
    lines.push(`status: OK`);
  } else {
    lines.push(`status: FAIL (${String(s.result.errors.length)} errors)`);
    for (const e of s.result.errors) {
      lines.push(`  - ${e.id}: ${e.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatJson(s: CliSummary): string {
  return JSON.stringify({
    url: s.url,
    startEventId: s.startEventId,
    ok: s.result.ok,
    depth: s.result.depth,
    genesisId: s.result.genesisId,
    errors: s.result.errors,
    progress: s.result.progress,
  });
}
