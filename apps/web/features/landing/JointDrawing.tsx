import { cn } from '../../components/ui/cn';

// The joint as a line drawing (J1 in guidelines.html): what the stage shows where it does not move,
// for reduced motion, without WebGL, or while the 3D scene loads. Exploded, the rail stands off to
// the left of the post with the pin out; seated, it runs through and the pin is in. No figure, no pin.

export function JointDrawing({
  seated,
  title,
  className,
}: {
  seated: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="-2 -3 38 38"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-ui="joint-drawing"
      data-seated={seated}
      className={cn('block', className)}
    >
      <g fill="none" stroke="var(--border)" strokeWidth={0.06}>
        <path d="M7 -1.6H17 M7 -2.1V-1.1 M17 -2.1V-1.1" />
        <path d="M-1 16H33" strokeDasharray="1.2 .5 .1 .5" />
      </g>
      <g
        className="transition-transform duration-(--tf-dur-slide) ease-seat motion-reduce:transition-none"
        style={{ transform: seated ? 'none' : 'translate(-6px, 1px)' }}
      >
        <rect x="1" y="10" width="5" height="12" fill="var(--chart-2)" />
        <rect x="6" y="12" width="24" height="8" fill="var(--chart-2)" />
        <circle cx="25" cy="16" r="2" fill="var(--background)" />
      </g>
      <rect x="6" y="2" width="1" height="28" fill="var(--background)" />
      <rect x="17" y="2" width="1" height="28" fill="var(--background)" />
      <rect x="7" y="2" width="10" height="28" fill="var(--chart-2)" />
      <circle
        cx="25"
        cy="16"
        r="2"
        fill="var(--chart-1)"
        className="transition-opacity duration-(--tf-dur-slide) motion-reduce:transition-none"
        style={{ opacity: seated ? 1 : 0 }}
      />
    </svg>
  );
}
