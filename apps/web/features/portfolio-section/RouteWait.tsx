'use client';
import { CardWait, Wait } from '../../components/shell/Wait';
import { Card } from '../../components/ui/Card';
import { SkeletonCards, SkeletonText } from '../../components/ui/Skeleton';
import { useWords } from './words';

// What a page of the section shows while it is made on the server (its `loading.tsx`), inside the
// section's frame: the shape of what comes, and the wait in words. The pages' own waits take over
// once they run.

/** A page that reads the person's plans: cards to come. */
export function RouteWait() {
  const w = useWords();
  return (
    <Card>
      <CardWait label={w.shell.reading} skeleton={<SkeletonCards count={2} />} />
    </Card>
  );
}

/** The methodology, which reads nothing: its text to come. */
export function TextWait() {
  const w = useWords();
  return <Wait label={w.methodology.label} skeleton={<SkeletonText lines={6} />} />;
}
