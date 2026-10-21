import { tr } from './i18n/core.ts';
// Pure source transformations shared by desktop publication and its tests.
import { Text } from '@codemirror/state';
import { parser, GFM } from '@lezer/markdown';
import type { SyntaxNodeRef } from '@lezer/common';
import { scanSecrets } from './lib/crypto/secretBlock.ts';
import { parseImageDest } from './lib/imageSyntax.ts';
import { detailsBlock } from './lib/codemirror/detailsBlock.ts';
export const REDACTED_SECRET = '加密内容未公开';
export function redactSecrets(source: string): string {
  const doc = Text.of(source.split('\n'));
  const secrets = scanSecrets(doc);
  for (const secret of [...secrets].sort((a,b) => b.from-a.from)) source = source.slice(0,secret.from)+tr(REDACTED_SECRET)+source.slice(secret.to);
  return source;
}
export interface ResourceReference { from: number; to: number; source: string }
interface Range { from: number; to: number }
const local = (src: string) => !!src && !/^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,|#|mailto:|tel:)/i.test(src);
const CODE = ['FencedCode','CodeBlock','InlineCode'];
// CommonMark label matching: case-insensitive with collapsed whitespace.
const normalizeLabel = (label: string) => label.trim().replace(/\s+/g,' ').toLowerCase();
// Label of a reference-style link or image (`[t][label]`, `[label][]`, `[label]`); inline links have none.
function usedLabel(node: SyntaxNodeRef, text: string): string | null {
  if ((node.name!=='Link'&&node.name!=='Image') || node.node.getChild('URL')) return null;
  const marks=node.node.getChildren('LinkMark'), label=node.node.getChild('LinkLabel');
  if (marks.length<2) return null;
  return normalizeLabel(label&&label.to-label.from>2?text.slice(label.from+1,label.to-1):text.slice(marks[0].to,marks[1].from));
}
function scanMarkdown(source: string) {
  const code: Range[] = [], htmlBlocks: Range[] = [], commentBlocks: Range[] = [], comments: Range[] = [], labels: {at:number;label:string}[] = [];
  parser.configure([GFM,detailsBlock]).parse(source).iterate({enter(node) {
    if (CODE.includes(node.name)) { code.push({from:node.from,to:node.to}); return false; }
    if (node.name==='HTMLBlock') htmlBlocks.push({from:node.from,to:node.to});
    if (node.name==='CommentBlock') commentBlocks.push({from:node.from,to:node.to});
    if (node.name==='Comment') comments.push({from:node.from,to:node.to});
    const label=usedLabel(node,source); if (label!==null) labels.push({at:node.from,label});
  }});
  // Details widgets render Markdown inside HTML blocks. Reparse that content
  // with tag positions masked so code examples inside disclosures stay private.
  for(const block of htmlBlocks){
    const masked=source.slice(block.from,block.to).replace(/<[^>]*>/g,tag=>tag.replace(/[^\n]/g,'\u200b'));
    parser.configure([GFM]).parse(masked).iterate({enter(node){
      if(CODE.includes(node.name)){code.push({from:block.from+node.from,to:block.from+node.to});return false;}
      const label=usedLabel(node,masked); if (label!==null) labels.push({at:block.from+node.from,label});
    }});
  }
  return {code,htmlBlocks,commentBlocks,comments,labels};
}
/** Remove HTML comments outside code. They never render, so the author does
 *  not see them in the preview, yet the published source would expose them. */
export function stripHtmlComments(source: string): { markdown: string; removed: number } {
  const {code,htmlBlocks,commentBlocks,comments}=scanMarkdown(source), found=[...comments];
  // Inside raw HTML a comment hides text up to `-->`, or to the block end when unterminated.
  for(const block of [...htmlBlocks,...commentBlocks])for(const match of source.slice(block.from,block.to).matchAll(/<!--(?:>|->|[\s\S]*?(?:-->|$))/g))found.push({from:block.from+match.index!,to:block.from+match.index!+match[0].length});
  const removed=found.filter(r=>!code.some(c=>r.from<c.to&&r.to>c.from)).sort((a,b)=>b.from-a.from);
  for(const r of removed)source=source.slice(0,r.from)+source.slice(r.to);
  return {markdown:source,removed:removed.length};
}
export function resourceReferences(source: string): ResourceReference[] {
  const references: ResourceReference[] = [], {code,labels}=scanMarkdown(source), excluded: Range[] = [...code];
  for(const match of source.matchAll(/<(pre|code|script|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi))excluded.push({from:match.index!,to:match.index!+match[0].length});
  const hidden = (at:number) => excluded.some(r=>at>=r.from && at<r.to);
  const used = new Set(labels.filter(l=>!hidden(l.at)).map(l=>l.label));
  const add = (from:number,to:number) => {
    if (hidden(from)) return;
    const raw=source.slice(from,to);
    if (local(raw) && !references.some(r=>r.from===from)) references.push({from,to,source:raw});
  };
  // Match destinations rather than labels, preserving source formatting and
  // Idea Note's permissive spaces/explicit-size image syntax.
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const raw=match[1], parsed=parseImageDest(raw), dest=parsed.dest.startsWith('<')&&parsed.dest.endsWith('>')?parsed.dest.slice(1,-1):parsed.dest;
    const start=match.index!+match[0].indexOf('](')+2+raw.indexOf(dest);
    if (dest && raw.includes(dest)) add(start,start+dest.length);
  }
  // A definition no link or image uses is invisible when rendered; never upload its target.
  for (const match of source.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>]+>|\S+)/gm)) {
    if (!used.has(normalizeLabel(match[1]))) continue;
    const raw=match[2], unwrapped=raw.startsWith('<')?raw.slice(1,-1):raw;
    const start=match.index!+match[0].lastIndexOf(raw)+(raw.startsWith('<')?1:0); add(start,start+unwrapped.length);
  }
  // Only inspect HTML tags; a prose string such as src="notes.txt" is not a resource.
  for (const tag of source.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const match of tag[0].matchAll(/\b(?:src|href|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const raw=match[1]??match[2]??match[3], start=tag.index!+match.index!+match[0].indexOf('=')+1;
      const at=source.indexOf(raw,start);add(at,at+raw.length);
    }
    for (const attr of tag[0].matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const raw=attr[1]??attr[2], offset=tag.index!+attr.index!+attr[0].indexOf(raw);
      for(const candidate of raw.matchAll(/(?:^|,)\s*([^\s,]+)/g)){
        const start=offset+candidate.index!+candidate[0].lastIndexOf(candidate[1]);add(start,start+candidate[1].length);
      }
    }
    for (const match of tag[0].matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) {
      const start=tag.index!+match.index!+match[0].indexOf(match[1]);add(start,start+match[1].length);
    }
  }
  return references.sort((a,b)=>a.from-b.from);
}
export function replaceResources(source: string, references: ResourceReference[], urls: Map<string,string>): string {
  for(const ref of [...references].sort((a,b)=>b.from-a.from)) {
    const value=urls.get(ref.source); if(value)source=source.slice(0,ref.from)+value+source.slice(ref.to);
  }
  return source;
}
