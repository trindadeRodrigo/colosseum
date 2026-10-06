import { describe, expect, it } from 'vitest';
import { contrast, FLOOR, partnerTheme, themeStyle } from './theme';

// The partner's skin, from the frame's address: each value taken only in a form that can be nothing
// but what it says, and the colours only where the disclaimer, the pins and MOCK stay readable.

const SAMPLE = {
  fg: '#1E1E1E',
  bg: '#FFFFFF',
  muted: '#6A6A6A',
  border: '#E4E4E4',
  accent: '#1E1E1E',
};

describe('the partner’s skin', () => {
  it('takes opaque colours, a radius, a button, faces and a scheme in their plain forms', () => {
    const theme = partnerTheme({
      ...SAMPLE,
      radius: '14px',
      button: 'pill',
      font: 'Inter, system-ui, sans-serif',
      scheme: 'dark',
    });
    expect(theme).toEqual({
      ...SAMPLE,
      radius: '14px',
      button: '999px',
      font: 'Inter, system-ui, sans-serif',
      scheme: 'dark',
    });
    expect(themeStyle(theme)).toMatchObject({
      '--embed-fg': '#1E1E1E',
      '--embed-bg': '#FFFFFF',
      '--embed-muted': '#6A6A6A',
      '--embed-radius': '14px',
      '--embed-button-radius': '999px',
      '--embed-font': 'Inter, system-ui, sans-serif',
      colorScheme: 'dark',
    });
  });

  it('drops anything that could be more than a value, and leaves the system’s colours in its place', () => {
    const theme = partnerTheme({
      fg: 'red; background: url(https://evil.example/x)',
      bg: 'url(https://evil.example/x)',
      muted: 'var(--secret)',
      accent: 'expression(alert(1))',
      radius: '14px; color: red',
      button: '9999px',
      font: 'x;}body{display:none',
      scheme: 'sepia',
    });
    expect(theme).toEqual({});
    expect(themeStyle(theme)).toEqual({});
    // and a list of values is read for its first only
    expect(partnerTheme({ ...SAMPLE, fg: ['#000000', 'url(x)'] }).fg).toBe('#000000');
  });

  it('takes no colour that can be see-through, or in a form it cannot measure', () => {
    for (const fg of [
      '#0000',
      '#00000000',
      '#000',
      'rgba(0,0,0,0)',
      'rgb(0,0,0)',
      'transparent',
      'oklch(0% 0 0)',
    ])
      expect(partnerTheme({ ...SAMPLE, fg }), fg).toEqual({});
    expect(partnerTheme({ ...SAMPLE, muted: '#6A6A6A00' }).muted).toBeUndefined();
  });

  it('takes the text colour only at 4.5:1 or more on the ground, and neither one without the other', () => {
    expect(FLOOR).toBe(4.5);
    // the same colour twice: the disclaimer would be invisible
    expect(partnerTheme({ fg: '#FFFFFF', bg: '#FFFFFF', muted: '#FFFFFF' })).toEqual({});
    // just under the floor, and just over it
    expect(contrast('#777777', '#FFFFFF')).toBeLessThan(4.5);
    expect(partnerTheme({ fg: '#777777', bg: '#FFFFFF' })).toEqual({});
    expect(contrast('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(partnerTheme({ fg: '#767676', bg: '#FFFFFF' })).toEqual({
      fg: '#767676',
      bg: '#FFFFFF',
    });
    // a text colour with no ground, or a ground with no text colour, is not taken
    expect(partnerTheme({ fg: '#1E1E1E' })).toEqual({});
    expect(partnerTheme({ bg: '#000000' })).toEqual({});
  });

  it('takes the muted colour and the accent only at 4.5:1 on the ground, and mutes in the text colour otherwise', () => {
    const faint = partnerTheme({ ...SAMPLE, muted: '#BBBBBB', accent: '#EEEEEE' });
    expect(faint.muted).toBeUndefined();
    expect(faint.accent).toBeUndefined();
    expect(themeStyle(faint)).toMatchObject({ '--embed-muted': '#1E1E1E' });
    // with no ground taken, no muted colour, accent or border either
    expect(partnerTheme({ muted: '#6A6A6A', accent: '#1E1E1E', border: '#E4E4E4' })).toEqual({});
    // his dark sample clears the floor
    expect(
      partnerTheme({
        fg: '#EEEEEE',
        bg: '#17171A',
        muted: '#A0A0A0',
        border: '#2C2C30',
        accent: '#EEEEEE',
      }),
    ).toEqual({
      fg: '#EEEEEE',
      bg: '#17171A',
      muted: '#A0A0A0',
      border: '#2C2C30',
      accent: '#EEEEEE',
    });
  });
});
