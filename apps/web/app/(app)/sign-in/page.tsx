import { signInMetadata } from '../../../components/shell/metadata';
import { nextPath } from '../../../features/account/next-path';
import { SignInScreen } from '../../../features/account/SignInScreen';

// Sign-in, on the product's own primitives. `next` is where the person was headed: a page of this app
// and nothing else, so a link cannot send a signed-in person to another site (next-path.ts).

export function generateMetadata() {
  return signInMetadata();
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <SignInScreen next={nextPath(next)} />;
}
