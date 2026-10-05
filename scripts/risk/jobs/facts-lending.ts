// Hourly job com.colosseum.risk-facts-lending (PLAN-ANALYTICS item 18): the lending report, then the import of its
// sheets and coverage into the tables the API reads. The report exits 1 on a leaked address or an invalid sheet,
// which stops the job before the import. Bundled by scripts/risk/jobs/install.sh; RISK_DATA_DIR, RISK_HOLIDAYS and
// RISK_ISSUER_MODELS name the copied inputs (DA8). Runs at minute 20, after the lending import at 12 (DA9).
await import('../lending-report');
await import('../facts/import-lending');

export {};
