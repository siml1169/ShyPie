"""Local OOXML text extraction helper for @privacy/local-extract.

Usage: python extract_office.py <docx|xlsx|pptx> <input-path> <output-txt>

Writes UTF-8 text (LF newlines) to <output-txt>. Exit codes:
  0  success (the output may legitimately be empty; the Node caller decides)
  2  usage error
  1  extraction failure (the caller maps this to a PARSE_FAILED block)

Runs fully offline. Uses only the libraries bundled with the DSH runtime
(python-docx, openpyxl, python-pptx). Never prints document content or paths:
the caller surfaces a generic block detail so no PII reaches a tool result.
"""

import sys


def extract_docx(path: str) -> str:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = Document(path)
    parts = []

    # Walk the body in document order so paragraphs and tables stay interleaved.
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(child, document)
            if paragraph.text.strip():
                parts.append(paragraph.text)
        elif tag == "tbl":
            table = Table(child, document)
            for row in table.rows:
                cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                if any(cells):
                    parts.append("\t".join(cells))

    for section in document.sections:
        for container in (section.header, section.footer):
            try:
                for paragraph in container.paragraphs:
                    if paragraph.text.strip():
                        parts.append(paragraph.text)
            except Exception:
                pass

    return "\n".join(parts)


def extract_xlsx(path: str) -> str:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        parts = []
        for sheet in workbook.worksheets:
            parts.append("# Sheet: %s" % sheet.title)
            for row in sheet.iter_rows(values_only=True):
                cells = ["" if value is None else str(value) for value in row]
                while cells and cells[-1] == "":
                    cells.pop()
                if cells:
                    parts.append("\t".join(cells))
        return "\n".join(parts)
    finally:
        workbook.close()


def extract_pptx(path: str) -> str:
    from pptx import Presentation

    presentation = Presentation(path)
    parts = []
    for index, slide in enumerate(presentation.slides, 1):
        parts.append("# Slide %d" % index)
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    text = paragraph.text.strip()
                    if text:
                        parts.append(text)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                    if any(cells):
                        parts.append("\t".join(cells))
    return "\n".join(parts)


EXTRACTORS = {"docx": extract_docx, "xlsx": extract_xlsx, "pptx": extract_pptx}


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write("usage: extract_office.py <docx|xlsx|pptx> <input> <output>\n")
        return 2
    kind, source, destination = sys.argv[1], sys.argv[2], sys.argv[3]
    extractor = EXTRACTORS.get(kind)
    if extractor is None:
        sys.stderr.write("unsupported kind\n")
        return 2
    try:
        text = extractor(source)
    except Exception as exc:  # noqa: BLE001 - report the class only, never the path
        sys.stderr.write("extraction failed: %s\n" % type(exc).__name__)
        return 1
    with open(destination, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
