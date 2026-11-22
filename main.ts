// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A line of a replacement: `ctx` is its index in the old lines when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/** A body line of a unified hunk or a V4A chunk: `empty` marks a literally empty patch line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Split a file's text into its line break, its lines and whether it ends with a break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function keyAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  const keys = old.map((l) => keyAt(l, tier));
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (keyAt(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; only 0 when strict) at which `old` occurs, with its positions. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

function findTierFrom(lines: string[], old: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier).filter((p) => p >= from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` at the first tier where one is (single-line matching). */
function findSingle(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const key = keyAt(anchor, tier);
    for (let i = from; i < lines.length; i += 1) {
      if (keyAt(lines[i]!, tier) === key) return i;
    }
  }
  return -1;
}

/** Build the lines that replace a match: context lines come from the file, other lines re-indent at tier 2. */
function replaced(file: string[], pos: number, old: string[], next: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const f = pos < file.length ? leadWs(file[pos]!) : '';
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  for (const item of next) {
    if (item.ctx >= 0) {
      out.push(file[pos + item.ctx]!);
      continue;
    }
    const line = item.text;
    if (tier === 2 && !/^[ \t]*$/.test(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** Split a hunk body into its old lines, its new lines, and whether a `\` line follows its last context/`+` line. */
function hunkParts(h: Hunk): { old: string[]; next: NewLine[]; backslash: boolean; hasOut: boolean } {
  const old: string[] = [];
  const next: NewLine[] = [];
  let lastOut = -1;
  for (let k = 0; k < h.body.length; k += 1) {
    const b = h.body[k]!;
    if (b.kind === ' ') {
      old.push(b.text);
      next.push({ text: b.text, ctx: old.length - 1 });
      lastOut = k;
    } else if (b.kind === '-') {
      old.push(b.text);
    } else if (b.kind === '+') {
      next.push({ text: b.text, ctx: -1 });
      lastOut = k;
    }
  }
  return { old, next, backslash: lastOut >= 0 && h.body[lastOut + 1]?.kind === '\\', hasOut: lastOut >= 0 };
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const st = splitFile(content);
  const lines = st.lines;
  let d = 0;
  for (const h of hunks) {
    const { old, next, backslash, hasOut } = hunkParts(h);
    if (old.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      if (at === lines.length) st.final = hasOut ? !backslash : true;
      lines.splice(at, 0, ...replaced(lines, at, old, next, 0));
      d += next.length;
      continue;
    }
    const found = findTier(lines, old, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    if (best + old.length === lines.length) st.final = hasOut ? !backslash : true;
    lines.splice(best, old.length, ...replaced(lines, best, old, next, found.tier));
    d += next.length - old.length;
  }
  return joinFile(lines, st.br, st.final);
}

/** The `+` lines of a creation section's hunks, with its final line break (SPEC.md section 6). */
function creationContent(hunks: Hunk[]): string {
  const plus: string[] = [];
  let lastSlash = false;
  let seen = false;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k += 1) {
      const b = h.body[k]!;
      if (b.kind === '+') {
        plus.push(b.text);
        seen = true;
        lastSlash = h.body[k + 1]?.kind === '\\';
      }
    }
  }
  if (!seen) return '';
  return plus.join('\n') + (lastSlash ? '' : '\n');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old path, new path) pairs, in patch order. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push((tree: Tree) => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (oldLines.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, joinFile(newLines, '\n', true));
        return;
      }
      const cur = tree.get(path!);
      if (cur === null) throw new Fail('missing', path!);
      const st = splitFile(cur);
      const found = findTier(st.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path!);
      if (found.at.length > 1) throw new Fail('ambiguous', path!);
      const pos = found.at[0]!;
      const repLines = replaced(st.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
      st.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(path!, joinFile(st.lines, st.br, st.final));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const kindOf = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = kindOf(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const headerNo = i + 1;
    const bodyStart = i + 1;
    let j = bodyStart;
    while (j < end && kindOf(lines[j]!) === null) j += 1;
    const body = lines.slice(bodyStart, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(fileLines, '\n', true));
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      interface Chunk {
        anchor: string | null;
        eof: boolean;
        old: string[];
        next: NewLine[];
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (let k = 0; k < body.length; k += 1) {
        const bl = body[k]!;
        const lineNo = bodyStart + k + 1;
        if (k === 0 && bl.startsWith('*** Move to:')) {
          moveTo = bl.slice('*** Move to:'.length).trim();
          continue;
        }
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, old: [], next: [] };
          chunks.push(cur);
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, old: [], next: [] };
            chunks.push(cur);
          }
          if (bl === '') {
            cur.old.push('');
            cur.next.push({ text: '', ctx: cur.old.length - 1 });
          } else if (bl[0] === ' ') {
            cur.old.push(bl.slice(1));
            cur.next.push({ text: bl.slice(1), ctx: cur.old.length - 1 });
          } else if (bl[0] === '-') {
            cur.old.push(bl.slice(1));
          } else {
            cur.next.push({ text: bl.slice(1), ctx: -1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const st = splitFile(curText);
        const fileLines = st.lines;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const at = findSingle(fileLines, ch.anchor, cursor, strict);
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          if (ch.old.length === 0) {
            const at = ch.eof ? fileLines.length : cursor;
            const ins = replaced(fileLines, at, ch.old, ch.next, 0);
            fileLines.splice(at, 0, ...ins);
            cursor = at + ins.length;
            continue;
          }
          const found = findTierFrom(fileLines, ch.old, cursor, strict);
          if (found === null) throw new Fail('no-match', path);
          let pos = -1;
          for (const p of found.at) {
            if (ch.eof && p + ch.old.length !== fileLines.length) continue;
            pos = p;
            break;
          }
          if (pos < 0) throw new Fail('no-match', path);
          const repLines = replaced(fileLines, pos, ch.old, ch.next, found.tier);
          fileLines.splice(pos, ch.old.length, ...repLines);
          cursor = pos + repLines.length;
        }
        const out = joinFile(fileLines, st.br, st.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Section {
    oldRaw: string | null;
    newRaw: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    newFile: boolean;
    delFile: boolean;
    hunks: Hunk[];
  }
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => {
    let p = line.slice(4);
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    return stripAB(p.trim());
  };
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let pairSeen = false;
  const startSection = (): Section => {
    const s: Section = { oldRaw: null, newRaw: null, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    pairSeen = false;
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairSeen) {
        cur.oldRaw = headerPath(line);
        cur.newRaw = headerPath(lines[i + 1]!);
        pairSeen = true;
      } else {
        const s = startSection();
        s.oldRaw = headerPath(line);
        s.newRaw = headerPath(lines[i + 1]!);
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('diff --git ')) break;
        if (bl === '') {
          hunk.body.push({ kind: ' ', text: '', empty: true });
          i += 1;
        } else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          hunk.body.push({ kind: bl[0] as BodyLine['kind'], text: bl.slice(1), empty: false });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldPath = s.oldRaw ?? s.renameFrom ?? s.diffOld ?? '';
    const newPath = s.newRaw ?? s.renameTo ?? s.diffNew ?? '';
    const isCreate = s.newFile || oldPath === '/dev/null';
    const isDelete = !isCreate && (s.delFile || newPath === '/dev/null');
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    return (tree: Tree) => {
      if (isCreate) {
        if (newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, creationContent(s.hunks));
        return;
      }
      if (isDelete) {
        if (oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
      const curText = tree.get(oldPath);
      if (curText === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = s.hunks.length === 0 ? curText : applyHunks(curText, s.hunks, strict, oldPath);
      if (isMove) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mv = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = mv;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(nw) === null && tree.now.get(nw) !== null) {
      if (!used.has(`D:${o}`) && !used.has(`A:${nw}`)) {
        used.add(`D:${o}`);
        used.add(`A:${nw}`);
        rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      }
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    if (!used.has(`${tag}:${p}`)) rows.push({ key: p, line: `${tag} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
