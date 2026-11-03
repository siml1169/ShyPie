# Background: the incident this workflow comes from

This is a redacted account of the failure that motivated the design. The full session log is
deliberately **not** included: it contains a real person's identity, address and bank details, and
duplicating it into a repository would be exactly the mistake the design exists to prevent. What is
recorded here are the technical findings with every personal value removed; the evidence trail is in
[dsh-hooks.md](dsh-hooks.md) and [magpie-hooks.md](magpie-hooks.md).

## What happened

An agent was asked to read two invoice PDFs. It rendered the PDFs to images locally and placed the
rasterised pages into the model context. The gateway's text masking was enabled at the time and
substituted placeholders in the message text — but the image parts, the extracted text and the tool
output around them travelled in clear text to the model provider. The user noticed a real
name/address/IBAN printed in a reply and asked what the masking actually covered.

Investigating that question against the gateway's own masking journal established four facts that
became requirements:

| Finding | Consequence |
|---|---|
| Masking is applied on the **outbound leg**, after the model request is assembled | it protects the transcript, not the working data |
| The plaintext still exists locally — in the session log, the model context, the rendered rasters and the journal | the local session log is a trust boundary, not a cache |
| Text masking cannot see raster images, PDF bytes or already-extracted text | a gateway alone can never be privacy-first |
| Masking cost ≈15 s per request over a ~260 k-token context | re-masking every turn is slow and lossy; redact once, at ingestion |

A follow-up design conversation produced the constraint that shapes this repository: DeepSeek Harness's
outbound request is a deep-frozen fold of the session log, so no plugin can rewrite it on the way out.
Masking must happen **before ingestion** — before bytes become part of the history that is replayed
on every turn. See [design.md §2](../design.md#2-what-the-motivating-incident-established).

## The four clear-text channels

1. **Image bytes** — a rasterised invoice is a dense visual transcript of every field; placeholder
   substitution over message *text* cannot see inside an image part.
2. **Extracted text** — `pdftotext`/OCR output is text at the tool boundary, before any masking layer.
3. **File writes** — content an agent wrote to disk is not a message relay and was never masked.
4. **Tool results** — raw `pwsh`/`read` output is plain text in the transcript.

Each channel maps to a control: the `read_image` guard and local extraction (1–2), BLOB blocking and
rehydrate-into-artifact (3), and the tool-result redaction gate (4).

## What the repository contains instead of the transcript

- [dsh-hooks.md](dsh-hooks.md) — every DeepSeek Harness seam this design relies on, with `path:line`
  evidence from the shipped source.
- [magpie-hooks.md](magpie-hooks.md) — every Magpie middleware hook, with the docs URL and the quoted
  sentence it rests on.
- [security-review.md](security-review.md) — the independent adversarial review of the design and the
  record of what was fixed.
