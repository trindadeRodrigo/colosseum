import { redirect } from 'next/navigation';

// The goal screen was here until home was rebuilt on the primitives (WEB-2). It is home now; an old
// link to /goal still lands on it.

export default function GoalPage() {
  redirect('/');
}
