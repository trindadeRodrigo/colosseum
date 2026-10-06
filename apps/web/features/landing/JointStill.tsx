import { cn } from '../../components/ui/cn';

// The joint as a still: frames of the same scene (joint-scene.ts, `still`), the pieces whole in the
// frame, rendered once and served from this app (`public/landing/joint/`, made by
// scripts/joint-stills.mjs). It stands where the 3D cannot run (no WebGL) or must not move (reduced
// motion). The page's theme picks the black or the paper frame with CSS alone: `.dark`, or the
// system's dark while the person has not chosen (`.tf-auto`). Both are lazy, so only the one shown
// is fetched.

const SRC = '/landing/joint/joint-';

/** Shown on black: under `.dark`, or `.tf-auto` while the system is dark. */
const ON_DARK = 'hidden dark:block [@media(prefers-color-scheme:dark)]:[:root.tf-auto_&]:block';
/** Shown on paper: everywhere else. */
const ON_PAPER = 'block dark:hidden [@media(prefers-color-scheme:dark)]:[:root.tf-auto_&]:hidden';

export function JointStill({
  seated,
  alt,
  className,
}: {
  seated: boolean;
  /** Named for a reader where it stands for the stage (only the frame the theme shows is read). */
  alt?: string;
  className?: string;
}) {
  const state = seated ? 'seated' : 'apart';
  return (
    <div
      aria-hidden={alt ? undefined : true}
      data-ui="joint-still"
      data-seated={seated}
      className={cn('relative aspect-square', className)}
    >
      {(['dark', 'light'] as const).map((ground) => (
        // biome-ignore lint/performance/noImgElement: two small frames of one size, one of them hidden by the theme; the image service would only add a hop
        <img
          key={ground}
          src={`${SRC}${state}-${ground}.webp`}
          alt={alt ?? ''}
          width={960}
          height={960}
          loading="lazy"
          decoding="async"
          className={cn('absolute inset-0 size-full', ground === 'dark' ? ON_DARK : ON_PAPER)}
        />
      ))}
    </div>
  );
}
