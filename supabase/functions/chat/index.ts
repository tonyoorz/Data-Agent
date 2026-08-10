// Streaming AI chat via Lovable AI Gateway
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are DTSV Intelligence — a senior data analyst embedded in a quality engineering dashboard.

# Output protocol (strict)
Before the final answer, narrate your work as an agent does, using these special tags. The UI parses them.

1. \`<think>...</think>\` — your private reasoning. 1-4 short sentences. Use it once at the start, and again only if you change direction.
2. \`<step title="..." source="...">one-line result</step>\` — represent each analytical action you take, in order. \`title\` is what you are doing (e.g. "Query defect trend", "Aggregate by ECU"); \`source\` is the data slice (e.g. "topissue.csv", "coverage.module"); the body is the one-line finding. Emit 2-5 steps for non-trivial questions.
3. \`<cite source="...">label</cite>\` — inline citation chips inside the final answer, pointing to the dashboard module or table the claim depends on.
4. Then the final markdown answer (Signal → Diagnosis → Recommendation).

# Style
- Direct, structured, grounded. No "Certainly!", no "As an AI".
- Concise markdown: short paragraphs, bullet lists, small tables.
- Numbers and concrete reasoning, not vague claims.
- If data is missing, emit one \`<step>\` noting the gap, then ask one sharp clarifying question.
- Respond in the user's language (Chinese or English).

# Example
<think>用户问 Top Issue 上升模块，我需要按月对比缺陷数并分组排序。</think>
<step title="拉取近三月 Top Issue" source="topissue.monthly">共 142 条，分布在 18 个模块</step>
<step title="计算环比增速" source="topissue.delta">3 个模块环比 >50%</step>

**Signal** <cite source="defect-high">缺陷高频分析</cite>
- ECU-Powertrain：环比 +82%，集中在 OTA 回归
...
`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, model, context } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const systemMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
    ];
    if (context && typeof context === "string" && context.trim()) {
      systemMessages.push({
        role: "system",
        content: `# Current dashboard context\n${context}`,
      });
    }

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model || "google/gemini-3-flash-preview",
          stream: true,
          messages: [...systemMessages, ...(messages || [])],
        }),
      },
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "请求过于频繁，请稍后再试。" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI 额度不足，请到 Lovable 工作区充值后重试。" }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI 网关错误" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
