// The least and the most a person can put in at once, in dollars. In a file of its own so a screen
// that only checks an amount (features/mix/DepositStep.tsx) is not built with the invest card, which
// draws the order screen and so reaches the signing port.
export const MIN_USD = 10;
export const MAX_USD = 1_000_000;
