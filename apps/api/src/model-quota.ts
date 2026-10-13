/** One allowance shared by conversational model entry points in this API process. */
export interface ModelQuota {
  reserve(person: string): 'model_budget_spent' | 'model_person_budget_spent' | null;
}

export function createModelQuota(options: {
  dailyCalls: number;
  dailyCallsPerPerson: number;
  now?: () => Date;
}): ModelQuota {
  const now = options.now ?? (() => new Date());
  let day = '';
  let total = 0;
  const people = new Map<string, number>();
  return {
    reserve(person) {
      const today = now().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        total = 0;
        people.clear();
      }
      const count = people.get(person) ?? 0;
      if (count >= options.dailyCallsPerPerson) return 'model_person_budget_spent';
      if (total >= options.dailyCalls) return 'model_budget_spent';
      total += 1;
      people.set(person, count + 1);
      return null;
    },
  };
}
