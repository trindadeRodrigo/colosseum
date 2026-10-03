// Hourly lending import job (com.colosseum.risk-lending-import, minute 12): the lending collector's files in
// ~/.colosseum/risk into risk_lending_snapshots and risk_lending_positions (Step 10b item 8). Bundled by install.sh;
// the --history import reads ~/Documents and is run by hand, never from launchd.
await import('../lending-import');

export {};
