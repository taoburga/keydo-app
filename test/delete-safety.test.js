import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDeleteFailure } from '../lib/delete-safety.js';

test('confirmed failed delete rolls back the staged recovery copy', async () => {
  let rolledBack = false;
  const deleted = await reconcileDeleteFailure({
    verifyExists: async () => true,
    rollback: async () => { rolledBack = true; },
  });
  assert.equal(deleted, false);
  assert.equal(rolledBack, true);
});

test('lost success reply keeps the recovery copy', async () => {
  let rolledBack = false;
  const deleted = await reconcileDeleteFailure({
    verifyExists: async () => false,
    rollback: async () => { rolledBack = true; },
  });
  assert.equal(deleted, true);
  assert.equal(rolledBack, false);
});

test('unknown outcome propagates and never removes the recovery copy', async () => {
  let rolledBack = false;
  await assert.rejects(() => reconcileDeleteFailure({
    verifyExists: async () => { throw new Error('verification unavailable'); },
    rollback: async () => { rolledBack = true; },
  }), /verification unavailable/);
  assert.equal(rolledBack, false);
});
