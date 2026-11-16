const assert = require('node:assert/strict');
const test = require('node:test');
const { shippingCents } = require('./shipping.cjs');

test('charges standard shipping below 50.00', () => {
  assert.equal(shippingCents(4_999), 490);
});

test('includes free shipping at 50.00', () => {
  assert.equal(shippingCents(5_000), 0);
});

test('includes free shipping above 50.00', () => {
  assert.equal(shippingCents(5_001), 0);
});
