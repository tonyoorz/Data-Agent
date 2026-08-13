import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AnalysisResultChart, {
  type AnalysisResultPayload,
} from "@/components/dashboard/chat/AnalysisResultChart";

// AnalysisResultChart (task 29) renders the structured analysis-result payload
// by visualization profile. These tests cover the deterministic HTML surfaces
// (table + kpi + none + empty + axis-fallback); the recharts bar/line paths are
// exercised through the dev server and e2e since ResponsiveContainer needs a
// real layout box.

describe("AnalysisResultChart", () => {
  it("renders a table view with column headers and row cells", () => {
    const result: AnalysisResultPayload = {
      visualization: "table",
      columns: [
        { id: "product.ecu", label: "product.ecu" },
        { id: "defect.count", label: "defect.count" },
      ],
      rows: [
        { "product.ecu": "HU", "defect.count": 3 },
        { "product.ecu": "ADAS", "defect.count": 5 },
      ],
      metrics: { "defect.count": 8 },
    };
    render(<AnalysisResultChart result={result} />);
    expect(screen.getByText("HU")).toBeInTheDocument();
    expect(screen.getByText("ADAS")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders kpi cards from the metrics summary", () => {
    const result: AnalysisResultPayload = {
      visualization: "kpi",
      columns: [],
      rows: [],
      metrics: { "defect.count": 42 },
    };
    render(<AnalysisResultChart result={result} />);
    expect(screen.getByText("defect.count")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders nothing for visualization none", () => {
    const result: AnalysisResultPayload = {
      visualization: "none",
      columns: [{ id: "x", label: "x" }],
      rows: [{ x: 1 }],
      metrics: {},
    };
    const { container } = render(<AnalysisResultChart result={result} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no columns and no metrics", () => {
    const result: AnalysisResultPayload = {
      visualization: "table",
      columns: [],
      rows: [],
      metrics: {},
    };
    const { container } = render(<AnalysisResultChart result={result} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to a table when a bar visualization has no derivable dimension axis", () => {
    const result: AnalysisResultPayload = {
      visualization: "bar",
      columns: [{ id: "defect.count", label: "defect.count" }],
      rows: [{ "defect.count": 3 }],
      metrics: { "defect.count": 3 },
    };
    render(<AnalysisResultChart result={result} />);
    // no dimension column → SeriesChart falls back to TableView, which renders the header
    expect(screen.getByText("defect.count")).toBeInTheDocument();
  });

  it("formats large integers with thousands separators in the table view", () => {
    const result: AnalysisResultPayload = {
      visualization: "table",
      columns: [
        { id: "product.ecu", label: "product.ecu" },
        { id: "defect.count", label: "defect.count" },
      ],
      rows: [{ "product.ecu": "HU", "defect.count": 12345 }],
      metrics: {},
    };
    render(<AnalysisResultChart result={result} />);
    expect(screen.getByText("12,345")).toBeInTheDocument();
  });
});
