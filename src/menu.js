'use strict';
// Builds the sidebar for a role. Icon choices, item order and labels are taken
// from the reference controller markup; a tier simply gets the branch below it.
const { ROLES, ROLE_ORDER, PANEL_LIST_ROUTE, CHAIN_TIERS, boldText } = require('./config');

// Reference uses these icons for each list page. Super Seller has no reference
// equivalent, so it takes the storefront beside the seller's recycle.
const LIST_ICON = {
  developer: 'fas fa-car',
  super_master_admin: 'fas fa-car',
  master_admin: 'fas fa-file',
  admin: 'fas fa-folder',
  super_seller: 'fas fa-store',
  seller: 'fas fa-recycle'
};

// Reference sidebar wording for each tier list, built from the role labels.
// Only the developer entry carries the word "Panel" ("Total Developer Panel"
// vs "Total Master Admin"), which is why the suffix is keyed to that one role.
const LIST_LABEL = CHAIN_TIERS.reduce(function (out, tier) {
  out[tier.role] = 'Total ' + ROLES[tier.role].label + (tier.role === 'developer' ? ' Panel' : '');
  return out;
}, {});

function menuFor(role) {
  const cfg = ROLES[role];
  const isController = role === 'controller';
  const below = ROLE_ORDER.slice(ROLE_ORDER.indexOf(role) + 1).filter(r => PANEL_LIST_ROUTE[r]);

  const items = [];

  items.push({
    href: '/home', icon: 'far fa-calendar-alt', label: 'Dashboard', match: '/home'
  });

  if (cfg.next) {
    items.push({
      href: '/add_user', icon: 'fas fa-th',
      label: 'Add ' + ROLES[cfg.next].label + ' Panel',
      badge: 'New', match: '/add_user'
    });
  }

  if (below.length) {
    items.push({
      icon: 'fas fa-cogs', label: 'Total panel & keys lists', tree: [
        // Reference lists everyone in the subtree first, then one row per tier.
        { href: '/all_user', icon: 'far fa-user', label: 'Total Users', match: '/all_user' },
        ...below.map(r => ({
          href: '/' + PANEL_LIST_ROUTE[r], icon: LIST_ICON[r],
          label: LIST_LABEL[r], match: '/' + PANEL_LIST_ROUTE[r]
        })),
        { href: '/all_key', icon: 'fas fa-key', label: boldText('Total Keys'), match: '/all_key' }
      ]
    });
  } else {
    items.push({ href: '/all_key', icon: 'fas fa-key', label: boldText('Total Keys'), match: '/all_key' });
  }

  items.push({ href: '/transaction', icon: 'fas fa-home', label: 'Transaction', match: '/transaction' });

  if (isController) {
    items.push({ href: '/set_price', icon: 'fas fa-school', label: 'Set Prices', match: '/set_price' });
    items.push({ href: '/link_management', icon: 'fas fa-link', label: 'Link Management', match: '/link_management' });
  }

  items.push({ href: '/news', icon: 'fas fa-store', label: 'News', match: '/news' });
  items.push({ href: '/reports', icon: 'fas fa-chart-pie', label: 'Account & Reports', match: '/reports' });

  if (isController) {
    items.push({
      href: '/token_stats', icon: 'fas fa-satellite-dish',
      label: 'Token Monitor', badge: 'Live', badgeAccent: true, match: '/token_stats'
    });
    items.push({ switchItem: true });
  }

  items.push({ href: '/payment_history', icon: 'fas fa-database', label: 'DUE REVISED PAYMENT', match: '/payment_history' });

  if (isController) {
    items.push({ href: '/today_result', icon: 'fas fa-check', label: 'Today Result', match: '/today_result' });
    items.push({ href: '/top_result', icon: 'fas fa-check', label: 'Top Result', match: '/top_result' });
    items.push({ href: '/transfer_history', icon: 'fas fa-right-left', label: 'Transfer History', match: '/transfer_history' });
  }

  items.push({ href: '/logout', icon: 'fas fa-columns', label: 'Logout' });
  return items;
}

// Which of the 8 dashboard tiles a role sees, and where each one links.
const TILES = [
  { key: 'all',        label: 'Total Keys',        icon: 'fas fa-key',            grad: '#ef4444, #991b1b' },
  { key: 'active',     label: 'Active Keys',        icon: 'fas fa-thumbs-up',      grad: '#10b981, #065f46' },
  { key: 'deactive',   label: 'Deactive Keys',      icon: 'fas fa-thumbs-down',    grad: '#4b5563, #1f2937' },
  { key: 'paid',       label: 'Paid Keys',          icon: 'fas fa-wallet',         grad: '#f59e0b, #92400e' },
  { key: 'unpaid',     label: 'Unpaid Keys',        icon: 'fas fa-money-bill-wave', grad: '#ef4444, #991b1b' },
  { key: 'mac_reg',    label: 'MAC Registered',     icon: 'fas fa-laptop-code',    grad: '#3b82f6, #1e40af' },
  { key: 'mac_unreg',  label: 'MAC Unregistered',   icon: 'fas fa-laptop',         grad: '#06b6d4, #075985' },
  { key: 'expired',    label: 'Expired Keys',       icon: 'fas fa-calendar-times', grad: '#f97316, #9a3412' }
];

module.exports = { menuFor, TILES };
