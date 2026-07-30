'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'Altegro_Phase1_Status_Report_2026-07-30.md');
const outputPath = path.join(__dirname, 'Altegro_Phase1_Status_Report_2026-07-30.pdf');
const markdown = fs.readFileSync(sourcePath, 'utf8');

function cleanInline(value) {
  return value
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?')
    .trim();
}

function wrapText(text, limit) {
  const words = cleanInline(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= limit) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const blocks = [];
for (const raw of markdown.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) { blocks.push({ type: 'space' }); continue; }
  if (line.startsWith('### ')) blocks.push({ type: 'h3', text: line.slice(4) });
  else if (line.startsWith('## ')) blocks.push({ type: 'h2', text: line.slice(3) });
  else if (line.startsWith('# ')) blocks.push({ type: 'h1', text: line.slice(2) });
  else if (/^- /.test(line)) blocks.push({ type: 'bullet', text: line.slice(2) });
  else if (/^\d+\. /.test(line)) blocks.push({ type: 'number', text: line });
  else blocks.push({ type: 'body', text: line.replace(/  $/, '') });
}

const pages = [];
let page;
let y;

function startPage() {
  page = [];
  pages.push(page);
  page.push({ kind: 'rect', x: 0, y: 816, width: 595, height: 26, color: [0.914, 0.184, 0.510] });
  page.push({ kind: 'text', text: 'ALTEGRO  |  PHASE 1 STATUS', x: 48, y: 825, size: 8, font: 'bold', color: [1, 1, 1] });
  y = 790;
}

function ensureSpace(required) {
  if (y - required < 55) startPage();
}

function addTextLines(lines, options) {
  const { x, size, font, color, lineHeight, after } = options;
  ensureSpace(lines.length * lineHeight + after);
  for (const text of lines) {
    page.push({ kind: 'text', text, x, y, size, font, color });
    y -= lineHeight;
  }
  y -= after;
}

startPage();
let previousWasSpace = false;
for (const block of blocks) {
  if (block.type === 'space') {
    if (!previousWasSpace) y -= 4;
    previousWasSpace = true;
    continue;
  }
  previousWasSpace = false;
  if (block.type === 'h1') addTextLines(wrapText(block.text, 52), { x: 48, size: 22, font: 'bold', color: [0.914, 0.184, 0.510], lineHeight: 27, after: 12 });
  else if (block.type === 'h2') addTextLines(wrapText(block.text, 65), { x: 48, size: 15, font: 'bold', color: [0.09, 0.067, 0.086], lineHeight: 19, after: 7 });
  else if (block.type === 'h3') addTextLines(wrapText(block.text, 78), { x: 48, size: 11.5, font: 'bold', color: [0.66, 0.07, 0.33], lineHeight: 15, after: 4 });
  else if (block.type === 'bullet') {
    const lines = wrapText(block.text, 88);
    lines[0] = `- ${lines[0]}`;
    addTextLines(lines, { x: 62, size: 9.3, font: 'regular', color: [0.09, 0.067, 0.086], lineHeight: 12.3, after: 2 });
  } else if (block.type === 'number') addTextLines(wrapText(block.text, 90), { x: 58, size: 9.3, font: 'regular', color: [0.09, 0.067, 0.086], lineHeight: 12.3, after: 2 });
  else addTextLines(wrapText(block.text, 96), { x: 48, size: 9.3, font: 'regular', color: [0.18, 0.14, 0.17], lineHeight: 12.5, after: 3 });
}

for (let index = 0; index < pages.length; index += 1) {
  pages[index].push({ kind: 'text', text: `Altegro Phase 1 Status Report  |  ${index + 1} / ${pages.length}`, x: 48, y: 30, size: 7.5, font: 'regular', color: [0.47, 0.38, 0.43] });
}

function escapePdfText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageStream(items) {
  const commands = [];
  for (const item of items) {
    if (item.kind === 'rect') {
      commands.push(`q ${item.color.join(' ')} rg ${item.x} ${item.y} ${item.width} ${item.height} re f Q`);
    } else {
      const font = item.font === 'bold' ? 'F2' : 'F1';
      commands.push(`BT /${font} ${item.size} Tf ${item.color.join(' ')} rg 1 0 0 1 ${item.x} ${item.y} Tm (${escapePdfText(item.text)}) Tj ET`);
    }
  }
  return commands.join('\n');
}

const objects = new Map();
objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const pageIds = [];
for (let index = 0; index < pages.length; index += 1) {
  const contentId = 5 + index * 2;
  const pageId = contentId + 1;
  const stream = pageStream(pages[index]);
  pageIds.push(pageId);
  objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
  objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
}
objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

const maxObjectId = Math.max(...objects.keys());
let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [0];
for (let id = 1; id <= maxObjectId; id += 1) {
  offsets[id] = Buffer.byteLength(pdf, 'binary');
  pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, 'binary');
pdf += `xref\n0 ${maxObjectId + 1}\n`;
pdf += '0000000000 65535 f \n';
for (let id = 1; id <= maxObjectId; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

fs.writeFileSync(outputPath, Buffer.from(pdf, 'binary'));
console.log(`Created ${outputPath} (${pages.length} pages)`);
