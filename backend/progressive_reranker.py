import math
import pickle
import re
from dataclasses import replace
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from feedback_store import FeedbackStore

try:
    from sklearn.linear_model import LogisticRegression
except Exception:  # pragma: no cover
    LogisticRegression = None


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


class ModelSafetyGuard:
    def __init__(self, max_ndcg_regression: float = 0.05):
        self.max_ndcg_regression = max_ndcg_regression

    def should_deploy(
        self, old_metrics: Optional[Dict[str, Any]], new_metrics: Optional[Dict[str, Any]]
    ) -> bool:
        if not new_metrics:
            return False
        if not old_metrics:
            return True
        return float(new_metrics.get("ndcg", 0.0)) >= (
            float(old_metrics.get("ndcg", 0.0)) - self.max_ndcg_regression
        )


class ClickBoostReRanker:
    MAX_ABS_BOOST = 0.075

    def __init__(self, feedback_store: FeedbackStore):
        self.feedback_store = feedback_store

    def score_candidates(self, candidates: Sequence[Any]) -> Dict[str, float]:
        ticket_ids = [getattr(candidate, "ticket_id", None) for candidate in candidates]
        stats = self.feedback_store.get_ticket_feedback_stats(ticket_ids)
        boosts: Dict[str, float] = {}
        for ticket_id, item in stats.items():
            positive_rate = _safe_float(item.get("weighted_positive_rate"), 0.0)
            raw_boost = (positive_rate - 0.5) * 0.15
            boosts[ticket_id] = max(-self.MAX_ABS_BOOST, min(self.MAX_ABS_BOOST, raw_boost))
        return boosts


class FeatureReRanker:
    def __init__(self, feedback_store: FeedbackStore):
        self.feedback_store = feedback_store
        self.model = None
        self.metrics: Dict[str, Any] = {}

    @property
    def ready(self) -> bool:
        return self.model is not None

    def train(self, rows: Sequence[Dict[str, Any]], index: Any) -> bool:
        if LogisticRegression is None or not rows or index is None:
            return False
        meta_by_ticket = {
            str(meta.get("ticket_id")): meta
            for meta in getattr(index, "_meta", [])
            if meta.get("ticket_id")
        }
        xs: List[List[float]] = []
        ys: List[int] = []
        weights: List[float] = []
        for row in rows:
            meta = meta_by_ticket.get(str(row.get("ticket_id")))
            if not meta:
                continue
            feature_row = self.build_feature_row(
                str(row.get("query_text") or ""),
                meta,
                _safe_float(row.get("base_score"), 0.0),
                self.feedback_store.get_ticket_feedback_stats([meta.get("ticket_id")]).get(meta.get("ticket_id"), {}),
                rank_pos=row.get("rank_pos"),
            )
            signal = str(row.get("signal") or "").lower()
            xs.append(feature_row)
            ys.append(0 if signal == "negative" else 1)
            weights.append(0.3 if signal == "click" else 1.0)
        if len(xs) < 10 or len(set(ys)) < 2:
            return False
        model = LogisticRegression(class_weight="balanced", max_iter=200)
        model.fit(np.asarray(xs, dtype=np.float32), np.asarray(ys, dtype=np.int32), sample_weight=np.asarray(weights, dtype=np.float32))
        self.model = model
        predictions = model.predict_proba(np.asarray(xs, dtype=np.float32))[:, 1]
        self.metrics = {
            "ndcg": self._pseudo_ndcg(predictions, ys),
            "train_size": len(xs),
        }
        return True

    def build_feature_row(
        self,
        query_text: str,
        meta: Dict[str, Any],
        base_similarity: float,
        popularity_stats: Optional[Dict[str, Any]],
        rank_pos: Optional[int] = None,
    ) -> List[float]:
        from duplicate_issue_finder import extract_hints

        hints = extract_hints(query_text)
        project = str(meta.get("project") or "").lower()
        pu = str(meta.get("pu") or "").lower()
        ecu = str(meta.get("ecu") or "").lower()
        lead_model = str(meta.get("lead_model") or "").lower()
        overlap = _token_overlap(query_text, "\n".join(str(meta.get(key) or "") for key in ("name", "description", "project", "pu", "ecu", "lead_model")))
        popularity = popularity_stats or {}
        normalized_rank = 0.0 if rank_pos is None else min(1.0, max(0.0, float(rank_pos) / 50.0))
        return [
            float(base_similarity),
            1.0 if hints.project and hints.project in project else 0.0,
            1.0 if hints.pu and hints.pu in pu else 0.0,
            1.0 if hints.ecu and hints.ecu in ecu else 0.0,
            1.0 if hints.lead_model and hints.lead_model in lead_model else 0.0,
            overlap,
            normalized_rank,
            _safe_float(popularity.get("weighted_positive_rate"), 0.0),
            min(1.0, len(str(query_text or "")) / 120.0),
        ]

    def score_candidates(self, query_text: str, candidates: Sequence[Any], index: Any) -> Dict[str, float]:
        if not self.ready:
            return {}
        meta_by_ticket = {
            str(meta.get("ticket_id")): meta
            for meta in getattr(index, "_meta", [])
            if meta.get("ticket_id")
        }
        stats = self.feedback_store.get_ticket_feedback_stats(
            [getattr(candidate, "ticket_id", None) for candidate in candidates]
        )
        xs: List[List[float]] = []
        ticket_order: List[str] = []
        for rank_pos, candidate in enumerate(candidates):
            ticket_id = getattr(candidate, "ticket_id", None)
            meta = meta_by_ticket.get(str(ticket_id))
            if not ticket_id or not meta:
                continue
            xs.append(
                self.build_feature_row(
                    query_text,
                    meta,
                    _safe_float(getattr(candidate, "similarity", 0.0)),
                    stats.get(ticket_id),
                    rank_pos=rank_pos,
                )
            )
            ticket_order.append(ticket_id)
        if not xs:
            return {}
        probabilities = self.model.predict_proba(np.asarray(xs, dtype=np.float32))[:, 1]
        return {ticket_order[idx]: float(probabilities[idx]) for idx in range(len(ticket_order))}

    @staticmethod
    def _pseudo_ndcg(predictions: Sequence[float], labels: Sequence[int]) -> float:
        pairs = sorted(zip(predictions, labels), key=lambda item: item[0], reverse=True)
        ideal = sorted(labels, reverse=True)
        dcg = 0.0
        for rank, (_, label) in enumerate(pairs, start=1):
            dcg += float(label) / math.log2(rank + 1)
        idcg = 0.0
        for rank, label in enumerate(ideal, start=1):
            idcg += float(label) / math.log2(rank + 1)
        if idcg <= 0:
            return 0.0
        return dcg / idcg


