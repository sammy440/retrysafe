/** Minimal unified diff (line-based LCS), enough for reviewing codemod output. */
export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common prefix/suffix so the LCS table stays small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lcs: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { t: " " | "-" | "+"; line: string };
  const ops: Op[] = a.slice(0, start).map((line) => ({ t: " ", line }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push({ t: " ", line: midA[i]! });
      i++;
      j++;
    } else if (j < midB.length && (i >= midA.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ t: "+", line: midB[j++]! });
    } else {
      ops.push({ t: "-", line: midA[i++]! });
    }
  }
  ops.push(...a.slice(endA).map((line) => ({ t: " " as const, line })));

  // Group changes into hunks with `context` lines around them.
  const out = [`--- a/${file}`, `+++ b/${file}`];
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    let lo = Math.max(0, changed[k]! - context);
    let hi = Math.min(ops.length - 1, changed[k]! + context);
    while (k + 1 < changed.length && changed[k + 1]! - context <= hi + 1) hi = Math.min(ops.length - 1, changed[++k]! + context);
    k++;
    let oldStart = 1;
    let newStart = 1;
    for (let x = 0; x < lo; x++) {
      if (ops[x]!.t !== "+") oldStart++;
      if (ops[x]!.t !== "-") newStart++;
    }
    const hunk = ops.slice(lo, hi + 1);
    const oldLen = hunk.filter((o) => o.t !== "+").length;
    const newLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...hunk.map((o) => `${o.t}${o.line}`));
    lo = hi;
  }
  return `${out.join("\n")}\n`;
}
