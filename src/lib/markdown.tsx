import {Fragment, type ReactNode, useMemo} from 'react';

/**
 * A small Markdown subset rendered as React elements. It never builds an HTML string and never uses
 * dangerouslySetInnerHTML: every piece of text reaches the DOM as a React text child (escaped by React), and the
 * only attribute values taken from the input are link hrefs that passed `safeUrl` (http, https, mailto).
 *
 * Supported: paragraphs, line breaks, **bold**, *italic*, `code`, fenced code, bullet / numbered lists,
 * task items (display only), blockquotes, [links](url), auto-links, `#`..`######` headings (shown as a bold
 * block with no heading role, so the panel's outline stays intact) and \ escapes. Everything else is text.
 *
 * Limits keep a hostile or huge input cheap: the source is cut at MAX_SOURCE, at most MAX_BLOCKS blocks,
 * MAX_ITEMS list items, nesting depth MAX_DEPTH, and a closing marker is only searched within WINDOW characters.
 */
export const MAX_SOURCE = 20_000;
const MAX_BLOCKS = 400;
const MAX_ITEMS = 200;
const MAX_DEPTH = 4;
const WINDOW = 2_000;
const MAX_URL = 2_048;
/** Character comparisons all closer searches of one document may spend; beyond it markers stay plain text. */
const SCAN_BUDGET = 200_000;

type Budget = {left: number};
/** Charges `cost` to the budget; false (and nothing searched) once it is spent. */
const spend = (b: Budget, cost: number): boolean => {
  if (b.left <= 0) return false;
  b.left -= Math.max(1, cost);
  return true;
};

/** Bidi controls and zero-width / invisible characters: removed so text cannot be visually reordered or spoofed. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function cleanText(source: string): string {
  return source.slice(0, MAX_SOURCE).replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(CONTROL, '');
}

/** The href for a link target, or null. Only absolute http, https and mailto; no credentials in http(s). */
export function safeUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL) return null;
  // The scheme must be written out: relative, protocol-relative and "javascript:"-style targets are refused.
  if (!/^(?:https?:\/\/|mailto:)/i.test(text)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007F-\u009F\u2028\u2029<>"`\\]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.username || url.password || !url.hostname) return null;
    } else if (url.protocol !== 'mailto:') return null;
    else if (!url.pathname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ inline */

export type Inline =
  | {t: 'text'; v: string}
  | {t: 'br'}
  | {t: 'code'; v: string}
  | {t: 'strong'; c: Inline[]}
  | {t: 'em'; c: Inline[]}
  | {t: 'link'; href: string; c: Inline[]}
  | {t: 'mention'; v: string};

const ESCAPABLE = '\\`*_[]()#>-+.!@<>~|{}';
const TRAILING = /[.,;:!?)\]}'"]/;

