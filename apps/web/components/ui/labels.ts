// The words the client primitives say by default, and the shape of each set. A plain module, apart
// from the components: a module marked 'use client' hands a server component references, not values,
// so a page that wants to read or spread a default label has to get it from here. The components
// re-export the types only. server-safe.test.ts fails if a client module exports anything that is
// not a component.

export type ComposerLabels = {
  /**
   * The name of the button that sends what was typed: "Fit it". A button that shows a word is named
   * by that word instead.
   */
  submit: string;
  /** Said while the text is being read: "Reading your goal…". */
  busy: string;
};
export const COMPOSER_LABELS: ComposerLabels = { submit: 'Fit it', busy: 'Reading your goal…' };

export type ConstraintSheetLabels = {
  title: string;
  parser: string;
  /** The error summary. `{n}` is the number of things to fix. */
  summaryOne: string;
  summaryOther: string;
  /** The same, for fields with nothing in them yet: they are missing, they do not "not fit". */
  missingOne: string;
  missingOther: string;
  goToField: string;
  build: string;
  building: string;
  /** Under a blocked button. `{n}` is the number of fields. */
  fixOne: string;
  fixOther: string;
  /** The same, when every field in question is only empty. */
  fillOne: string;
  fillOther: string;
  reading: string;
  noPlan: string;
  editSheet: string;
  /** In the hint of a field the person changed after the goal was read. */
  edited: string;
  /** Read once by a screen reader after the word MOCK, when the reading is not a live one. */
  mockAnnounce: string;
};
export const CONSTRAINT_SHEET_LABELS: ConstraintSheetLabels = {
  title: 'How we read your goal',
  parser: 'parser',
  summaryOne: '1 thing doesn’t fit yet. Fix it to build the plan.',
  summaryOther: '{n} things don’t fit yet. Fix them to build the plan.',
  missingOne: '1 thing is still missing. Fill it in to build the plan.',
  missingOther: '{n} things are still missing. Fill them in to build the plan.',
  goToField: 'Go to field',
  build: 'Build my plan',
  building: 'Building your plan…',
  fixOne: 'Fix the field above to continue.',
  fixOther: 'Fix the {n} fields above to continue.',
  fillOne: 'Fill in the field above to continue.',
  fillOther: 'Fill in the {n} fields above to continue.',
  reading: 'Reading your goal…',
  noPlan: 'No plan fits these limits.',
  editSheet: 'Edit sheet',
  edited: 'edited',
  mockAnnounce: ': sample data, not live',
};

export type CompactNavLabels = { skip: string; main: string; menu: string };
export const COMPACT_NAV_LABELS: CompactNavLabels = {
  skip: 'Skip to content',
  main: 'Main',
  menu: 'Menu',
};

export type CopyButtonLabels = { copy: string; copied: string };
export const COPY_BUTTON_LABELS: CopyButtonLabels = { copy: 'Copy', copied: 'Copied' };

export type SubscribeStatus =
  | 'rest'
  /** On submit: the address does not look complete. */
  | 'invalid-email'
  | 'no-option'
  | 'submitting'
  | 'success'
  | 'already'
  | 'error';

export type SubscribeLabels = {
  email: string;
  subscribe: string;
  subscribing: string;
  /** The name of the group of checkboxes. */
  group: string;
  status: Record<SubscribeStatus, string>;
};
export const SUBSCRIBE_LABELS: SubscribeLabels = {
  email: 'Email address',
  subscribe: 'Subscribe',
  subscribing: 'Subscribing…',
  group: 'What to receive',
  status: {
    rest: 'Unsubscribe any time.',
    'invalid-email': 'That email doesn’t look complete. Check for an @ and a domain.',
    'no-option': 'Pick at least one: product updates or the newsletter.',
    submitting: 'Subscribing…',
    success: 'Check your inbox to confirm.',
    already: 'You’re already on the list.',
    error: 'We couldn’t save that just now. Try again in a minute.',
  },
};
