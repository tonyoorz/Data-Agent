// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  assertChatAttachmentLimits,
  parseImageDataUrl,
  parsePdfDataUrl,
} from "../../../server/attachmentBoundary.mjs";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQ=";

describe("chat attachment boundary", () => {
  it("accepts supported user images and PDFs with matching magic bytes", () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toMatchObject({ mimeType: "image/png", byteLength: 8 });
    expect(parsePdfDataUrl(PDF_DATA_URL)).toMatchObject({ mimeType: "application/pdf" });
    expect(assertChatAttachmentLimits([{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
        { type: "file_data", file_data: { name: "report.pdf", mime_type: "application/pdf", url: PDF_DATA_URL } },
      ],
    }])).toEqual({ count: 2, totalBytes: 16 });
  });

  it.each([
    { role: "assistant", content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }] },
    { role: "user", content: [{ type: "file_data", file_data: { name: "secret.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: PDF_DATA_URL } }] },
    { role: "user", content: [{ type: "input_audio", input_audio: { data: "private" } }] },
    { role: "user", content: [{ image_url: { url: PNG_DATA_URL } }] },
    { role: "user", content: { type: "image_url", image_url: { url: "https://169.254.169.254" } } },
    { role: "user", content: [{ type: "text", text: "x", image_url: { url: PNG_DATA_URL } }] },
  ])("rejects unsupported, malformed, or non-user attachment content", (message) => {
    expect(() => assertChatAttachmentLimits([message])).toThrowError("CHAT_ATTACHMENT_INPUT_INVALID");
  });

  it("rejects declared image content whose bytes do not match the MIME type", () => {
    expect(() => parseImageDataUrl("data:image/png;base64,aW1hZ2U="))
      .toThrowError("CHAT_ATTACHMENT_INPUT_INVALID");
  });

  it("enforces aggregate attachment count and decoded byte limits", () => {
    const imageParts = Array.from({ length: 9 }, () => ({
      type: "image_url",
      image_url: { url: PNG_DATA_URL },
    }));
    expect(() => assertChatAttachmentLimits([{ role: "user", content: imageParts }]))
      .toThrowError("CHAT_ATTACHMENT_LIMIT_EXCEEDED");
    expect(() => assertChatAttachmentLimits(
      [{ role: "user", content: [imageParts[0]] }],
      { maxAttachments: 8, maxAttachmentBytes: 7, maxTotalBytes: 7 },
    )).toThrowError("CHAT_ATTACHMENT_BYTES_EXCEEDED");
  });
});
