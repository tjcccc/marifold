import { strFromU8, unzipSync } from 'fflate';
import type { OfficeFileKind } from './attachments';

/** Bound the decompressed XML separately from the compressed upload size.
 * This prevents a small, hostile ZIP from expanding without limit. */
const MAX_OFFICE_XML_BYTES = 8 * 1024 * 1024;

export interface ExtractedOfficeText {
  content: string;
  size: number;
  truncated: boolean;
}

export async function extractOfficeText(
  file: File,
  kind: OfficeFileKind,
  maxTextBytes: number,
): Promise<ExtractedOfficeText> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let selectedXmlBytes = 0;
  let expandedLimitExceeded = false;
  const archive = unzipSync(bytes, {
    filter(entry) {
      if (!isRelevantOfficeEntry(kind, entry.name)) return false;
      if (
        !Number.isFinite(entry.originalSize)
        || entry.originalSize < 0
        || selectedXmlBytes + entry.originalSize > MAX_OFFICE_XML_BYTES
      ) {
        expandedLimitExceeded = true;
        return false;
      }
      selectedXmlBytes += entry.originalSize;
      return true;
    },
  });

  if (expandedLimitExceeded) {
    throw new Error(`document XML expands beyond ${MAX_OFFICE_XML_BYTES / (1024 * 1024)} MiB`);
  }

  const extracted = normalizeExtractedText(
    kind === 'word'
      ? extractWordText(archive)
      : kind === 'spreadsheet'
        ? extractSpreadsheetText(archive)
        : extractPresentationText(archive),
  );
  if (!extracted) throw new Error('no readable text was found');

  return truncateUtf8(extracted, maxTextBytes);
}

function isRelevantOfficeEntry(kind: OfficeFileKind, rawName: string): boolean {
  const name = rawName.replaceAll('\\', '/');
  if (kind === 'word') {
    return /^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(name);
  }
  if (kind === 'presentation') return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  return name === 'xl/workbook.xml'
    || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
}

function extractWordText(archive: Record<string, Uint8Array>): string {
  const document = archive['word/document.xml'];
  if (!document) throw new Error('DOCX is missing word/document.xml');
  const paths = Object.keys(archive)
    .filter(path => path.startsWith('word/') && path.endsWith('.xml'))
    .sort((a, b) => wordPartOrder(a) - wordPartOrder(b) || a.localeCompare(b));
  return paths
    .map(path => paragraphText(parseXml(archive[path], path)))
    .filter(Boolean)
    .join('\n\n');
}

function wordPartOrder(path: string): number {
  if (path === 'word/document.xml') return 0;
  if (/word\/header\d+\.xml/.test(path)) return 1;
  if (/word\/footer\d+\.xml/.test(path)) return 2;
  if (path === 'word/footnotes.xml') return 3;
  if (path === 'word/endnotes.xml') return 4;
  return 5;
}

function extractPresentationText(archive: Record<string, Uint8Array>): string {
  const slides = Object.keys(archive)
    .flatMap(path => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
      return match ? [{ path, number: Number(match[1]) }] : [];
    })
    .sort((a, b) => a.number - b.number);
  if (slides.length === 0) throw new Error('PPTX contains no readable slides');
  return slides.map(slide => {
    const text = paragraphText(parseXml(archive[slide.path], slide.path));
    return `Slide ${slide.number}\n${text || '(no text)'}`;
  }).join('\n\n');
}

function extractSpreadsheetText(archive: Record<string, Uint8Array>): string {
  const worksheetPaths = Object.keys(archive)
    .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort(numberedPathOrder);
  if (worksheetPaths.length === 0) throw new Error('XLSX contains no readable worksheets');

  const sharedStrings = parseSharedStrings(archive['xl/sharedStrings.xml']);
  const namedSheets = spreadsheetSheetOrder(archive);
  const sheets = namedSheets.length > 0
    ? namedSheets.filter(sheet => archive[sheet.path])
    : worksheetPaths.map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
  const included = new Set(sheets.map(sheet => sheet.path));
  for (const [index, path] of worksheetPaths.entries()) {
    if (!included.has(path)) sheets.push({ name: `Sheet ${index + 1}`, path });
  }

  return sheets.map(sheet => {
    const document = parseXml(archive[sheet.path], sheet.path);
    const cells = elementsByLocalName(document, 'c').flatMap(cell => {
      const value = spreadsheetCellValue(cell, sharedStrings);
      if (!value) return [];
      return [`${cell.getAttribute('r') || '?'}: ${value}`];
    });
    return `Sheet: ${sheet.name}\n${cells.length > 0 ? cells.join('\n') : '(no populated cells)'}`;
  }).join('\n\n');
}

