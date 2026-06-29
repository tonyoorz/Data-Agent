import base64
import json
import os
import sys
import tempfile
from pathlib import Path


def _extension_from_mime(mime):
    normalized = str(mime or "").lower()
    if "jpeg" in normalized or "jpg" in normalized:
        return ".jpg"
    if "webp" in normalized:
        return ".webp"
    if "bmp" in normalized:
        return ".bmp"
    return ".png"


def _write_image(payload):
    image_base64 = str(payload.get("image") or "").strip()
    image_url = str(payload.get("imageUrl") or "").strip()
    if image_base64:
        suffix = _extension_from_mime(payload.get("mime"))
        with tempfile.NamedTemporaryFile(prefix="vizion-rapidocr-", suffix=suffix, delete=False) as handle:
            handle.write(base64.b64decode(image_base64))
            return Path(handle.name), True

    if image_url and Path(image_url).exists():
        return Path(image_url), False

    raise ValueError("image is required")


def _build_params(payload):
    params = {
        "Global.log_level": "warning",
    }
    mapping = {
        "detModel": "Det.model_path",
        "recModel": "Rec.model_path",
        "clsModel": "Cls.model_path",
    }
    for payload_key, param_key in mapping.items():
        value = str(payload.get(payload_key) or "").strip()
        if value:
            params[param_key] = value
    return params


def _to_float(value):
    try:
        return float(value)
    except Exception:
        return None


def _run(payload):
    from rapidocr import RapidOCR

    image_path, should_delete = _write_image(payload)
    try:
        engine = RapidOCR(params=_build_params(payload))
        result = engine(str(image_path))
        texts = list(getattr(result, "txts", None) or [])
        scores = list(getattr(result, "scores", None) or [])
        lines = []
        for index, text in enumerate(texts):
            normalized = str(text or "").strip()
            if not normalized:
                continue
            item = {"text": normalized}
            if index < len(scores):
                score = _to_float(scores[index])
                if score is not None:
                    item["score"] = score
            lines.append(item)

        return {
            "text": "\n".join(item["text"] for item in lines).strip(),
            "lines": lines,
        }
    finally:
        if should_delete:
            try:
                os.unlink(image_path)
            except OSError:
                pass


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
        print(json.dumps(_run(payload), ensure_ascii=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()