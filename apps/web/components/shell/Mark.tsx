// The mark, "the face" (LOGO-2, logo-directions.md "Cuts by size"): a honey tile with the tenon end
// cut into it and a square honey pin set toward the end. Two of the three cuts are drawn here: the
// 24 hint (20 to 27px) and the 16 small cut (12 to 19px); the 32 master lives in the identity files.
// The cut is night on dark grounds and ink elsewhere (`--tf-mark-cut`). `mono` is the monochrome
// variant (the partner credit in the embed, where the brand recedes): the tile and the pin in the
// text colour around it, the cut knocked out.

type Rect = { x: number; y: number; w: number; h: number; r: number };

/** The geometry of each cut, in its own pixel grid. */
const CUTS: Record<16 | 24, { tile: Rect; cut: Rect; pin: Rect }> = {
  24: {
    tile: { x: 0, y: 0, w: 24, h: 24, r: 5 },
    cut: { x: 5, y: 7.5, w: 14, h: 9, r: 1.5 },
    pin: { x: 13.5, y: 10, w: 4, h: 4, r: 0.75 },
  },
  16: {
    tile: { x: 0, y: 0, w: 16, h: 16, r: 4 },
    cut: { x: 3, y: 5, w: 10, h: 6, r: 1 },
    pin: { x: 9, y: 6.5, w: 3, h: 3, r: 0.6 },
  },
};

/** A rounded rectangle as a path, so the cut can be knocked out of the tile (even-odd). */
const outline = ({ x, y, w, h, r }: Rect) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

export function Mark({ size, mono = false }: { size: 16 | 24; mono?: boolean }) {
  const { tile, cut, pin } = CUTS[size];
  // the small cut follows the text it sits in (a credit line); the hint is a fixed 24px
  const box = size === 24 ? { width: 24, height: 24 } : { width: '1.15em', height: '1.15em' };
  return (
    <svg
      {...box}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      data-ui="mark"
      data-cut={size}
      className="shrink-0"
    >
      {mono ? (
        <path fill="currentColor" fillRule="evenodd" d={`${outline(tile)}${outline(cut)}`} />
      ) : (
        <>
          <rect width={tile.w} height={tile.h} rx={tile.r} fill="var(--tf-honey)" />
          <rect
            x={cut.x}
            y={cut.y}
            width={cut.w}
            height={cut.h}
            rx={cut.r}
            fill="var(--tf-mark-cut)"
          />
        </>
      )}
      <rect
        x={pin.x}
        y={pin.y}
        width={pin.w}
        height={pin.h}
        rx={pin.r}
        fill={mono ? 'currentColor' : 'var(--tf-honey)'}
      />
    </svg>
  );
}
