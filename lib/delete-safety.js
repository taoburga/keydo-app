// Reconcile a failed delete call without guessing whether the irreversible
// EventKit mutation committed before its reply was lost.
//
// Returns true when a fresh read proves the target is gone, false when it
// proves the target still exists. Verification errors propagate and MUST leave
// the recovery snapshot intact.
export async function reconcileDeleteFailure({ verifyExists, rollback }) {
  const stillExists = await verifyExists();
  if (!stillExists) return true;
  await rollback();
  return false;
}
