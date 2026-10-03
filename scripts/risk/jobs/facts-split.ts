// Hourly job com.colosseum.risk-facts-split (PLAN-ANALYTICS item 18): the split snapshot, then the cost breakdown
// that stores its medians on the curve points. Bundled by scripts/risk/jobs/install.sh; RISK_DATA_DIR names the
// data folder (DA8), RISK_HOLIDAYS the copied calendar. Runs at minute 15, after the refresh's compute at 10 (DA9).
await import('../split-snapshot');
await import('../facts/cost-breakdown');

export {};
