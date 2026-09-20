/**
 * Selector regression suite — run with `npm run verify`.
 *
 * Replays the extractors against the checked-in HTML snapshots, so you can tell
 * "Flipkart changed their DOM" apart from "the network/product is having a bad
 * day" without launching a live scrape.
 *
 * When Flipkart ships a redesign: re-save the two snapshots, run this, and fix
 * whatever goes red in `selectors.ts`.
 *
 * NOTE: runs with JavaScript DISABLED. The saved pages ship their own React
 * bundle, which fails to hydrate offline and wipes the DOM about a second after
 * load. With JS off the markup stays exactly as captured.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkAvailability,
  findSellerListEntry,
  getFulfilledBy,
  getMainPrice,
  readProductJsonLd,
} from './productPage';
import { extractSellers, findSellerByNameAnchored, showMoreButton } from './sellerDrawer';
import { comparePrice, findSeller, parsePrice, pickBuyboxSeller } from './parser';
import { readBuyboxHtml } from './buyboxProbe';
import { readSellerApi } from './sellerApi';
import { resolveOptions, setVerbose } from './utils';

const ROOT = join(__dirname, '..');
const PDP = join(ROOT, 'product-detailpage.html');
const SELLERS = join(ROOT, 'after-click-see-more-seller.html');
const SELLERS_DESKTOP = join(ROOT, 'all-sellers.html');
/** A real reply from the endpoint the /sellers page calls, pid=STIH9DCHWXFCYWNN. */
const SELLER_API = join(ROOT, 'product-sellers-api.json');

const options = resolveOptions({ timeout: 3_000 });

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  const suffix = ok ? '' : `   expected ${JSON.stringify(expected)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(actual)}${suffix}`);
}

