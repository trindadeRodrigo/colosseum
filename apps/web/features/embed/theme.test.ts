import { describe, expect, it } from 'vitest';
import { contrast, hatchTooFaint, partnerTheme, themeStyle } from './theme';

// The partner's skin, from the frame's address: each value taken only in a form that can be nothing
// but what it says.

describe('the partner’s skin', () => {
  it('takes colours, a radius, faces and a scheme in their plain forms', () => {
    const theme = partnerTheme({
      fg: '#1E1E1E',
      bg: 'rgb(255, 255, 255)',
      muted: 'oklch(55% 0 0)',
      accent: '#123',
      radius: '14px',
      button: 'pill',
      font: 'Inter, system-ui, sans-serif',
      scheme: 'dark',
    });
    expect(theme).toEqual({
      fg: '#1E1E1E',
      bg: 'rgb(255, 255, 255)',
      muted: 'oklch(55% 0 0)',
      accent: '#123',
      radius: '14px',
      button: '999px',
      font: 'Inter, system-ui, sans-serif',
      scheme: 'dark',
    });
    expect(themeStyle(theme)).toMatchObject({
      '--embed-fg': '#1E1E1E',
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
    expect(partnerTheme({ fg: ['#000', 'url(x)'] })).toEqual({ fg: '#000' });
  });

  it('keeps the word MOCK and drops the hatch when the partner’s muted colour is too faint to see', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    // the guide's sample partner: #6A6A6A on white is 5.4:1, the hatch stays
    expect(hatchTooFaint(partnerTheme({ muted: '#6A6A6A', bg: '#FFFFFF' }))).toBe(false);
    // a pale grey on white is under 4.5:1: no hatch
    expect(hatchTooFaint(partnerTheme({ muted: '#BBBBBB', bg: '#FFFFFF' }))).toBe(true);
    // with no colours named, or in a form not measured here, nothing is dropped
    expect(hatchTooFaint({})).toBe(false);
    expect(hatchTooFaint(partnerTheme({ muted: 'oklch(90% 0 0)', bg: '#FFFFFF' }))).toBe(false);
  });
});
