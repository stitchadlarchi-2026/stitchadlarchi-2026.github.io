/**
 * Strip a headshot of everything but its pixels.
 *
 * A photo straight off a phone carries EXIF: the GPS position it was taken
 * at, the device, the time. None of that belongs in a committee's download,
 * so it is removed before the photo is written to disk. What survives is the
 * image data, its colour profile, and the one EXIF field that changes how it
 * looks, its orientation, rewritten on its own so a portrait does not open
 * sideways.
 *
 * JPEG, PNG and WebP are handled. Anything that does not parse cleanly is
 * refused rather than stored with its metadata: `strip` throws and the form
 * asks for another photo. Node builtins only.
 */

/** JPEG: keep only the segments a decoder needs, plus ICC colour and orientation. */
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  let insertAt = 1; // after SOI, or after APP0 (JFIF) when there is one

  const segment = () => {
    if (i + 4 > buf.length) throw new Error('truncated segment');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('bad segment length');
    const seg = buf.subarray(i, i + 2 + len);
    i += 2 + len;
    return seg;
  };

  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('expected a marker');
    while (buf[i] === 0xff) i += 1; // fill bytes
    const m = buf[i];
    i -= 1; // back onto the 0xFF so `segment` reads marker + length
    if (m === 0xd9) {
      out.push(buf.subarray(i, i + 2));
      break; // EOI: anything after it (an iPhone's appended images, with EXIF of their own) is dropped
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(buf.subarray(i, i + 2)); // TEM and RSTn stand alone, with no length
      i += 2;
      continue;
    }
    if (m === 0xda) {
      // SOS: its header, then entropy-coded data up to the next real marker.
      out.push(segment());
      const start = i;
      while (i < buf.length) {
        if (buf[i] === 0xff && i + 1 < buf.length) {
          const n = buf[i + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            i += n === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      out.push(buf.subarray(start, i));
      continue;
    }
    const seg = segment();
    const body = seg.subarray(4);
    if (m === 0xe0) {
      out.push(seg);
      insertAt = out.length;
    } else if (m === 0xe1) {
      if (body.subarray(0, 6).toString('latin1') === 'Exif\0\0') orientation = readOrientation(body.subarray(6));
      // EXIF and XMP both dropped
    } else if (m === 0xe2) {
      if (body.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0') out.push(seg); // MPF dropped
    } else if ((m >= 0xe3 && m <= 0xef) || m === 0xfe) {
      // other APPn (IPTC, Photoshop, maker data) and comments dropped
    } else {
      out.push(seg); // DQT, DHT, SOFn, DRI and the rest: needed to decode
    }
  }
  if (orientation !== 1) out.splice(insertAt, 0, orientationSegment(orientation));
  return Buffer.concat(out);
}

/** The Orientation tag (0x0112) from a TIFF-structured EXIF block, or 1. */
function readOrientation(tiff) {
  try {
    const le = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    /* unreadable EXIF: treat as upright */
  }
  return 1;
}

/** An APP1 holding a minimal EXIF block with Orientation and nothing else. */
function orientationSegment(value) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(value, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** PNG: drop the text, time and EXIF chunks. Whole chunks go, so no CRC changes. */
function stripPng(buf) {
  const drop = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let ended = false;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw new Error('truncated chunk');
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('bad chunk length');
    if (!drop.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new Error('no IEND');
  return Buffer.concat(out);
}

/** WebP: drop the EXIF and XMP chunks and clear their flags in VP8X. */
function stripWebp(buf) {
  const out = [];
  let i = 12;
  while (i < buf.length) {
    if (i + 8 > buf.length) throw new Error('truncated chunk');
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > buf.length) throw new Error('bad chunk length');
    const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
    if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04);
    if (type !== 'EXIF' && type !== 'XMP ') out.push(chunk);
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** The photo with its metadata removed. Throws on anything it cannot parse. */
export function strip(buf, ext) {
  if (ext === 'jpg') return stripJpeg(buf);
  if (ext === 'png') return stripPng(buf);
  if (ext === 'webp') return stripWebp(buf);
  throw new Error(`cannot strip ${ext}`);
}
