import { notFound } from 'next/navigation';

// An address no route answers. The app has two root layouts, this group's and the product's, so there
// is no one place for a "not found" page and Next would answer with a bare one, outside both. This
// route catches such an address and answers 404 inside this group's layout, as it did when that
// layout was the only one. Every other route is more specific and wins over it.
export default function Missing(): never {
  notFound();
}
