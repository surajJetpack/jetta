/**
 * Minimal image dimension reader — no dependency, header bytes only.
 *
 * Used to tell a customer's screenshot apart from the logo in their email
 * signature: pixel dimensions separate the two cleanly where file size does not
 * (a real bug screenshot can be smaller on disk than a fancy corporate banner).
 */

export interface ImageDims {
  width: number;
  height: number;
}

/** Returns null for formats we can't read (the caller decides what to do then). */
export function imageDimensions(data: ArrayBuffer): ImageDims | null {
  const b = new DataView(data);
  if (b.byteLength < 24) return null;

  // PNG: 8-byte signature, then the IHDR chunk carries width/height as big-endian u32.
  if (b.getUint32(0) === 0x89504e47) {
    return { width: b.getUint32(16), height: b.getUint32(20) };
  }

  // GIF: "GIF8", then logical screen width/height as little-endian u16.
  if (b.getUint32(0) === 0x47494638) {
    return { width: b.getUint16(6, true), height: b.getUint16(8, true) };
  }

  // JPEG: walk the segment chain to a Start-Of-Frame marker, which holds the size.
  if (b.getUint16(0) === 0xffd8) {
    let off = 2;
    while (off + 9 < b.byteLength) {
      if (b.getUint8(off) !== 0xff) {
        off++; // Resync on padding between segments.
        continue;
      }
      const marker = b.getUint8(off + 1);
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 — every frame type except the
      // non-SOF markers that share the 0xC0 range (DHT 0xC4, RSTn 0xC8, DAC 0xCC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.getUint16(off + 5), width: b.getUint16(off + 7) };
      }
      off += 2 + b.getUint16(off + 2); // Skip this segment's declared length.
    }
  }

  return null;
}
