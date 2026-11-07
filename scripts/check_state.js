'use strict';
// Step-5 verification report: money flow and the price->due effect.
const store = require('../db');

const users = store.all(`SELECT username, role, due, parent_id, created_by FROM users ORDER BY id`);
console.log('users:');
for (const u of users) {
  console.log('  ' + u.username.padEnd(14) + u.role.padEnd(19) + 'due=' + String(u.due).padEnd(7) +
    'created_by=' + u.created_by);
}

console.log('\npayments:');
for (const p of store.all(`SELECT p.id, s.username snd, r.username rcv, p.amount, p.status,
                    substr(p.send_date,1,19) sent, substr(p.received_date,1,19) got
                   FROM payments p LEFT JOIN users s ON s.id=p.sender_id
                   LEFT JOIN users r ON r.id=p.receiver_id ORDER BY p.id`)) {
  console.log('  #' + p.id + ' ' + p.snd + ' -> ' + p.rcv + '  ' + p.amount + '  ' + p.status +
    '  sent ' + p.sent + '  got ' + p.got);
}

console.log('\nrole_prices:');
console.log(store.all(`SELECT rowid id, role, price, cutoff_hour FROM role_prices ORDER BY rowid`)
  .map(r => r.id + ':' + r.role + '=' + r.price + '@' + r.cutoff_hour).join('  '));

console.log('\nsettings:');
console.log(store.all(`SELECT key, value FROM settings ORDER BY key`)
  .map(r => r.key + '=' + r.value).join('  '));
