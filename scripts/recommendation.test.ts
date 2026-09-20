import assert from 'node:assert/strict';
import { buildRecommendation } from '@/lib/recommendation';
import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

/**
 * `difference` on the result is the scraper's own direction (sellerPrice −
 * mainPrice) and is deliberately left wrong-way-round here: the recommendation
 * must not read it, so every case below would break if it started doing so again.
 */
function row(overrides: Partial<JobRow>): JobRow {
  return {
    index: 0, key: 'x', sku: 'x', fsn: 'FSN', targetSeller: 'Anuttar', productUrl: 'https://www.flipkart.com/x',
    status: 'success', currentBankSettlement: 119, bankSettlementThreshold: 115,
    result: {
      fsn: 'FSN', sku: 'x', sellerName: 'Anuttar', buyboxSellerName: 'Other',
      mainPrice: 125, sellerPrice: 119, difference: -6, isPriceDifferent: true,
      productUrl: 'https://www.flipkart.com/x', status: 'OK',
    },
    ...overrides,
  };
}

/** A row with explicit prices, so a case reads as the business states it. */
function priced(ourPrice: number, winnerPrice: number, overrides: Partial<JobRow> = {}): JobRow {
  return row({
    result: {
      ...row({}).result!,
      mainPrice: winnerPrice,
      sellerPrice: ourPrice,
      difference: ourPrice - winnerPrice,
      isPriceDifferent: ourPrice !== winnerPrice,
    },
    ...overrides,
  });
}

/* ------------------------------------------------ Case A — dearer than winner */
// SRPHMHHCGKTUECRY from the live batch: we are ₹22 dear, so the settlement must
// fall to 81 and break the ₹100 minimum. The old maths read 103 + 22 = 125 Safe.
{
  const input = priced(163, 141, { currentBankSettlement: 103, bankSettlementThreshold: 100 });
  const recommendation = buildRecommendation(input);
  assert.equal(recommendation.diffAmount, -22, 'Diff Amount is mainPrice − sellerPrice');
  assert.equal(computeSettlement(input).finalBankSettlement, 81, 'settlement drops to 81');
  assert.equal(recommendation.status, 'Not Safe');
  assert.notEqual(recommendation.status, 'Safe');
  // Not Safe recommends no move, so the settlement stays where it is.
  assert.equal(recommendation.finalBankSettlement, 103);
}

/* --------------------------------------- Case B — settlement equals threshold */
// 120 − 20 = 100 against a minimum of 100. Equal is not greater, so not safe.
{
  const input = priced(150, 130, { currentBankSettlement: 120, bankSettlementThreshold: 100 });
  assert.equal(computeSettlement(input).finalBankSettlement, 100);
  assert.equal(buildRecommendation(input).status, 'Not Safe');
  // The settlement view must agree: equal does not clear the threshold there either.
  assert.equal(computeSettlement(input).category, 'below');
}

/* ---------------------------------------- Case C — settlement above threshold */
// 121 − 20 = 101 against a minimum of 100, and ₹20 is within 20% of ₹150.
{
  const input = priced(150, 130, { currentBankSettlement: 121, bankSettlementThreshold: 100 });
  assert.equal(computeSettlement(input).finalBankSettlement, 101);
  assert.equal(buildRecommendation(input).status, 'Safe');
  assert.equal(buildRecommendation(input).finalBankSettlement, 101);
  assert.equal(computeSettlement(input).category, 'main');
}

/* ------------------------------------------------- Case D — missing threshold */
// No minimum for this SKU: unanswerable, and never quietly Safe.
{
  const recommendation = buildRecommendation(priced(163, 141, { currentBankSettlement: 103, bankSettlementThreshold: undefined }));
  assert.equal(recommendation.status, 'Threshold Missing');
  assert.notEqual(recommendation.status, 'Safe');
  assert.notEqual(recommendation.status, 'Not Safe');
  assert.equal(recommendation.reason, 'No Minimum Bank Settlement for this SKU');
  // The diff is still known and still reported.
  assert.equal(recommendation.diffAmount, -22);
  assert.equal(recommendation.finalBankSettlement, 103);
}

/* --------------------------------------------- Case E — unevaluated, never blank */
{
  const failed = buildRecommendation(row({ result: { ...row({}).result!, status: 'BLOCKED' } }));
  assert.equal(failed.status, 'Need Review');
  assert.equal(failed.reason, 'Scrape failed (BLOCKED)');

  const pending = buildRecommendation(row({ result: undefined, status: 'pending' }));
  assert.equal(pending.status, 'Need Review');
  assert.equal(pending.reason, 'Not yet scraped');

  const ours = buildRecommendation(row({ result: { ...row({}).result!, mainListingIsAccountSeller: true } }));
  assert.equal(ours.status, 'Need Review');
  assert.equal(ours.reason, 'Account already holds the main listing');

  const noPrice = buildRecommendation(row({ result: { ...row({}).result!, mainPrice: null, difference: null } }));
  assert.equal(noPrice.status, 'Need Review');
  assert.equal(noPrice.reason, 'Missing price data');

  const noCurrent = buildRecommendation(priced(163, 141, { currentBankSettlement: undefined }));
  assert.equal(noCurrent.status, 'Need Review');
  assert.equal(noCurrent.reason, 'Missing current bank settlement');

  // Need Review recommends nothing, so the settlement is left as it stands.
  for (const item of [failed, pending, ours, noPrice]) {
    assert.equal(item.finalBankSettlement, 119, 'Need Review keeps the current bank settlement');
  }
  assert.equal(noCurrent.finalBankSettlement, null, 'no current settlement, nothing to keep');

  // The whole point: no row anywhere comes back without a status.
  for (const item of [failed, pending, ours, noPrice, noCurrent]) {
    assert.ok(item.status, 'every row carries a status');
    assert.ok(item.reason, 'an unevaluated row explains itself');
  }
}