function parseInline(src: string, mentions: string[], budget: Budget, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({t: 'text', v: buf});
    buf = '';
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      flush();
      out.push({t: 'br'});
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < n && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = budget.left > 0 ? src.indexOf(fence, i + run) : -1;
      spend(budget, end === -1 ? n - i : end - i);
      if (end !== -1 && end - i <= WINDOW && src.slice(end + run, end + run + 1) !== '`' && end > i + run) {
        flush();
        out.push({t: 'code', v: src.slice(i + run, end).replace(/\n/g, ' ')});
        i = end + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }
    if ((ch === '*' || ch === '_') && depth < MAX_DEPTH) {
      const double = src[i + 1] === ch;
      const mark = double ? ch + ch : ch;
      const start = i + mark.length;
      // `_` only at a word edge, so snake_case_names stay text.
      const edgeOk = ch === '*' || i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1]);
      if (edgeOk && start < n && !/\s/.test(src[start])) {
        let end = start;
        let found = -1;
        while (end < n && end - start <= WINDOW && spend(budget, 1)) {
          const at = src.indexOf(mark, end);
          spend(budget, at === -1 ? Math.min(n - end, WINDOW) : at - end);
          if (at === -1 || at - start > WINDOW) break;
          const prev = src[at - 1];
          const next = src[at + mark.length];
          const closes = at > start && !/\s/.test(prev) && (ch === '*' || !next || !/[\p{L}\p{N}]/u.test(next)) && (double || next !== ch) && (double || prev !== ch);
          if (closes) {
            found = at;
            break;
          }
          end = at + 1;
        }
        if (found !== -1) {
          flush();
          const kids = parseInline(src.slice(start, found), mentions, budget, depth + 1, inLink);
          out.push({t: double ? 'strong' : 'em', c: kids});
          i = found + mark.length;
          continue;
        }
      }
      buf += mark;
      i += mark.length;
      continue;
    }
    if (ch === '[' && !inLink && depth < MAX_DEPTH) {
      // Matching `]` with nested brackets, then `(url)` with balanced parentheses.
      let level = 0;
      let close = -1;
      for (let j = i; j < n && j - i <= WINDOW; j++) {
        if ((j - i) % 64 === 0 && !spend(budget, 64)) break;
        const c = src[j];
        if (c === '\\') j++;
        else if (c === '[') level++;
        else if (c === ']' && --level === 0) {
          close = j;
          break;
        }
      }
      if (close !== -1 && src[close + 1] === '(') {
        let paren = 0;
        let end = -1;
        for (let j = close + 1; j < n && j - close <= MAX_URL + 2; j++) {
          if ((j - close) % 64 === 0 && !spend(budget, 64)) break;
          const c = src[j];
          if (c === '(') paren++;
          else if (c === ')' && --paren === 0) {
            end = j;
            break;
          }
          else if (c === '\n') break;
        }
        if (end !== -1) {
          const href = safeUrl(src.slice(close + 2, end));
          const label = src.slice(i + 1, close);
          flush();
          if (href) out.push({t: 'link', href, c: parseInline(label, mentions, budget, depth + 1, true)});
          else out.push(...parseInline(label, mentions, budget, depth + 1, true));
          i = end + 1;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }
    if ((ch === 'h' || ch === 'H') && !inLink && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1]))) {
      const match = /^[^\s<>"'`\\]+/.exec(src.slice(i, i + MAX_URL + 1));
      if (match) {
        let raw = match[0];
        // Trailing punctuation is not part of the link; a closing bracket is only when it has its opener inside.
        const count = (text: string, c: string) => text.split(c).length - 1;
        while (TRAILING.test(raw.slice(-1))) {
          const last = raw.slice(-1);
          const opener = {')': '(', ']': '[', '}': '{'}[last as ')'];
          if (opener && count(raw, last) <= count(raw, opener)) break;
          raw = raw.slice(0, -1);
        }
        const href = safeUrl(raw);
        if (href) {
          flush();
          out.push({t: 'link', href, c: [{t: 'text', v: raw}]});
          i += raw.length;
          continue;
        }
      }
    }
    if (ch === '@' && mentions.length) {
      // Longest name first (parseMarkdown sorts), and the name must end the word: "@Ann" is not inside "@Annabel".
      const name = mentions.find(m => src.startsWith(m, i + 1) && !/[\p{L}\p{N}_]/u.test(src.charAt(i + 1 + m.length)));
      if (name) {
        flush();
        out.push({t: 'mention', v: `@${name}`});
        i += 1 + name.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ blocks */

export type Block =
  | {t: 'p'; c: Inline[]}
  | {t: 'heading'; level: 3 | 4 | 5; c: Inline[]}
  | {t: 'code'; v: string; lang: string}
  | {t: 'quote'; c: Inline[]}
  | {t: 'list'; ordered: boolean; start: number; items: {task: null | boolean; c: Inline[]}[]};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,30})[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const ITEM = /^ {0,3}(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

export function parseMarkdown(source: string, mentions: string[] = []): Block[] {
  const names = [...new Set(mentions.filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 100);
  const lines = cleanText(source).split('\n');
  const budget: Budget = {left: SCAN_BUDGET};
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark) && lines[i].trim().replace(new RegExp(`^${mark[0]}+`), '') === '')) body.push(lines[i++]);
      i++;
      blocks.push({t: 'code', v: body.join('\n'), lang: fence[2]});
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({t: 'heading', level: Math.min(5, Math.max(3, heading[1].length + 2)) as 3 | 4 | 5, c: parseInline(heading[2], names, budget)});
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({t: 'quote', c: parseInline(quoted.join('\n'), names, budget)});
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const start = ordered ? Number(item[2]) : 1;
      const items: {task: null | boolean; c: Inline[]}[] = [];
      while (i < lines.length && items.length < MAX_ITEMS) {
        const m = ITEM.exec(lines[i]);
        if (!m || (m[2] !== undefined) !== ordered) break;
        let text = m[3];
        let task: null | boolean = null;
        const box = /^\[([ xX])\][ \t]+(.*)$/.exec(text);
        if (box && !ordered) {
          task = box[1] !== ' ';
          text = box[2];
        }
        i++;
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !ITEM.test(lines[i])) text += `\n${lines[i++].trim()}`;
        items.push({task, c: parseInline(text, names, budget)});
      }
      while (i < lines.length && ITEM.test(lines[i]) && (ITEM.exec(lines[i])![2] !== undefined) === ordered) i++; // over the cap: dropped
      blocks.push({t: 'list', ordered, start, items});
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !(para.length && ITEM.test(lines[i]))) para.push(lines[i++].trim());
    blocks.push({t: 'p', c: parseInline(para.join('\n'), names, budget)});
  }
  return blocks;
}

