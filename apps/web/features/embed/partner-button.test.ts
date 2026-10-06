import { describe, expect, it } from 'vitest';
import { PARTNER_BUTTON } from './EmbedGoal';

// The partner's button, disabled, as button.md has it: the muted fill, the muted text and a hairline,
// never the button faded to 60% (that fails contrast on a partner's ground).

describe('the embed’s button, disabled', () => {
  it('is muted, not faded', () => {
    const classes = PARTNER_BUTTON.split(' ');
    expect(classes.filter((c) => /opacity/.test(c))).toEqual([]);
    expect(classes).toEqual(
      expect.arrayContaining(['disabled:bg-muted', 'disabled:text-muted-foreground']),
    );
  });
});