/* ------------------------- Case F — current settlement below the minimum */
// The floor runs before anything else: a current settlement of 90 against a
// ₹100 minimum is lifted to 100 first, and only then is the row scored.
{
  // ₹10 cheaper than the buy box. From the raw 90 the final would be 100 —
  // equal to the minimum and therefore Not Safe. From the floored 100 it is
  // 110, which clears it.
  const input = priced(150, 160, { currentBankSettlement: 90, bankSettlementThreshold: 100 });
  const recommendation = buildRecommendation(input);
  assert.equal(recommendation.diffAmount, 10);
  assert.equal(recommendation.status, 'Safe');
  assert.equal(recommendation.finalBankSettlement, 110, 'scored from the lifted 100, not the raw 90');

  // Lifting the base does not turn a losing row into a passing one: ₹22 dear
  // still breaks the minimum, so the call stays Not Safe — reported on the
  // floored settlement, which is where the row now stands.
  const dear = buildRecommendation(priced(163, 141, { currentBankSettlement: 90, bankSettlementThreshold: 100 }));
  assert.equal(dear.status, 'Not Safe');
  assert.equal(dear.finalBankSettlement, 100);

  // A row that could not be scored is still reported on the floored settlement.
  const pending = buildRecommendation(
    priced(150, 160, { currentBankSettlement: 90, bankSettlementThreshold: 100, status: 'pending', result: undefined }),
  );
  assert.equal(pending.status, 'Need Review');
  assert.equal(pending.finalBankSettlement, 100);

  // The floor never lowers anything: a settlement already above its minimum is
  // scored exactly as it was before this step existed.
  const above = priced(150, 130, { currentBankSettlement: 121, bankSettlementThreshold: 100 });
  assert.equal(buildRecommendation(above).finalBankSettlement, 101);
  assert.equal(buildRecommendation(above).status, 'Safe');

  // With no minimum there is nothing to floor to, and the row keeps its own
  // current settlement.
  const noMinimum = buildRecommendation(priced(150, 160, { currentBankSettlement: 90, bankSettlementThreshold: undefined }));
  assert.equal(noMinimum.status, 'Threshold Missing');
  assert.equal(noMinimum.finalBankSettlement, 90);

  // The caller's row is left alone — the lift is local to the recommendation.
  assert.equal(input.currentBankSettlement, 90, 'buildRecommendation does not mutate its input');
}

/* ------------------------------------------------- preserved existing coverage */
// We are ₹6 cheaper than the buy box, so the settlement rises: 119 + 6 = 125 > 115.
assert.deepEqual(buildRecommendation(row({})), { key: 'x', index: 0, sku: 'x', fsn: 'FSN', diffAmount: 6, status: 'Safe', finalBankSettlement: 125, reason: null });
// ₹30 on a ₹100 price is over the 20% band.
{
  const wide = buildRecommendation(priced(100, 130, { currentBankSettlement: 119, bankSettlementThreshold: 115 }));
  assert.equal(wide.status, 'Safe but more than 20%');
  // The move is capped at 20% of our ₹100 price and keeps the diff's upward
  // direction: 119 + 20, not the uncapped 119 + 30.
  assert.equal(wide.finalBankSettlement, 139);
}
// A matched price still scores, and reports a zero diff rather than a blank.
{
  const level = buildRecommendation(priced(150, 150, { currentBankSettlement: 119, bankSettlementThreshold: 115 }));
  assert.equal(level.diffAmount, 0);
  assert.equal(level.status, 'Safe');
  assert.equal(level.finalBankSettlement, 119);
}
// Not Safe outranks the 20% band: breaking the minimum is the more serious call.
// The base must start at or above its minimum for this to be the precedence
// being tested — a sub-minimum base is lifted by the floor first (Case F), so
// it would no longer reach here with the settlement it was written for.
// ₹30 dear on a ₹100 price is over the band, and 119 − 30 = 89 breaks the ₹100
// minimum, so Not Safe wins.
assert.equal(buildRecommendation(priced(100, 70, { currentBankSettlement: 119, bankSettlementThreshold: 100 })).status, 'Not Safe');

/* ------------------------------------------------- row-to-input mapping */
// Every recommendation carries its row's own index and sku, whatever the row's
// status. This is what lets the table and the export be read against the source
// sheet now that the worker pool finishes products out of upload order.
{
  const rows: JobRow[] = [
    row({ index: 0, key: 'a', sku: 'SKU-A', fsn: 'FSN-A' }),
    // Unscraped, so it takes the `unevaluated` path — which must carry the
    // index too, or a Need Review row would lose its place in the file.
    row({ index: 1, key: 'b', sku: 'SKU-B', fsn: 'FSN-B', status: 'pending', result: undefined }),
    row({ index: 2, key: 'c', sku: 'SKU-C', fsn: 'FSN-C' }),
  ];

  const built = rows.map(buildRecommendation);
  assert.deepEqual(built.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(built.map((item) => item.sku), ['SKU-A', 'SKU-B', 'SKU-C']);
  assert.deepEqual(built.map((item) => item.fsn), ['FSN-A', 'FSN-B', 'FSN-C']);
  // The mapping is positional AND keyed, so a reader can verify either way.
  assert.deepEqual(built.map((item) => item.key), ['a', 'b', 'c']);
  assert.equal(built[1].status, 'Need Review');
}

console.log('Recommendation tests passed.');