async function main(): Promise<void> {
  setVerbose(false);

  for (const file of [PDP, SELLERS, SELLERS_DESKTOP, SELLER_API]) {
    if (!existsSync(file)) {
      console.error(`Missing snapshot: ${file}`);
      process.exit(2);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  // Allow only local-disk reads. The snapshots reference assets with
  // protocol-relative URLs ("//static-assets-web.flixcart.com/..."), which under
  // file:// resolve to Windows UNC network paths that hang for 30s+ — and since
  // the stylesheets are render-blocking, domcontentloaded never fires and goto
  // times out.
  //
  // The host is what separates them: a real local file is "file:///C:/..." with
  // an EMPTY host, whereas the UNC form is "file://static-assets-web.../...".
  // Matching on the "file:" scheme alone lets the UNC requests straight through,
  // so the triple slash is load-bearing here.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith('file:///') ? route.continue() : route.abort();
  });

  try {
    console.log('\nparser (no browser)');
    check('parsePrice ₹1,234', parsePrice('₹1,234'), 1234);
    check('parsePrice Rs. 99.50', parsePrice('Rs. 99.50'), 99.5);
    check('parsePrice bare 1,234', parsePrice('1,234'), 1234);
    check('parsePrice rejects "86% off"', parsePrice('86% off'), null);
    check('parsePrice empty', parsePrice(''), null);

    console.log('\nproduct page');
    await page.goto(pathToFileURL(PDP).toString(), { waitUntil: 'domcontentloaded' });
    const jsonLd = await readProductJsonLd(page);
    check('jsonLd.sku', jsonLd?.sku, 'KMTHGNNHMYWQHJN7');
    check('jsonLd.price', jsonLd?.price, 236);
    check('availability (null = in stock)', await checkAvailability(page, jsonLd), null);
    check('getMainPrice via JSON-LD', await getMainPrice(page, jsonLd, options), 236);
    // Must be 236, NOT the 265 sponsored-carousel price that precedes the <h1>.
    check('getMainPrice fallback ignores ad carousel', await getMainPrice(page, null, options), 236);
    // The PDP's delivery block reads "Fulfilled by Hcom" — this is the winning seller.
    check('getFulfilledBy', await getFulfilledBy(page), 'Hcom');

    // The same three facts, read straight out of the served HTML with no browser
    // involved. These MUST agree with the DOM answers above: the buy-box probe
    // ends a product on them, and a silent disagreement would end it wrongly.
    console.log('\nbuy-box probe (raw HTML, no rendering)');
    const reading = readBuyboxHtml(readFileSync(PDP, 'utf8'));
    check('readBuyboxHtml.fulfilledBy', reading.fulfilledBy, 'Hcom');
    check('readBuyboxHtml.jsonLd.price', reading.jsonLd?.price, 236);
    check('readBuyboxHtml.jsonLd.sku', reading.jsonLd?.sku, 'KMTHGNNHMYWQHJN7');
    check('readBuyboxHtml.blocked', reading.blocked, null);
    check('readBuyboxHtml.unavailable', reading.unavailable, null);

    const entry = await findSellerListEntry(page, jsonLd, 'https://www.flipkart.com/x/p/itm?pid=KMTHGNNHMYWQHJN7');
    check('"See other sellers" located', entry.link !== null, true);
    check('seller URL carries the pid', /pid=KMTHGNNHMYWQHJN7$/.test(entry.url ?? ''), true);

    console.log('\nseller list');
    await page.goto(pathToFileURL(SELLERS).toString(), { waitUntil: 'domcontentloaded' });
    const sellers = await extractSellers(page);
    check('seller count', sellers.length, 10);
    check(
      'seller names',
      sellers.map((s) => s.name),
      ['FALAKONLINESTORE', 'TAPEMAN', 'SamalEcom', 'RaaghavTraders', 'DFIXVENTURE', 'JSEMPIRES', 'Selligo', 'MALBEC', 'pranitgunjal', 'ShopppingDilSe'],
    );
    check(
      'selling prices (not the struck MRP)',
      sellers.map((s) => s.price),
      [118, 130, 132, 132, 133, 133, 133, 135, 138, 139],
    );
    check('every price is below its MRP', sellers.every((s) => s.price! < s.mrp!), true);
    check('findSeller exact', findSeller(sellers, 'MALBEC')?.price, 135);
    check('findSeller case-insensitive', findSeller(sellers, 'malbec')?.price, 135);
    check('findSeller spacing-tolerant', findSeller(sellers, 'Shoppping Dil Se')?.price, 139);
    check('findSeller absent seller', findSeller(sellers, 'AYANSHENTERPRISEE'), null);
    check('buybox seller = the card priced at the PDP price', pickBuyboxSeller(sellers, 135, true)?.name, 'MALBEC');
    check(
      'buybox falls back to the first card when no price matches',
      pickBuyboxSeller(sellers, 999, true)?.name,
      'FALAKONLINESTORE',
    );
    check('buybox stays null for an unordered (network) list', pickBuyboxSeller(sellers, 999, false), null);
    check('"show more" matched once (not the "Got it" button)', await showMoreButton(page).count(), 1);
    check('"show more" text', (await showMoreButton(page).textContent())?.trim(), 'show more');

    console.log('\nseller list — desktop layout (all-sellers.html)');
    await page.goto(pathToFileURL(SELLERS_DESKTOP).toString(), { waitUntil: 'domcontentloaded' });
    const desktop = await extractSellers(page);
    check('seller count', desktop.length, 5);
    check(
      'seller names',
      desktop.map((s) => s.name),
      ['SPN1', 'TREVIAA', 'JAYGOPALENTERPRISEE', 'AONEENTERPRISES01', 'laxminarayannnn'],
    );
    // The regression that motivated this layout: each desktop card embeds bank
    // offers reading "Flat ₹50 off" / "₹75 Cashback". A lowest-price-wins
    // extractor reports TREVIAA at ₹50 instead of ₹200.
    check(
      'prices are not poisoned by in-card bank offers',
      desktop.map((s) => s.price),
      [200, 200, 158, 161, 136],
    );
    check('findSeller TREVIAA', findSeller(desktop, 'TREVIAA')?.price, 200);
    // SPN1 and TREVIAA both sit at the ₹200 main price; the page listed SPN1 first.
    check('buybox winner on a price tie is the first listed', pickBuyboxSeller(desktop, 200, true)?.name, 'SPN1');
    check('no "show more" on this layout', await showMoreButton(page).count(), 0);
    check('TREVIAA vs main price 200', comparePrice(200, findSeller(desktop, 'TREVIAA')!.price), {
      difference: 0,
      isPriceDifferent: false,
    });
    check('text anchor agrees on TREVIAA', (await findSellerByNameAnchored(page, 'TREVIAA'))?.price, 200);

    console.log('\nresilience: every seller-card class stripped');
    await page.goto(pathToFileURL(SELLERS).toString(), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      for (const cls of ['eXlcRr', 'b1jAQQ', 'XVCSsK', 'RdHagW']) {
        document.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
      }
    });
    check('structured extraction degrades to empty', (await extractSellers(page)).length, 0);
    check('text anchor still finds MALBEC', (await findSellerByNameAnchored(page, 'MALBEC'))?.price, 135);
    check('text anchor ignores the 4.1 rating', (await findSellerByNameAnchored(page, 'TAPEMAN'))?.price, 130);

    console.log('\nseller API payload (product-sellers-api.json)');
    const api = readSellerApi(JSON.parse(readFileSync(SELLER_API, 'utf8')));
    check('headline price', api?.mainPrice, 130);
    check('buy-box listing names its seller', api?.buyboxSeller, 'vedant9110');
    check('complete seller list in one reply', api?.sellers.length, 10);
    check(
      'seller names',
      api?.sellers.map((s) => s.name),
      [
        'vedant9110',
        'AARADHYA SELLS',
        'Previx',
        'VARSOENTERPRISE',
        'Shrivyaa',
        'VIREXA',
        'BhavaniTraders14',
        'Anuttar',
        'JAYGOPALENTERPRISEE',
        'MobiXO',
      ],
    );
    check(
      'prices',
      api?.sellers.map((s) => s.price),
      [130, 129, 130, 130, 143, 140, 146, 143, 159, 228],
    );
    check('MRP is read from the struck-off entry', api?.sellers[0].mrp, 559);
    check('findSeller works on API cards', findSeller(api?.sellers ?? [], 'previx')?.price, 130);

    console.log('\nseller API: incomplete replies are refused, never guessed');
    check('no RESPONSE', readSellerApi({}), null);
    check('no price', readSellerApi({ RESPONSE: { data: { product_seller_detail_1: { data: [] } } } }), null);
    check(
      'price but no sellers',
      readSellerApi({
        RESPONSE: {
          pageContext: { pricing: { finalPrice: { value: 99 } } },
          data: { product_seller_detail_1: { data: [] } },
        },
      }),
      null,
    );
    check(
      'buy box falls back to the selected row when no listing id matches',
      readSellerApi({
        RESPONSE: {
          pageContext: { pricing: { finalPrice: { value: 99 } }, listingId: 'LSTNOTHERE' },
          data: {
            product_seller_detail_1: {
              data: [
                { value: { listingId: 'LST1', sellerInfo: { value: { name: 'First' } }, pricing: { value: { finalPrice: { value: 99 } } } } },
                { value: { listingId: 'LST2', selected: true, sellerInfo: { value: { name: 'Second' } }, pricing: { value: { finalPrice: { value: 120 } } } } },
              ],
            },
          },
        },
      })?.buyboxSeller,
      'Second',
    );
    check(
      'a nameless row is a skeleton, not a seller',
      readSellerApi({
        RESPONSE: {
          pageContext: { pricing: { finalPrice: { value: 99 } }, listingId: 'LST1' },
          data: {
            product_seller_detail_1: {
              data: [
                { value: { listingId: 'LST1', sellerInfo: { value: { name: 'Real' } }, pricing: { value: { finalPrice: { value: 99 } } } } },
                { value: { listingId: 'LST2', sellerInfo: { value: { name: '  ' } }, pricing: { value: { finalPrice: { value: 120 } } } } },
              ],
            },
          },
        },
      })?.sellers.length,
      1,
    );

    console.log('\ncomparison');
    check('236 vs 135', comparePrice(236, 135), { difference: -101, isPriceDifferent: true });
    check('identical prices', comparePrice(135, 135), { difference: 0, isPriceDifferent: false });
    check('missing side', comparePrice(null, 135), { difference: null, isPriceDifferent: false });
  } finally {
    await browser.close().catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