class ContrastiveAdapter:
    def __init__(self):
        self.weights: Optional[np.ndarray] = None
        self.bias: Optional[np.ndarray] = None
        self.loss_history: List[float] = []

    @property
    def ready(self) -> bool:
        return self.weights is not None

    def fit(self, triplets: Sequence[Tuple[np.ndarray, np.ndarray, np.ndarray]]) -> bool:
        if not triplets:
            return False
        anchors = np.vstack([triplet[0] for triplet in triplets]).astype(np.float32)
        positives = np.vstack([triplet[1] for triplet in triplets]).astype(np.float32)
        negatives = np.vstack([triplet[2] for triplet in triplets]).astype(np.float32)
        pos_diff = np.mean(np.abs(anchors - positives), axis=0)
        neg_diff = np.mean(np.abs(anchors - negatives), axis=0)
        margin = np.clip(neg_diff - pos_diff, -0.5, 0.5)
        diagonal = np.clip(1.0 + margin, 0.5, 1.5).astype(np.float32)
        self.weights = diagonal
        self.bias = np.zeros_like(diagonal, dtype=np.float32)
        pos_distance = np.mean(np.linalg.norm((anchors - positives) * diagonal, axis=1))
        neg_distance = np.mean(np.linalg.norm((anchors - negatives) * diagonal, axis=1))
        self.loss_history = [max(0.0, float(pos_distance - neg_distance + 0.2))]
        return True

    def transform(self, values: np.ndarray) -> np.ndarray:
        if not self.ready:
            return values
        projected = values * self.weights
        norms = np.linalg.norm(projected, axis=1, keepdims=True) + 1e-8
        return projected / norms


