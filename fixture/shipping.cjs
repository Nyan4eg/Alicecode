function shippingCents(subtotalCents) {
  const freeShippingThresholdCents = 5_000;
  const standardShippingCents = 490;

  return subtotalCents > freeShippingThresholdCents ? 0 : standardShippingCents;
}

module.exports = { shippingCents };
