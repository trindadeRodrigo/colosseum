import { type ReactNode, useId } from 'react';
import { cn } from './cn';
import { MockPlate } from './MockPlate';
import { Status, type StatusKind, statusTint } from './StatusMark';

// data-table.md. A financial table: a caption, scoped headers, figures in the mono face on the right,
// a status as a word and a shape (a tinted row alone is not allowed), a scroll region the keyboard
// can reach, and, on a phone, stacked rows when there are more than four columns.
// A yield, a price or an FX figure goes into a cell as a `ProvenancePin`: one pin per figure, never
// one pin for the table.

export type RowStatus = {
  status: StatusKind;
  /** The word: "Out of band", "Breaks in month 14". */
  word: string;
};

export type Column<Row> = {
  key: string;
  /** Sentence case. */
  header: string;
  cell: (row: Row) => ReactNode;
  /** A figure column: on the right, mono, tabular. */
  numeric?: boolean;
  /** A source column: `source · fetched_at · method` in the mono face, muted, cut to one line. */
  source?: boolean;
  /** Projected, not measured: muted, with "projected" in the header. */
  projected?: boolean;
  /** This column names the row. It becomes the row's header, and its heading when rows are stacked. */
  rowHeader?: boolean;
};

export type DataTableLabels = { projected: string };
export const DATA_TABLE_LABELS: DataTableLabels = { projected: 'projected' };

export type DataTableProps<Row> = {
  /** What the table is. Shown above it, or only read out when a card header already says it. */
  caption: string;
  captionHidden?: boolean;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** 28px rows and the condensed face: Monitor and Bearing. */
  dense?: boolean;
  /**
   * A row's status. It adds a status cell (the mark and the word) at the end of the row and tints the
   * row: the tint never appears without the word.
   */
  rowStatus?: (row: Row) => RowStatus | null;
  /** The header of the status column. */
  statusHeader?: string;
  /** A row of mock data: a hatch band on its left edge and the MOCK plate in its first cell. */
  rowMock?: (row: Row) => boolean;
  labels?: Partial<DataTableLabels>;
  className?: string;
};

export function DataTable<Row>({
  caption,
  captionHidden = false,
  columns,
  rows,
  rowKey,
  dense = false,
  rowStatus,
  statusHeader = 'Status',
  rowMock,
  labels,
  className,
}: DataTableProps<Row>) {
  const captionId = useId();
  const text = { ...DATA_TABLE_LABELS, ...labels };
  const width = columns.length + (rowStatus ? 1 : 0);
  const stacks = width > 4;
  const head = columns.find((c) => c.rowHeader) ?? columns[0];
  const height = dense ? 'h-(--tf-row-dense)' : 'h-(--tf-row-comfortable)';
  const face = dense ? 'font-condensed text-b-cell' : 'text-body-sm';

  const cellClass = (column: Column<Row>) =>
    cn(
      'px-3 py-1 align-middle',
      height,
      column.numeric && 'text-right font-mono tabular-nums',
      column.source && 'max-w-[28ch] truncate font-mono text-source text-muted-foreground',
      column.projected && 'text-muted-foreground',
    );

  return (
    <div data-ui="data-table" className={className}>
      <section
        aria-labelledby={captionId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls must be reachable by keyboard (data-table.md)
        tabIndex={0}
        className={cn(
          'overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          stacks && 'max-sm:hidden',
        )}
      >
        <table className={cn('w-full border-collapse text-left', face)}>
          <caption
            id={captionId}
            className={cn(
              captionHidden ? 'sr-only' : 'pb-3 text-left font-sans text-h4 font-semibold',
            )}
          >
            {caption}
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'px-3 py-1 font-sans text-caption font-medium whitespace-nowrap text-muted-foreground',
                    height,
                    column.numeric && 'text-right',
                  )}
                >
                  {column.header}
                  {column.projected && ` (${text.projected})`}
                </th>
              ))}
              {rowStatus && (
                <th
                  scope="col"
                  className={cn(
                    'px-3 py-1 font-sans text-caption font-medium whitespace-nowrap text-muted-foreground',
                    height,
                  )}
                >
                  {statusHeader}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = rowStatus?.(row) ?? null;
              const mock = rowMock?.(row) ?? false;
              return (
                <tr
                  key={rowKey(row)}
                  data-mock={mock || undefined}
                  className={cn(
                    'border-b border-border last:border-b-0',
                    state ? statusTint(state.status) : 'hover:bg-accent',
                  )}
                >
                  {columns.map((column, index) => {
                    const first = index === 0;
                    const content = (
                      <>
                        {first && mock && (
                          <span
                            aria-hidden="true"
                            className="tf-hatch absolute inset-y-0 left-0 w-1.5"
                          />
                        )}
                        {column.cell(row)}
                        {first && mock && <MockPlate className="ml-2" />}
                      </>
                    );
                    const classes = cn(cellClass(column), first && mock && 'relative pl-4.5');
                    return column === head ? (
                      <th key={column.key} scope="row" className={cn(classes, 'font-medium')}>
                        {content}
                      </th>
                    ) : (
                      <td key={column.key} className={classes}>
                        {content}
                      </td>
                    );
                  })}
                  {rowStatus && (
                    <td className={cn('px-3 py-1 align-middle whitespace-nowrap', height)}>
                      {state && <Status status={state.status}>{state.word}</Status>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {stacks && (
        <div data-ui="data-table-stacked" className="sm:hidden">
          <p className={cn(captionHidden ? 'sr-only' : 'pb-3 text-h4 font-semibold')}>{caption}</p>
          <div className="divide-y divide-border border-y border-border">
            {rows.map((row) => {
              const state = rowStatus?.(row) ?? null;
              const mock = rowMock?.(row) ?? false;
              return (
                <div
                  key={rowKey(row)}
                  data-mock={mock || undefined}
                  className={cn(
                    'relative py-3',
                    mock && 'pl-4.5',
                    state && statusTint(state.status),
                  )}
                >
                  {mock && (
                    <span aria-hidden="true" className="tf-hatch absolute inset-y-0 left-0 w-1.5" />
                  )}
                  <p className="flex flex-wrap items-center gap-2 text-body-sm font-medium">
                    {head?.cell(row)}
                    {mock && <MockPlate />}
                  </p>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
                    {columns
                      .filter((column) => column !== head)
                      .map((column) => (
                        <div key={column.key} className="contents">
                          <dt className="text-caption text-muted-foreground">
                            {column.header}
                            {column.projected && ` (${text.projected})`}
                          </dt>
                          <dd
                            className={cn(
                              'text-right',
                              column.numeric && 'font-mono tabular-nums',
                              column.source && 'font-mono text-source text-muted-foreground',
                              column.projected && 'text-muted-foreground',
                            )}
                          >
                            {column.cell(row)}
                          </dd>
                        </div>
                      ))}
                    {state && (
                      <div className="contents">
                        <dt className="text-caption text-muted-foreground">{statusHeader}</dt>
                        <dd className="text-right">
                          <Status status={state.status}>{state.word}</Status>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
