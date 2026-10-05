type Cell = { hourOfWeekEt: number; medianCost: number; samples: number };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 7 × 24 grid in US Eastern time: median sell cost per hour of week; empty cells have no samples yet. */
export function HourOfWeekHeatmap({ cells, notionalUsd }: { cells: Cell[]; notionalUsd: number }) {
  const byHow = new Map(cells.map((c) => [c.hourOfWeekEt, c]));
  const max = Math.max(0.0001, ...cells.map((c) => c.medianCost));
  const color = (v: number) => {
    const t = Math.min(1, v / max);
    return `rgb(${Math.round(255 - 30 * (1 - t))}, ${Math.round(245 - 170 * t)}, ${Math.round(235 - 170 * t)})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th />
            {HOURS.map((h) => (
              <th key={h} className="w-6 font-normal text-gray-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((d, di) => (
            <tr key={d}>
              <td className="pr-2 text-gray-500">{d}</td>
              {HOURS.map((h) => {
                const c = byHow.get(di * 24 + h);
                return (
                  <td
                    key={h}
                    title={
                      c
                        ? `${d} ${h}:00 ET · ${(c.medianCost * 100).toFixed(2)}% · ${c.samples} samples`
                        : `${d} ${h}:00 ET · no samples`
                    }
                    className="h-5 w-6 border border-white"
                    style={{ background: c ? color(c.medianCost) : '#f3f4f6' }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-gray-500">
        Median cost of selling ${notionalUsd.toLocaleString('en-US')} through the best single pool,
        by hour of week (US Eastern). Grey = no samples yet. Hover a cell for the value and sample
        count.
      </p>
    </div>
  );
}
