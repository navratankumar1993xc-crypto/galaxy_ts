'use strict';
const news = require('../queries/news');
const prices = require('../queries/prices');
const keyPages = require('./keys');
const userPages = require('./users');

// The reference routes every sidebar toggle through one status_update.php and
// picks the operation from whichever query parameter is present. Same here:
//   ?u_id=  open/close a panel          ?ac_id=  activate/deactivate a key
//   ?r_id=  unregister one key's MAC    ?f_id=   delete a role price row
//   ?n_id=  delete a broadcast
function handle(req, res) {
  const q = req.query;

  if (q.f_id !== undefined) {
    if (res.locals.me.role !== 'controller') {
      req.session.flash = [{ type: 'danger', text: 'Only the controller manages panel prices.' }];
      return res.redirect(req.get('referer') || '/home');
    }
    const row = prices.getById(Number(q.f_id));
    if (!row) {
      req.session.flash = [{ type: 'danger', text: 'That price row is already gone.' }];
      return res.redirect(req.get('referer') || '/set_price');
    }
    prices.removePrice(row.id);
    req.session.flash = [{
      type: 'success',
      text: row.role.charAt(0).toUpperCase() + row.role.slice(1) +
        ' price removed. New panels of that role start with no due until a price is saved again.'
    }];
    return res.redirect(req.get('referer') || '/set_price');
  }

  if (q.n_id !== undefined) {
    // Final Delete Permission Rule: deleting a broadcast is the controller's
    // alone — no tier may delete data, even news it sent itself.
    if (res.locals.me.role !== 'controller') {
      req.session.flash = [{ type: 'danger', text: 'Only the controller can delete broadcasts.' }];
      return res.redirect(req.get('referer') || '/news');
    }
    const note = news.getById(Number(q.n_id));
    if (!note) {
      req.session.flash = [{ type: 'danger', text: 'That broadcast is already gone.' }];
      return res.redirect(req.get('referer') || '/news');
    }
    news.remove(note.id);
    req.session.flash = [{ type: 'success', text: 'Broadcast deleted.' }];
    return res.redirect(req.get('referer') || '/news');
  }

  if (q.r_id !== undefined || q.ac_id !== undefined) return keyPages.statusUpdate(req, res);
  return userPages.statusUpdate(req, res);
}

module.exports = { handle };
