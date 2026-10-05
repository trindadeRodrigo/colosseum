import { cn } from './cn';

// button.md, the classes. They live apart from Button.tsx so a server component can put them on a
// framework link. What the tokens cannot say: hover and press change the fill and nothing else (no
// scale, no opacity); never a pill; a disabled button is muted, not faded.

export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'chip' | 'icon' | 'destructive';
/** 40px, or 32px in Monitor and Bearing. */
export type ButtonSize = 'default' | 'dense';

export type ButtonState = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  disabled?: boolean;
};

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const PRESSED = 'aria-pressed:border-primary aria-pressed:text-primary';

type Boxed = Exclude<ButtonVariant, 'link'>;

/** The control edge. A disabled destructive button loses its madder edge with its madder text. */
const EDGE: Record<Boxed, string> = {
  primary: '',
  secondary: 'border border-input',
  chip: 'border border-input',
  icon: 'border border-input',
  destructive: 'border border-destructive',
};
const FILL: Record<Boxed, string> = {
  primary: 'bg-primary text-primary-foreground',
  secondary: 'bg-transparent text-foreground',
  chip: cn('bg-transparent text-foreground', PRESSED),
  icon: cn('bg-transparent text-foreground', PRESSED),
  destructive: 'bg-transparent text-destructive',
};
/** What a pointer changes. Left out while the button is busy or disabled. */
const LIVE: Record<Boxed, string> = {
  primary: 'hover:bg-primary-hover active:bg-primary-pressed',
  secondary: 'hover:border-primary hover:text-primary',
  chip: 'hover:bg-accent',
  icon: 'hover:bg-accent',
  destructive: '',
};

function shape(variant: Boxed, size: ButtonSize): string {
  if (variant === 'chip') return 'inline-flex h-8 items-center px-3 text-left text-body-sm';
  if (variant === 'icon')
    return cn('grid place-items-center', size === 'dense' ? 'size-8' : 'size-10');
  return cn(
    'inline-flex items-center justify-center font-medium',
    size === 'dense' ? 'h-8 px-3 text-[0.875rem]/5' : 'h-10 px-4 text-[0.9375rem]/5',
  );
}

/** The classes of a button in a given state. */
export function buttonClass({
  variant = 'secondary',
  size = 'default',
  busy = false,
  disabled = false,
}: ButtonState = {}): string {
  if (variant === 'link')
    return cn(
      'underline decoration-1 underline-offset-4 transition-[text-decoration-thickness]',
      FOCUS,
      disabled ? 'cursor-not-allowed text-muted-foreground' : 'text-primary',
      !disabled && !busy && 'hover:decoration-2',
    );
  return cn(
    shape(variant, size),
    'rounded-md transition-colors',
    FOCUS,
    disabled
      ? cn(
          'cursor-not-allowed bg-muted text-muted-foreground',
          variant === 'primary' ? '' : 'border border-input',
        )
      : cn(EDGE[variant], FILL[variant], !busy && LIVE[variant]),
  );
}