class ProgressiveReRanker:
    def __init__(self, feedback_store: Optional[FeedbackStore] = None):
        self.feedback_store = feedback_store or FeedbackStore()
        self.click_boost = ClickBoostReRanker(self.feedback_store)
        self.feature_reranker = FeatureReRanker(self.feedback_store)
        self.adapter = ContrastiveAdapter()
        self.safety_guard = ModelSafetyGuard()
        self.model_phase = "click_boost"
        self.feedback_count = 0
        self._last_trained_feedback_count = 0

    @property
    def ready(self) -> bool:
        return True

    def refresh(self, index: Any = None) -> None:
        self.feedback_count = self.feedback_store.count_feedback()
        target_phase = self.feedback_store.scheduler.current_phase(self.feedback_count)
        self.model_phase = "click_boost"
        if target_phase in {"feature", "adapter"} and self.feedback_store.scheduler.should_retrain(
            self.feedback_count, self._last_trained_feedback_count
        ):
            examples = self.feedback_store.get_training_examples()
            trained = self.feature_reranker.train(examples, index=index)
            if trained:
                latest = self.feedback_store.load_latest_model_snapshot()
                metrics = dict(self.feature_reranker.metrics)
                if self.safety_guard.should_deploy(latest["metrics"] if latest else None, metrics):
                    self.feedback_store.save_model_snapshot(
                        phase="feature",
                        model_blob=pickle.dumps(self.feature_reranker.model),
                        metrics=metrics,
                        feedback_count=self.feedback_count,
                    )
                    self.model_phase = "feature"
                    self._last_trained_feedback_count = self.feedback_count
            elif self.feature_reranker.ready:
                self.model_phase = "feature"
            if target_phase == "adapter":
                adapter_trained = self._train_adapter(examples, index=index)
                if adapter_trained:
                    self.model_phase = "adapter"
                    self._last_trained_feedback_count = self.feedback_count
        elif self.feature_reranker.ready:
            self.model_phase = "feature"
            if target_phase == "adapter" and self.adapter.ready:
                self.model_phase = "adapter"
        elif target_phase == "adapter" and self.adapter.ready:
            self.model_phase = "adapter"

    def rerank(
        self,
        query_text: str,
        candidates: Sequence[Any],
        hints: Optional[Any] = None,
        index: Any = None,
        top_k: Optional[int] = None,
    ) -> List[Any]:
        self.refresh(index=index)
        click_boost_scores = self.click_boost.score_candidates(candidates)
        feature_scores = {}
        adapter_scores = {}
        if self.model_phase == "feature" and index is not None:
            feature_scores = self.feature_reranker.score_candidates(query_text, candidates, index=index)
        if self.model_phase == "adapter" and index is not None:
            adapter_scores = self._score_with_adapter(query_text, candidates, index=index)
            if self.feature_reranker.ready:
                feature_scores = self.feature_reranker.score_candidates(query_text, candidates, index=index)
        reranked: List[Tuple[float, Any]] = []
        for candidate in candidates:
            ticket_id = getattr(candidate, "ticket_id", None)
            base_score = _safe_float(getattr(candidate, "similarity", 0.0), 0.0)
            boosted_score = max(0.0, min(1.0, base_score + click_boost_scores.get(ticket_id, 0.0)))
            final_score = boosted_score
            if ticket_id in feature_scores:
                final_score = (0.6 * feature_scores[ticket_id]) + (0.4 * boosted_score)
            if ticket_id in adapter_scores:
                if ticket_id in feature_scores:
                    final_score = (0.5 * feature_scores[ticket_id]) + (0.3 * adapter_scores[ticket_id]) + (0.2 * boosted_score)
                else:
                    final_score = (0.7 * adapter_scores[ticket_id]) + (0.3 * boosted_score)
            reranked.append((final_score, _clone_candidate(candidate, final_score)))
        reranked.sort(key=lambda item: item[0], reverse=True)
        limit = len(reranked) if top_k is None else max(1, int(top_k))
        return [item[1] for item in reranked[:limit]]

    def _train_adapter(self, rows: Sequence[Dict[str, Any]], index: Any) -> bool:
        triplets = self._build_adapter_triplets(rows, index=index)
        if not triplets:
            return False
        trained = self.adapter.fit(triplets)
        if trained:
            diagonal = np.asarray(self.adapter.weights, dtype=np.float32)
            self.feedback_store.save_adapter_weights(
                weight_matrix=np.diag(diagonal).astype(np.float32).tobytes(),
                bias_vector=np.asarray(self.adapter.bias, dtype=np.float32).tobytes(),
                loss_history=self.adapter.loss_history,
                train_pairs=len(triplets),
                ndcg_score=self.feature_reranker.metrics.get("ndcg", 0.0),
            )
        return trained

    def _build_adapter_triplets(
        self, rows: Sequence[Dict[str, Any]], index: Any
    ) -> List[Tuple[np.ndarray, np.ndarray, np.ndarray]]:
        if index is None or getattr(index, "_embedding_matrix", None) is None:
            return []
        meta_by_ticket = {
            str(meta.get("ticket_id")): idx
            for idx, meta in enumerate(getattr(index, "_meta", []))
            if meta.get("ticket_id")
        }
        grouped: Dict[str, Dict[str, List[np.ndarray]]] = {}
        query_texts: Dict[str, str] = {}
        for row in rows:
            ticket_id = str(row.get("ticket_id") or "")
            vector_idx = meta_by_ticket.get(ticket_id)
            if vector_idx is None:
                continue
            signal = str(row.get("signal") or "").lower()
            query_hash = str(row.get("query_hash") or "")
            grouped.setdefault(query_hash, {"positive": [], "negative": []})
            query_texts[query_hash] = str(row.get("query_text") or "")
            if signal == "negative":
                grouped[query_hash]["negative"].append(index._embedding_matrix[vector_idx])
            else:
                grouped[query_hash]["positive"].append(index._embedding_matrix[vector_idx])
        eligible_hashes = [key for key, value in grouped.items() if value["positive"] and value["negative"]]
        if not eligible_hashes:
            return []
        query_embeddings = _encode_query_embeddings([query_texts[key] for key in eligible_hashes])
        triplets: List[Tuple[np.ndarray, np.ndarray, np.ndarray]] = []
        for idx, query_hash in enumerate(eligible_hashes):
            anchor = query_embeddings[idx]
            for positive in grouped[query_hash]["positive"]:
                for negative in grouped[query_hash]["negative"]:
                    triplets.append((anchor, np.asarray(positive, dtype=np.float32), np.asarray(negative, dtype=np.float32)))
        return triplets

    def _score_with_adapter(self, query_text: str, candidates: Sequence[Any], index: Any) -> Dict[str, float]:
        if not self.adapter.ready:
            return {}
        meta_by_ticket = {
            str(meta.get("ticket_id")): idx
            for idx, meta in enumerate(getattr(index, "_meta", []))
            if meta.get("ticket_id")
        }
        query_vector = _encode_query_embeddings([query_text])
        adapted_query = self.adapter.transform(np.asarray(query_vector, dtype=np.float32))[0]
        scores: Dict[str, float] = {}
        for candidate in candidates:
            ticket_id = getattr(candidate, "ticket_id", None)
            vector_idx = meta_by_ticket.get(str(ticket_id))
            if vector_idx is None:
                continue
            candidate_vector = np.asarray(index._embedding_matrix[vector_idx : vector_idx + 1], dtype=np.float32)
            adapted_candidate = self.adapter.transform(candidate_vector)[0]
            scores[str(ticket_id)] = float(np.dot(adapted_query, adapted_candidate))
        return scores


