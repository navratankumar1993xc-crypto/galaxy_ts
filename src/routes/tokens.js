'use strict';
const store = require('../../db');
const tokens = require('../queries/tokens');
const { TOKEN_STATS } = require('../pageStyle');
const { dateLabel } = require('../config');

// Reference clock labels: "07 Nov 2026" and "12:00 PM - 12:59 PM".
function hourLabel() {
  const hour = Number(store.scalar(`SELECT CAST(strftime('%H','now','localtime') AS INTEGER)`));
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return display + ':00 ' + suffix + ' - ' + display + ':59 ' + suffix;
}

// ------------------------------------------------------------ /token_stats
// Controller-only monitor. The real system fills `tokens` from the client
// software; locally /api/token is the same door.
function page(req, res) {
  const me = res.locals.me;
  const days = tokens.lastSevenDays(me.id);

  const chart = '<script src="/plugins/chartjs/chart.umd.min.js"></script>\n' +
    '<script>\n' +
    "const ctx = document.getElementById('tokenChart').getContext('2d');\n" +
    'new Chart(ctx, {\n' +
    "    type: 'bar',\n" +
    '    data: {\n' +
    '        labels: ' + JSON.stringify(days.map(d => d.label)) + ',\n' +
    '        datasets: [{\n' +
    "            label: 'Tokens',\n" +
    '            data: ' + JSON.stringify(days.map(d => d.n)) + ',\n' +
    "            backgroundColor: 'rgba(109,40,217,0.75)',\n" +
    '            borderRadius: 8,\n' +
    '            borderSkipped: false,\n' +
    '        }]\n' +
    '    },\n' +
    '    options: {\n' +
    '        responsive: true,\n' +
    '        plugins: {\n' +
    '            legend: { display: false },\n' +
    '            tooltip: {\n' +
    "                callbacks: {\n" +
    "                    label: ctx => ' ' + ctx.parsed.y + ' tokens'\n" +
    '                }\n' +
    '            }\n' +
    '        },\n' +
    '        scales: {\n' +
    '            y: {\n' +
    '                beginAtZero: true,\n' +
    "                ticks: { precision: 0, font: { weight: '700' } },\n" +
    "                grid: { color: 'rgba(0,0,0,0.05)' }\n" +
    '            },\n' +
    '            x: {\n' +
    "                ticks: { font: { weight: '700' } },\n" +
    '                grid: { display: false }\n' +
    '            }\n' +
    '        }\n' +
    '    }\n' +
    '});\n' +
    '\n' +
    '// Auto-refresh har 60 seconds mein\n' +
    'setTimeout(() => location.reload(), 60000);\n' +
    '</script>';

  res.render('controller/token_stats', {
    summary: tokens.summary(me.id),
    todayLabel: dateLabel(store.scalar(`SELECT date('now','localtime')`)),
    hourLabel: hourLabel(),
    topUsers: tokens.topUsersToday(me.id),
    recentRows: tokens.recent(me.id, 50),
    pageStyle: TOKEN_STATS,
    scripts: chart
  });
}

// ----------------------------------------------------------- /api/token
// The client software posts one token per use. Kept open like the reference
// endpoint, but a MAC that is not registered to any key is rejected.
function apiToken(req, res) {
  const body = req.body || {};
  const mac = String(body.mac || '').trim();
  const key = mac
    ? store.get(`SELECT id, key_name, status FROM keys WHERE mac = ? ORDER BY id DESC LIMIT 1`, [mac])
    : null;

  if (!key) return res.status(403).json({ ok: false, msg: 'MAC not registered.' });

  const sensors = Number(body.sensors) || 0;
  tokens.record({
    userId: store.scalar('SELECT created_by_id FROM keys WHERE id = ?', [key.id]),
    label: key.key_name,
    sensors,
    status: key.status === 'active' ? 'valid' : 'invalid'
  });

  res.json({ ok: true, sensors });
}

module.exports = { page, apiToken };
