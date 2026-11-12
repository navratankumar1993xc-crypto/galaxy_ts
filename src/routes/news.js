'use strict';
const news = require('../queries/news');

function back(req) {
  return req.get('referer') || '/news';
}

function flash(req, type, text) {
  req.session.flash = [{ type, text }];
}

// ---------------------------------------------------------------- /news
// Every tier opens the same page. The compose card only appears when that
// tier has someone below it to address, and each row carries a `mine` flag so
// only the sender sees its delete button.
function page(req, res) {
  const me = res.locals.me;
  const targets = news.targetsFor(me.role);
  const rows = news.listScoped(me.role, me.username).map(function (n) {
    n.mine = n.created_by === me.username;
    // The scope badge prints the stored target with underscores replaced,
    // which the badge's uppercase style then renders as "MASTER ADMIN".
    n.scope = news.TARGET_LABEL[n.target_role] || n.target_role.replace(/_/g, ' ');
    return n;
  });
  res.render('tiers/news', { targets, rows });
}

function send(req, res) {
  const me = res.locals.me;
  const body = String(req.body.news || '').trim();
  const target = String(req.body.role || '');

  if (!body) {
    flash(req, 'danger', 'Write something before sending news.');
    return res.redirect(back(req));
  }
  const allowed = news.targetsFor(me.role).map(t => t.value);
  if (!allowed.includes(target)) {
    flash(req, 'danger', 'Your panel cannot broadcast to that audience.');
    return res.redirect(back(req));
  }

  news.send(body, target, me.username);
  flash(req, 'success', 'News sent to ' + news.TARGET_LABEL[target] + '.');
  res.redirect(back(req));
}

module.exports = { page, send };
