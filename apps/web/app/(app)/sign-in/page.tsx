import { SignInScreen } from '../../../features/account/SignInScreen';

// Sign-in, on the product's own primitives. `next` is where the person was headed: a path of this app
// and nothing else, so a link cannot send a signed-in person to another site.

const HERE = /^\/(?![/\\])[\w\-./]*$/;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <SignInScreen next={typeof next === 'string' && HERE.test(next) ? next : '/goal'} />;
}