function parseSharedStrings(bytes: Uint8Array | undefined): string[] {
  if (!bytes) return [];
  const document = parseXml(bytes, 'xl/sharedStrings.xml');
  return elementsByLocalName(document, 'si').map(item =>
    elementsByLocalName(item, 't').map(node => node.textContent ?? '').join(''),
  );
}

function spreadsheetSheetOrder(
  archive: Record<string, Uint8Array>,
): Array<{ name: string; path: string }> {
  const workbookBytes = archive['xl/workbook.xml'];
  const relationshipsBytes = archive['xl/_rels/workbook.xml.rels'];
  if (!workbookBytes || !relationshipsBytes) return [];

  const relationships = new Map(
    elementsByLocalName(parseXml(relationshipsBytes, 'xl/_rels/workbook.xml.rels'), 'Relationship')
      .flatMap(element => {
        const id = element.getAttribute('Id');
        const target = element.getAttribute('Target');
        return id && target ? [[id, resolveWorkbookTarget(target)] as const] : [];
      }),
  );
  return elementsByLocalName(parseXml(workbookBytes, 'xl/workbook.xml'), 'sheet').flatMap(sheet => {
    const relationshipId = Array.from(sheet.attributes).find(attribute => attribute.localName === 'id')?.value;
    const path = relationshipId ? relationships.get(relationshipId) : undefined;
    return path ? [{ name: sheet.getAttribute('name') || 'Sheet', path }] : [];
  });
}

function resolveWorkbookTarget(target: string): string {
  const raw = target.replaceAll('\\', '/');
  const parts = (raw.startsWith('/') ? raw.slice(1) : `xl/${raw}`).split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function spreadsheetCellValue(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute('t');
  const rawValue = firstElementByLocalName(cell, 'v')?.textContent ?? '';
  const formula = firstElementByLocalName(cell, 'f')?.textContent?.trim();
  let value = rawValue;
  if (type === 's') value = sharedStrings[Number(rawValue)] ?? rawValue;
  else if (type === 'inlineStr') {
    value = elementsByLocalName(cell, 't').map(node => node.textContent ?? '').join('');
  } else if (type === 'b') value = rawValue === '1' ? 'TRUE' : 'FALSE';

  value = value.trim().replace(/\s*\n+\s*/g, ' / ');
  if (!formula) return value;
  return value ? `=${formula} (value: ${value})` : `=${formula}`;
}

function paragraphText(document: Document): string {
  const paragraphs = elementsByLocalName(document, 'p');
  if (paragraphs.length === 0) {
    return elementsByLocalName(document, 't').map(node => node.textContent ?? '').join('');
  }
  return paragraphs.map(paragraph => inlineParagraphText(paragraph).trim()).filter(Boolean).join('\n');
}

function inlineParagraphText(element: Element): string {
  let output = '';
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== 1) continue;
    const childElement = child as Element;
    if (childElement.localName === 't') output += childElement.textContent ?? '';
    else if (childElement.localName === 'tab') output += '\t';
    else if (childElement.localName === 'br' || childElement.localName === 'cr') output += '\n';
    else output += inlineParagraphText(childElement);
  }
  return output;
}

function parseXml(bytes: Uint8Array, path: string): Document {
  const document = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (elementsByLocalName(document, 'parsererror').length > 0) {
    throw new Error(`invalid XML in ${path}`);
  }
  return document;
}

function elementsByLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter(element => element.localName === name);
}

function firstElementByLocalName(root: Element, name: string): Element | undefined {
  return elementsByLocalName(root, name)[0];
}

function numberedPathOrder(a: string, b: string): number {
  const number = (value: string) => Number(/(\d+)\.xml$/.exec(value)?.[1] ?? 0);
  return number(a) - number(b) || a.localeCompare(b);
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): ExtractedOfficeText {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) {
    return { content: value, size: encoded.length, truncated: false };
  }
  const suffix = '\n\n[Office extraction truncated to fit the attachment text limit.]';
  const suffixBytes = new TextEncoder().encode(suffix);
  let prefix = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - suffixBytes.length)));
  let content = `${prefix}${suffix}`;
  let contentBytes = new TextEncoder().encode(content);
  // A byte slice can end in the middle of a multi-byte code point; TextDecoder
  // replaces it with U+FFFD (three bytes), so trim that tiny possible overrun.
  while (contentBytes.length > maxBytes && prefix.length > 0) {
    prefix = prefix.slice(0, -1);
    content = `${prefix}${suffix}`;
    contentBytes = new TextEncoder().encode(content);
  }
  return { content, size: contentBytes.length, truncated: true };
}
