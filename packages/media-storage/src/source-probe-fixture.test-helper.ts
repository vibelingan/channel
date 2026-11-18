/** Unique real pixels for temporary cloud acceptance, never a customer photo. */
export async function sourceProbePng(run: string) {
  if (!/^[a-f0-9]{32}$/.test(run)) throw Error('Exact source fixture identity required');
  const sharp = (await import('#catalog-image-decoder')).default;
  const raw = Buffer.alloc(1600 * 1000 * 3);
  for (let offset = 0; offset < raw.length; offset += 3) {
    raw[offset] = 35;
    raw[offset + 1] = 69;
    raw[offset + 2] = 103;
  }
  Buffer.from(run, 'hex').copy(raw);
  return sharp(raw, { raw: { width: 1600, height: 1000, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}
