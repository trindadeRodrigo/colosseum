// Hourly refresh job (com.colosseum.risk-refresh): import the collectors' files into Postgres, then recompute
// the asset curves. Bundled with its dependencies by install.sh; RISK_HOLIDAYS points at the copied calendar.
await import('../import');
await import('../compute');

export {};
