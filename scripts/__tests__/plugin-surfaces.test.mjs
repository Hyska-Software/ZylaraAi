import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkPluginSurfaces } from '../check-plugin-surfaces.mjs';

test('every contract slot/component is mounted or explicitly reserved', () => {
  const result = checkPluginSurfaces();
  assert.deepEqual(result.errors, []);
});
