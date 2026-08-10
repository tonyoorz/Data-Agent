"""OntologyPromptBuilder — auto-injects curated ontology knowledge into LLM system prompts."""
from __future__ import annotations

from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


class OntologyPromptBuilder:
    """Builds a concise, markdown-formatted system-prompt fragment from the compiled ontology."""

    def __init__(self, catalog: OntologyCatalog | None = None):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None
            self._bundle: dict[str, Any] = {}
            return
        self._bundle = self._catalog.bundle

    # ─── public API ────────────────────────────────────────────────────

    def build_system_context(self, *, max_chars: int = 4000) -> str:
        """Assemble every section and truncate to *max_chars*."""
        sections = [
            self._build_header(),
            self.build_guardrail_rules_section(),
            self.build_metric_glossary_section(),
            self.build_vocab_table_section(),
            self._build_relationship_summary(),
        ]
        result = "\n\n".join(s for s in sections if s)
        if len(result) > max_chars:
            # Truncate at the last完整 line boundary before the limit
            cut = result[: max_chars - 3]
            last_newline = cut.rfind("\n")
            if last_newline > max_chars // 2:
                cut = cut[:last_newline]
            result = cut.rstrip() + "..."
        return result

    def build_guardrail_rules(self) -> list[str]:
        """Return approved constraints as human-readable sentences."""
        rules: list[str] = []
        for item in self._bundle.get("constraints", []):
            gov = item.get("governance", {})
            if gov.get("status") != "approved":
                continue
            cid = item.get("id", "?")
            kind = item.get("kind", "")
            enforcement = item.get("enforcement", "")
            params = item.get("parameters", {})
            param_str = "; ".join(f"{k}={v}" for k, v in params.items()) if params else ""
            desc = f"RULE [{cid}]: {kind} (enforcement: {enforcement}"
            if param_str:
                desc += f"; {param_str}"
            desc += ")"
            rules.append(desc)
        return rules

    def build_guardrail_rules_section(self) -> str:
        rules = self.build_guardrail_rules()
        if not rules:
            return ""
        return "## Business Rules (Ontology)\n\n" + "\n".join(f"- {r}" for r in rules)

    def build_metric_glossary(self) -> str:
        """One line per approved metric."""
        lines: list[str] = []
        for metric in self._bundle.get("metrics", []):
            gov = metric.get("governance", {})
            if gov.get("status") != "approved":
                continue
            mid = metric.get("id", "?")
            desc = (metric.get("description") or "")[:100]
            line = f"- **{mid}**: {desc}"
            target = metric.get("targetValue")
            if target is not None:
                line += f" (target: {target})"
            unit = metric.get("unit")
            if unit:
                line += f" [unit: {unit}]"
            lines.append(line)
        return "\n".join(lines)

    def build_metric_glossary_section(self) -> str:
        glossary = self.build_metric_glossary()
        return f"## Metric Glossary\n\n{glossary}" if glossary else ""

    def build_vocab_table(self) -> str:
        """Compact phrase → resolution lines."""
        lines: list[str] = []
        for term in self._bundle.get("terms", []):
            gov = term.get("governance", {})
            if gov.get("status") != "approved":
                continue
            phrases = term.get("phrases", [])
            if not phrases:
                continue
            phrase_str = " / ".join(f"'{p}'" for p in phrases[:4])
            resolution = term.get("resolution", {})
            res_parts: list[str] = []
            for rk in ("metricId", "dimensionId", "entityId", "timePreset", "filterValue"):
                if rk in resolution:
                    res_parts.append(f"{rk}={resolution[rk]}")
            res_str = ", ".join(res_parts) if res_parts else str(resolution)
            lines.append(f"- {phrase_str} → {res_str}")
        return "\n".join(lines)

    def build_vocab_table_section(self) -> str:
        table = self.build_vocab_table()
        return f"## Business Vocabulary\n\n{table}" if table else ""

    # ─── private helpers ───────────────────────────────────────────────

    def _build_header(self) -> str:
        version = self._bundle.get("ontologyVersion", "unknown")
        return (
            f"## Ontology Context (version: {version})\n\n"
            "The following business knowledge is automatically injected "
            "from the project's Ontology."
        )

    def _build_relationship_summary(self) -> str:
        rels = self._bundle.get("relationships", [])
        approved = [
            r
            for r in rels
            if r.get("governance", {}).get("status") == "approved"
        ]
        if not approved:
            return ""
        approved = approved[:15]
        lines = [
            f"- {r.get('sourceEntity', '?')} --{r.get('predicate', '?')}--> {r.get('targetEntity', '?')}"
            for r in approved
        ]
        return "## Key Entity Relationships\n\n" + "\n".join(lines)
