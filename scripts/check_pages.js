'use strict';
// ---------------------------------------------------------------------------
// The pages that only the controller can open, plus broadcast.
//
// Three things are proved here that the other suites do not touch:
//   * /news — a broadcast reaches the tier it was aimed at, the sender is the
//     only one offered a delete control for it, and deleting takes the row out;
//   * /set_price — a price row can be removed and put back, and while it is gone
//     the page drops that tier from its table;
//   * /reports — a range with keys in it lists them, and a range without any
//     prints the reference's empty state instead of an empty table.
//
// Everything this suite changes it puts back: the news row it sends is deleted
// again, the price row it removes is recreated with the same role, price and
// cutoff, and the last check compares the two tables with what they held before.
// It never calls db:reset and never signs in as one of the owner's own accounts.
// ---------------------------------------------------------------------------
// Writes and deletes news/price rows: only ever against the runner's throwaway DB.
if (!process.env.GALAXY_DB) {
  console.error('Refusing to run against the live database. Use: npm run check');
  process.exit(1);
}
const BASE = process.env.GALAXY_BASE || 'http://localhost:3000';
const store = require('../db');

const CONTROLLER = { user: 'admin', pass: 'admin123' };      // this build's seeded controller
const RECEIVER = { user: 'YOGISELL', pass: 'demo123' };      // seller, the broadcast target
const MARKER = 'MNY-pages-check ' + Date.now();

let failures = 0;
function check(name, want, got) {
  const ok = String(want) === String(got);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got)));
}

function jar() {
  let cookie = '';
  async function send(path, { method = 'GET', body = null } = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: Object.assign(
        { Cookie: cookie },
        body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
      ),
      body: body ? new URLSearchParams(body).toString() : null
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = String(c).split(';')[0];
      if (pair.includes('=')) cookie = pair;
    }
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  }
  return {
    get: (p) => send(p),
    post: (p, body) => send(p, { method: 'POST', body }),
    async enter(username, password) {
      await send('/login', { method: 'POST', body: { username, password } });
      const home = await send('/home');
      if (home.status !== 200) throw new Error('could not sign in as ' + username + ' (status ' + home.status + ')');
      return home;
    }
  };
}

const newsRows = () => JSON.stringify(store.all('SELECT id, body, target_role, created_by FROM news ORDER BY id'));
const priceRows = () => JSON.stringify(store.all('SELECT role, price, cutoff_hour FROM role_prices ORDER BY role'));
const newsOf = (id) => store.get('SELECT * FROM news WHERE id = ?', [id]) || null;