/* ------------------------------------------------------------------ render */

export type MarkdownLabels = {taskDone: string; taskOpen: string};
const DEFAULT_LABELS: MarkdownLabels = {taskDone: 'Done', taskOpen: 'Not done'};

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, key) => {
    switch (node.t) {
      case 'text':
        return <Fragment key={key}>{node.v}</Fragment>;
      case 'br':
        return <br key={key} />;
      case 'code':
        return <code key={key}>{node.v}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(node.c)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.c)}</em>;
      case 'mention':
        return (
          <strong key={key} className="cd-mention">
            {node.v}
          </strong>
        );
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.c)}
          </a>
        );
    }
  });
}

export function renderBlocks(blocks: Block[], labels: MarkdownLabels = DEFAULT_LABELS): ReactNode {
  return blocks.map((block, key) => {
    switch (block.t) {
      case 'p':
        return <p key={key}>{renderInline(block.c)}</p>;
      case 'heading':
        // A styled bold block, never h1..h6: the panel owns the outline.
        return (
          <div key={key} role="none" className={`md-heading md-h${block.level}`}>
            {renderInline(block.c)}
          </div>
        );
      case 'code':
        return (
          <pre key={key}>
            <code>{block.v}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={key}>{renderInline(block.c)}</blockquote>;
      case 'list': {
        const items = block.items.map((item, k) => (
          <li key={k} className={item.task === null ? undefined : 'md-task'}>
            {item.task !== null && <input type="checkbox" checked={item.task} readOnly disabled tabIndex={-1} aria-label={item.task ? labels.taskDone : labels.taskOpen} />}
            <span>{renderInline(item.c)}</span>
          </li>
        ));
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
    }
  });
}

/** `<Markdown source=… mentions={['Ada Lovelace']} />`: the rendered text, ready for a card description or comment. */
export function Markdown({source, mentions, labels, className}: {source: string; mentions?: string[]; labels?: MarkdownLabels; className?: string}) {
  const key = mentions?.join('\u0000') ?? '';
  const blocks = useMemo(() => parseMarkdown(source, key ? key.split('\u0000') : []), [source, key]);
  return <div className={className ? `md ${className}` : 'md'}>{renderBlocks(blocks, labels)}</div>;
}
