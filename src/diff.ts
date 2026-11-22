// Line diff (longest common subsequence) for the history viewer.

export interface DiffLine {
  type: 'eq' | 'add' | 'del';
  text: string;
}

/** Returns null when the files are too different/large to diff cheaply (caller shows the plain text). */
export function diffLines(a: string[], b: string[], maxCells = 4_000_000): DiffLine[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA), B = b.slice(start, endB);
  const n = A.length, m = B.length;
  if ((n + 1) * (m + 1) > maxCells) return null;

  // lcs[i][j] = length of the LCS of A[i..] and B[j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'eq' as const, text }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'eq', text: A[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ type: 'del', text: A[i++] });
    else out.push({ type: 'add', text: B[j++] });
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  for (const text of a.slice(endA)) out.push({ type: 'eq', text });
  return out;
}
