// The one icon wrapper (identity/iconography.md). Icons are wayfinding, never decoration: one stroke
// of 1.5px at every size, square caps, miter joins, no fill, the colour of the text around them.
// The registry holds only what the primitives use. Each drawing sits on the 24 grid inside the 2px
// keyline. Adding an icon takes a look at the banned list in iconography.md, section 6.
//
// The spec names lucide-react as the source of the drawings. It is not installed: these seven are
// plain geometry, drawn here to the same construction, and swapping the registry for the pinned
// package later changes this file only.

const REGISTRY = {
  ArrowUp: ['M12 20V4', 'M5 11L12 4L19 11'],
  ArrowUpRight: ['M7 17L17 7', 'M8 7H17V16'],
  Check: ['M4 12L9 17L20 6'],
  ChevronDown: ['M6 9L12 15L18 9'],
  Copy: ['M9 9H20V20H9Z', 'M15 9V4H4V15H9'],
  Menu: ['M4 6H20', 'M4 12H20', 'M4 18H20'],
  X: ['M6 6L18 18', 'M18 6L6 18'],
} as const;

export type IconName = keyof typeof REGISTRY;
/** Inline 16, default UI 20, feature 24, hero 32. Above 32 use a drawing, not an icon. */
export type IconSize = 16 | 20 | 24 | 32;

export type IconProps = {
  name: IconName;
  size?: IconSize;
  /** The accessible name. Leave it out when the icon sits beside text that already says it. */
  label?: string;
  className?: string;
};

export function Icon({ name, size = 20, label, className }: IconProps) {
  return (
    <svg
      data-ui="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.5 * 24) / size}
      strokeLinecap="square"
      strokeLinejoin="miter"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
    >
      {REGISTRY[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
