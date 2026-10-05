// Small byte sequences with real image signatures; the server checks signatures, not full decoding.
export const images = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 1)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 2)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 1, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(256, 3)])
};

export function photoForm({ bytes, filename = "photo.png", type = "image/png", capturedAt = "2026-09-01", caption } = {}) {
  const form = new FormData();
  form.append("capturedAt", capturedAt);
  if (caption !== undefined) form.append("caption", caption);
  if (bytes) form.append("photo", new Blob([bytes], { type }), filename);
  return form;
}
