import { useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, FlaskConical, ExternalLink } from "lucide-react";
import type { TestCaseResult } from "./testCaseTypes";

interface Props {
  result: TestCaseResult;
}

const OCTANE_BASE = "https://octane-prod.bmwgroup.net/ui/?p=1002/2001#/entity-navigation?entityType=work_item&id=";

export default function TestCasePreviewCard({ result }: Props) {
  const [commitState, setCommitState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [commitError, setCommitError] = useState("");
  const [createdUrl, setCreatedUrl] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [ownerId, setOwnerId] = useState("");

  const handleCommit = async () => {
    setCommitState("submitting");
    setCommitError("");
    try {
      const response = await fetch("/api/create-testcase/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_case_data: {
            name: result.name,
            description_html: result.descriptionHtml,
            steps_text: result.stepsText,
            defectId: result.defectId,
            owner_workspace_user_id: ownerId,
          },
          feature_id: featureId,
          owner_workspace_user_id: ownerId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.success) {
        setCreatedUrl(payload.octane_url || "");
        setCommitState("success");
      } else {
        setCommitError(payload.error || "创建失败");
        setCommitState("error");
      }
    } catch (err) {
      setCommitError(String(err?.message || err));
      setCommitState("error");
    }
  };

  const steps = result.stepsText.split("\n").filter((l) => l.trim());

  return (
    <div className="mt-3 rounded-xl border border-border bg-card overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 bg-muted/30">
        <FlaskConical className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">测试用例预览</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(result.generatedAt).toLocaleString("zh-CN")}
        </span>
      </div>

      <div className="space-y-4 p-4">
        {/* defect info */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">缺陷信息</p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge label={result.defectId} />
            <Badge label={result.defectSeverity} variant={result.defectSeverity.includes("High") || result.defectSeverity.includes("Very") ? "danger" : "default"} />
            {result.defectSoftwareVersion && <Badge label={result.defectSoftwareVersion} />}
            {result.defectAssignedEcu && <Badge label={result.defectAssignedEcu} />}
            {result.defectLeadModel && <Badge label={result.defectLeadModel} />}
          </div>
          <p className="text-sm text-foreground mt-1">{result.defectName}</p>
        </div>

        {/* test case name */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">用例名称</p>
          <p className="text-sm font-medium text-foreground">{result.name}</p>
        </div>

        {/* similar cases (RAG) */}
        {result.similarCases.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              RAG 检索参考用例 ({result.similarCases.length})
            </p>
            <div className="space-y-1">
              {result.similarCases.slice(0, 3).map((c) => (
                <a
                  key={c.testId}
                  href={`${OCTANE_BASE}${c.testId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-blue-600 hover:underline"
                >
                  <span className="font-mono">T{c.testId}</span>
                  <span className="truncate text-muted-foreground">{c.name}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">score: {c.score}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* description preview */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">描述 (Description)</p>
          <div
            className="rounded-lg border border-border bg-muted/20 p-3 text-xs prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: result.descriptionHtml }}
          />
        </div>

        {/* steps preview */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">步骤 (Steps)</p>
          <pre className="rounded-lg border border-border bg-muted/20 p-3 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
            {steps.map((line, i) => {
              const isPrecon = line.includes("[PreCon]");
              const isCheckpoint = line.includes("?");
              const color = isPrecon ? "text-blue-600" : isCheckpoint ? "text-green-600" : "text-foreground";
              return (
                <span key={i} className={color}>
                  {line}
                  {"\n"}
                </span>
              );
            })}
          </pre>
        </div>

        {/* verification badges */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            质量验证 ({result.verification.passed ? "全部通过" : `${result.verification.criteria.filter((c) => c.passed).length}/${result.verification.criteria.length} 通过`})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.verification.criteria.map((c) => (
              <span
                key={c.name}
                title={c.evidence}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  c.passed
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}
              >
                {c.passed ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                {c.name}
              </span>
            ))}
          </div>
        </div>

        {/* commit section */}
        {commitState === "success" ? (
          <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-900/20 px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">测试用例已创建</span>
            <a
              href={createdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              在 Octane 中打开 <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={featureId}
                onChange={(e) => setFeatureId(e.target.value)}
                placeholder="Feature ID（可选，link 到 feature）"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
              />
              <input
                type="text"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                placeholder="Owner workspace_user ID"
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
              />
              <button
                onClick={handleCommit}
                disabled={commitState === "submitting" || !ownerId}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {commitState === "submitting" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 创建中…
                  </>
                ) : (
                  "确认创建"
                )}
              </button>
            </div>
            {commitState === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">{commitError}</p>
            )}
            {!ownerId && (
              <p className="text-[10px] text-muted-foreground">
                Owner workspace_user ID 必填（如 500026）
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ label, variant = "default" }: { label: string; variant?: "default" | "danger" }) {
  const color =
    variant === "danger"
      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      : "bg-muted text-muted-foreground";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>;
}
