/**
 * The committee's downloads: a zip written straight to the response, and the
 * one-sheet workbook inside it. Node builtins only.
 *
 * Small parts are deflated in memory. Files are streamed from disk as stored
 * entries, using the size and CRC recorded when they were saved, so memory
 * stays flat however much there is. The posters run to tens of
 * gigabytes in all, so entries and offsets past 4 GB switch to ZIP64, which
 * macOS, Windows and 7-Zip all read. Below 4 GB the zip is a plain one.
 */

import { createReadStream } from 'node:fs';
import { crc32 as zcrc32, deflateRawSync } from 'node:zlib';

const MAX32 = 0xffffffff;

export const crc32 = (buf, prev = 0) => zcrc32(buf, prev);

export class ZipStream {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.central = [];
  }

  write(buf) {
    this.offset += buf.length;
    return this.out.write(buf) ? Promise.resolve() : new Promise((r) => this.out.once('drain', r));
  }

  header(nameBuf, method, crc, csize, usize) {
    const big = csize >= MAX32 || usize >= MAX32;
    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(usize), 4);
      extra.writeBigUInt64LE(BigInt(csize), 12);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(0, 10);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(big ? MAX32 : csize, 18);
    h.writeUInt32LE(big ? MAX32 : usize, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    this.central.push({ nameBuf, method, crc, csize, usize, offset: this.offset });
    return Buffer.concat([h, nameBuf, extra]);
  }

  async addBuffer(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    await this.write(this.header(nameBuf, 8, crc32(data), deflated.length, data.length));
    await this.write(deflated);
  }

  async addFile(name, path, size, crc) {
    const nameBuf = Buffer.from(name, 'utf8');
    await this.write(this.header(nameBuf, 0, crc, size, size));
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) await this.write(chunk);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.central) {
      // Each field that does not fit in 32 bits moves to the ZIP64 extra, in this order.
      const fields = [];
      if (e.usize >= MAX32) fields.push(e.usize);
      if (e.csize >= MAX32) fields.push(e.csize);
      if (e.offset >= MAX32) fields.push(e.offset);
      const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8 * fields.length, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(fields.length ? 45 : 20, 4);
      c.writeUInt16LE(fields.length ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt32LE(0, 12);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(Math.min(e.csize, MAX32), 20);
      c.writeUInt32LE(Math.min(e.usize, MAX32), 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(Math.min(e.offset, MAX32), 42);
      await this.write(Buffer.concat([c, e.nameBuf, extra]));
    }
    const size = this.offset - start;
    const count = this.central.length;
    if (start >= MAX32 || size >= MAX32 || count >= 0xffff) {
      const at = this.offset;
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(size), 40);
      z.writeBigUInt64LE(BigInt(start), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(at), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(size, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    await this.write(end);
    this.out.end();
  }
}

/** A zip held in memory, for the workbook that goes inside the outer zip. */
export async function zipInMemory(entries) {
  const parts = [];
  let done;
  const finished = new Promise((r) => (done = r));
  const z = new ZipStream({ write: (b) => (parts.push(b), true), once() {}, end: () => done() });
  for (const [name, data] of entries) await z.addBuffer(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  await z.finish();
  await finished;
  return Buffer.concat(parts);
}

const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = (i) => String.fromCharCode(65 + i);

/**
 * A one-sheet .xlsx. Strings are inline, so no shared-strings part is needed.
 * `wrap` names the columns whose text wraps (the overview).
 */
export function workbook(head, widths, rows, wrap = []) {
  const sheetRows = [head, ...rows]
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const style = ri === 0 ? ' s="1"' : wrap.includes(ci) ? ' s="2"' : '';
          return `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const NS = 'http://schemas.openxmlformats.org';
  return zipInMemory([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Submissions" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]);
}
