// Synthetic fixtures for the privacy-first workflow end-to-end tests.
// Everything here is fictional and generated locally. Nothing real, nothing downloaded.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Build a minimal, valid single-page PDF with a real (extractable) text layer. */
export function makeTextPdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const ops = ['BT', '/F1 11 Tf', '72 780 Td', '14 TL']
  for (const line of lines) ops.push(`(${esc(line)}) Tj T*`)
  ops.push('ET')
  const stream = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  return assemblePdf(objects)
}

/** A PDF with no text layer — the "scan" case the extractor must refuse without a local OCR engine. */
export function makeEmptyTextPdf() {
  const stream = 'BT /F1 11 Tf ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  return assemblePdf(objects)
}

function assemblePdf(objects) {
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export function writeFixture(dir, name, bytes) {
  mkdirSync(dir, { recursive: true })
  const path = `${dir}/${name}`
  writeFileSync(path, bytes)
  return path
}

/**
 * The fictional invoice used throughout the tests.
 * Values are the canonical public test values (IBAN DE89370400440532013000 is the
 * ISO 13616 example), plus invented contact details. They are placeholders for PII,
 * not anyone's data.
 */
export const FIXTURE_PII = {
  iban: 'DE89370400440532013000',
  email: 'erika.mustermann@example.com',
  phone: '+49 30 12345678',
  address: 'Musterstraße 12, 10115 Berlin',
  person: 'Erika Mustermann',
  secret: 'sk-test-0000000000000000000000000000000000000000',
}

export const FIXTURE_LINES = [
  'Rechnung Nr. 2026-0042',
  'Rechnungsempfaenger: Erika Mustermann',
  `Anschrift: ${FIXTURE_PII.address}`,
  `IBAN: ${FIXTURE_PII.iban}`,
  'BIC: COBADEFFXXX',
  `E-Mail: ${FIXTURE_PII.email}`,
  `Telefon: ${FIXTURE_PII.phone}`,
  'Betrag: 1.234,56 EUR',
  'Leistungszeitraum: 01.10.2026 - 31.10.2026',
  `Debug: ${FIXTURE_PII.secret}`,
]
