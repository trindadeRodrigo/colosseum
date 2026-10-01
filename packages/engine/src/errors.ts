export class NotImplementedUntil extends Error {
  constructor(what: string, slot: string) {
    super(`${what} is implemented in slot ${slot} (see docs/structurer/PLAN.md §4)`);
    this.name = 'NotImplementedUntil';
  }
}