(async function main() {
  const beforeNews = newsRows();
  const beforePrices = priceRows();
  const admin = jar(); await admin.enter(CONTROLLER.user, CONTROLLER.pass);
  const sell = jar(); await sell.enter(RECEIVER.user, RECEIVER.pass);

  // ================================================================== 1. news
  console.log('\n1. a broadcast goes down to the tier it was aimed at');
  const ids0 = store.scalar('SELECT COALESCE(MAX(id), 0) FROM news');
  await admin.post('/news', { news: MARKER, role: 'seller' });
  const row = store.get('SELECT * FROM news WHERE id > ? AND body = ? ORDER BY id DESC LIMIT 1', [ids0, MARKER]);
  check('the row was written', true, !!row);
  check('aimed at sellers', 'seller', row && row.target_role);
  check('signed by the controller', CONTROLLER.user, row && row.created_by);
  check('the senders page lists it', true, (await admin.get('/news')).html.includes(MARKER));
  const sellerHome = (await sell.get('/home')).html;
  check('the target tier reads it on its dashboard', true, sellerHome.includes(MARKER));
  const sellerNews = (await sell.get('/news')).html;
  check('and sees it in its own list', true, sellerNews.includes(MARKER));
  check('but is not offered a delete for someone else’s news', false,
    new RegExp('status_update\\?n_id=' + row.id).test(sellerNews));
  const adminNews = (await admin.get('/news')).html;
  check('the controller is offered the delete', true, new RegExp('status_update\\?n_id=' + row.id).test(adminNews));

  console.log('\n2. deleting it takes the row out of the panel');
  // Final Delete Permission Rule: a tier below the controller cannot delete a
  // broadcast even by hand — the route refuses and the row stays.
  await sell.get('/status_update?n_id=' + row.id);
  check('a seller’s hand-made delete is refused', true, !!newsOf(row.id));
  check('and the seller is told only the controller may', true,
    /Only the controller can delete broadcasts/.test((await sell.get('/news')).html));
  await admin.get('/status_update?n_id=' + row.id);
  check('the controller deleted it', null, newsOf(row.id));
  check('nobody lists it any more', false, (await admin.get('/news')).html.includes(MARKER));
  check('the news table is back to what it held', true, newsRows() === beforeNews);

  console.log('\n2a. an App News broadcast runs in every panel ticker');
  const tickerMarker = MARKER + ' app ticker';
  const tickerIds0 = store.scalar('SELECT COALESCE(MAX(id), 0) FROM news');
  await admin.post('/news', { news: tickerMarker, role: 'appnews' });
  const tickerRow = store.get(
    'SELECT * FROM news WHERE id > ? AND body = ? ORDER BY id DESC LIMIT 1',
    [tickerIds0, tickerMarker]
  );
  check('the App News broadcast was written', true, !!tickerRow);
  check('it appears in the controller ticker', true, (await admin.get('/home')).html.includes(tickerMarker));
  check('it appears in the seller ticker', true, (await sell.get('/home')).html.includes(tickerMarker));
  if (tickerRow) await admin.get('/status_update?n_id=' + tickerRow.id);
  check('the App News test broadcast was removed', null, tickerRow && newsOf(tickerRow.id));

  console.log('\n2b. an All Panels broadcast runs in every panel ticker');
  const allPanelsMarker = MARKER + ' all panels';
  const allPanelsIds0 = store.scalar('SELECT COALESCE(MAX(id), 0) FROM news');
  await admin.post('/news', { news: allPanelsMarker, role: 'allpanels' });
  const allPanelsRow = store.get(
    'SELECT * FROM news WHERE id > ? AND body = ? ORDER BY id DESC LIMIT 1',
    [allPanelsIds0, allPanelsMarker]
  );
  check('the All Panels broadcast was written', true, !!allPanelsRow);
  check('All Panels is listed as a news target', true, (await admin.get('/news')).html.includes('All Panels'));
  check('it appears in the controller ticker', true, (await admin.get('/home')).html.includes(allPanelsMarker));
  const allPanelsSellerHome = (await sell.get('/home')).html;
  check('it appears in the seller ticker', true, allPanelsSellerHome.includes(allPanelsMarker));
  const sellerNotice = allPanelsSellerHome.match(/<div class="notice-box[^"]*">([\s\S]*?)<\/div>/);
  check('it appears in the seller dashboard news box', true,
    !!sellerNotice && sellerNotice[1].includes(allPanelsMarker));
  if (allPanelsRow) await admin.get('/status_update?n_id=' + allPanelsRow.id);
  check('the All Panels test broadcast was removed', null, allPanelsRow && newsOf(allPanelsRow.id));

  console.log('\n2c. every tier can send Personal news to all panels');
  const personalMarker = MARKER + ' personal broadcast';
  const personalIds0 = store.scalar('SELECT COALESCE(MAX(id), 0) FROM news');
  const sellerNewsPage = await sell.get('/news');
  check('Personal is available to a seller', true, sellerNewsPage.html.includes('>Personal</option>'));
  await sell.post('/news', { news: personalMarker, role: 'personal' });
  const personalRow = store.get(
    'SELECT * FROM news WHERE id > ? AND body = ? ORDER BY id DESC LIMIT 1',
    [personalIds0, personalMarker]
  );
  check('the Personal broadcast uses the shared target', 'personal', personalRow && personalRow.target_role);
  check('it appears in the controller ticker', true, (await admin.get('/home')).html.includes(personalMarker));
  check('it appears in the seller ticker', true, (await sell.get('/home')).html.includes(personalMarker));
  check('it appears in the seller dashboard news box', true,
    (await sell.get('/home')).html.includes(personalMarker));
  if (personalRow) await admin.get('/status_update?n_id=' + personalRow.id);
  check('the Personal test broadcast was removed', null, personalRow && newsOf(personalRow.id));

  // =============================================================== 3. set_price
  console.log('\n3. a price row deletes and comes back identical');
  const victim = store.get('SELECT * FROM role_prices ORDER BY rowid DESC LIMIT 1');
  check('there is a price row to test with', true, !!victim);
  const rowid = store.scalar('SELECT rowid FROM role_prices WHERE role = ?', [victim.role]);
  const page = (await admin.get('/set_price')).html;
  check('the page links its delete', true, new RegExp('status_update\\?f_id=' + rowid).test(page));
  check('and names the tier', true, page.toLowerCase().includes(String(victim.role).replace(/_/g, ' ')) ||
    page.includes(victim.role));

  await admin.get('/status_update?f_id=' + rowid);
  check('the row is gone from the table', 0,
    store.scalar('SELECT COUNT(*) FROM role_prices WHERE role = ?', [victim.role]));
  check('and off the page', false, (await admin.get('/set_price')).html.includes('status_update?f_id=' + rowid));

  await admin.post('/set_price', {
    role: victim.role, price: String(victim.price), cutoff_hour: String(victim.cutoff_hour)
  });
  const back = store.get('SELECT * FROM role_prices WHERE role = ?', [victim.role]);
  check('recreated with the same price', Number(victim.price), back && Number(back.price));
  check('the same cutoff', Number(victim.cutoff_hour), back && Number(back.cutoff_hour));
  check('the price table is back to what it held', true, priceRows() === beforePrices);

  // ================================================================ 4. reports
  console.log('\n4. /reports answers for a range with data and one without');
  // Data rows are the ones with cells; the empty state is a single colspan row.
  const dataRows = html => (html.match(/<tbody>([\s\S]*?)<\/tbody>/g) || [])
    .join('').split('</tr>').filter(r => /<td/.test(r) && !/colspan/.test(r)).length;
  const today = new Date().toISOString().slice(0, 10);
  const keys0 = store.scalar('SELECT COUNT(*) FROM keys');
  const wide = await admin.get('/reports?from_date=2000-01-01&to_date=2999-12-31');
  check('a range over everything is a page, not an error', 200, wide.status);
  check('and lists every key', keys0, dataRows(wide.html));
  const empty = await admin.get('/reports?from_date=2000-01-01&to_date=2000-01-02');
  check('an empty range prints the reference’s empty state', true, empty.html.includes('𝐍𝐨 𝐤𝐞𝐲𝐬'));
  check('with no data rows above it', 0, dataRows(empty.html));
  check('today’s own range still opens', 200, (await admin.get('/reports?from_date=' + today + '&to_date=' + today)).status);

  console.log('\n5. nothing else moved');
  check('news rows exactly as found', true, newsRows() === beforeNews);
  check('prices exactly as found', true, priceRows() === beforePrices);
  check('no test broadcast left behind', 0, store.scalar('SELECT COUNT(*) FROM news WHERE body LIKE ?', ['%MNY-pages-check%']));

  console.log('\npage failures: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
