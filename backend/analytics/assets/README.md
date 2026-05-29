Repo-owned mapping assets for offline analytics processing.

The normalized runtime JSON files live in `backend/analytics/assets/data/`.
They are loaded by `backend.analytics.asset_loader` and should be kept in-repo
so the processor can run without TPMDashboard file dependencies.