_RERANKER_CACHE: Dict[str, ProgressiveReRanker] = {}


def get_progressive_reranker(db_path: Optional[str] = None) -> ProgressiveReRanker:
    store = FeedbackStore(db_path=db_path) if db_path else FeedbackStore()
    cache_key = store.db_path
    reranker = _RERANKER_CACHE.get(cache_key)
    if reranker is None:
        reranker = ProgressiveReRanker(store)
        _RERANKER_CACHE[cache_key] = reranker
    return reranker


def _clone_candidate(candidate: Any, score: float) -> Any:
    if hasattr(candidate, "__dataclass_fields__"):
        from duplicate_issue_finder import _to_score_1_10

        return replace(candidate, similarity=float(score), score_1_10=_to_score_1_10(score))
    if isinstance(candidate, dict):
        updated = dict(candidate)
        updated["similarity"] = float(score)
        return updated
    setattr(candidate, "similarity", float(score))
    return candidate


def _token_overlap(query_text: str, candidate_text: str) -> float:
    query_tokens = set(re.findall(r"[a-z0-9_./-]{2,}", str(query_text or "").lower()))
    candidate_tokens = set(re.findall(r"[a-z0-9_./-]{2,}", str(candidate_text or "").lower()))
    if not query_tokens or not candidate_tokens:
        return 0.0
    intersection = len(query_tokens & candidate_tokens)
    union = len(query_tokens | candidate_tokens)
    return float(intersection) / float(max(1, union))


def _encode_query_embeddings(queries: Sequence[str]) -> np.ndarray:
    from duplicate_issue_finder import _get_st_model

    model = _get_st_model()
    if model is None:
        raise RuntimeError("sentence-transformer model not available")
    encoded = model.encode(
        list(queries), normalize_embeddings=True, show_progress_bar=False
    )
    return np.asarray(encoded, dtype=np.float32)


__all__ = [
    "ClickBoostReRanker",
    "ContrastiveAdapter",
    "FeatureReRanker",
    "ModelSafetyGuard",
    "ProgressiveReRanker",
    "get_progressive_reranker",
]
