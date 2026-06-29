import base64
import json
import os
import sys
import tempfile
from pathlib import Path


def _write_pdf(payload):
    file_base64 = str(payload.get("file") or "").strip()
    if not file_base64:
        raise ValueError("file is required")

    with tempfile.NamedTemporaryFile(prefix="vizion-pdf-", suffix=".pdf", delete=False) as handle:
        handle.write(base64.b64decode(file_base64))
        return Path(handle.name)


def _run(payload):
    from pypdf import PdfReader

    pdf_path = _write_pdf(payload)
    try:
        reader = PdfReader(str(pdf_path))
        pages = []
        for index, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                pages.append({"page": index, "text": text})

        return {
            "text": "\n\n".join(page["text"] for page in pages).strip(),
            "pages": pages,
        }
    finally:
        try:
            os.unlink(pdf_path)
        except OSError:
            pass


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        print(json.dumps(_run(payload), ensure_ascii=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()