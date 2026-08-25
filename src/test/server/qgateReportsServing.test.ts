import { describe, expect, it } from "vitest";

import {
  buildQGateDashboardCsp,
  createQGateDashboardNonce,
  stampQGateScriptNonce,
} from "../../../server/qgateReports.mjs";

const SCRIPT_OPENERS = /<script(?:\s[^>]*)?>/g;

describe("QGate dashboard serving hardening", () => {
  it("creates a fresh high-entropy base64url nonce per call", () => {
    const a = createQGateDashboardNonce();
    const b = createQGateDashboardNonce();

    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it("builds a CSP that pins the nonce to script-src and forbids inline/eval scripts", () => {
    const nonce = createQGateDashboardNonce();
    const csp = buildQGateDashboardCsp(nonce);

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");

    const scriptSrc = csp.match(/script-src [^;]*/)?.[0] ?? "";
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}'`);
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("requires a nonce to build the CSP and stamp the script", () => {
    expect(() => buildQGateDashboardCsp("")).toThrow();
    expect(() => buildQGateDashboardCsp(undefined as unknown as string)).toThrow();
    expect(() => stampQGateScriptNonce("<script></script>", "")).toThrow();
  });

  it("stamps the nonce onto the single legitimate inline <script> only", () => {
    const nonce = "n123";
    const html =
      '<!DOCTYPE html><html><head><style>a{}</style></head>' +
      "<body><script>const QGATE_PAYLOAD=1;render();</script></body></html>";

    const stamped = stampQGateScriptNonce(html, nonce);

    const openers = [...stamped.matchAll(SCRIPT_OPENERS)].map((match) => match[0]);
    expect(openers).toEqual([`<script nonce="${nonce}">`]);
  });

  it("leaves a DB-injected </script><script> breakout un-noned so CSP blocks it", () => {
    // Simulates a poisoned payload value breaking out of the script block. The
    // generator now escapes < > & U+2028/9 so this can no longer originate from
    // data; this guard proves the serve-time CSP layer holds regardless.
    const nonce = "n123";
    const hostile = `</script><script>alert("xss")</script>`;
    const html = `<html><body><script>const P="${hostile}";</script></body></html>`;

    const stamped = stampQGateScriptNonce(html, nonce);

    const openers = [...stamped.matchAll(SCRIPT_OPENERS)].map((match) => match[0]);
    expect(openers).toHaveLength(2);
    expect(openers[0]).toBe(`<script nonce="${nonce}">`);
    // The injected opener gets no nonce → blocked by script-src 'nonce-...'.
    expect(openers[1]).toBe("<script>");
  });
});
