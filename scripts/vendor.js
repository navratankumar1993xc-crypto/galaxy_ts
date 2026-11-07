'use strict';
// Copies the exact vendor tree the reference build ships (AdminLTE 3 layout:
// /plugins/... and /dist/...) out of node_modules and into public/, so the
// panel runs offline and the asset paths match the reference byte for byte.
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'node_modules', 'admin-lte');
const DEST = path.resolve(__dirname, '..', 'public');

const FILES = [
  // Style
  'plugins/fontawesome-free/css/all.min.css',
  'plugins/datatables-bs4/css/dataTables.bootstrap4.min.css',
  'plugins/datatables-responsive/css/responsive.bootstrap4.min.css',
  'plugins/datatables-buttons/css/buttons.bootstrap4.min.css',
  'plugins/overlayScrollbars/css/OverlayScrollbars.min.css',
  'dist/css/adminlte.min.css',

  // Scripts
  'plugins/jquery/jquery.min.js',
  'plugins/bootstrap/js/bootstrap.bundle.min.js',
  'plugins/overlayScrollbars/js/OverlayScrollbars.min.js',
  'plugins/overlayScrollbars/js/jquery.overlayScrollbars.min.js',
  'plugins/datatables/jquery.dataTables.min.js',
  'plugins/datatables-bs4/js/dataTables.bootstrap4.min.js',
  'plugins/datatables-responsive/js/dataTables.responsive.min.js',
  'plugins/datatables-responsive/js/responsive.bootstrap4.min.js',
  'plugins/datatables-buttons/js/dataTables.buttons.min.js',
  'plugins/datatables-buttons/js/buttons.bootstrap4.min.js',
  'plugins/datatables-buttons/js/buttons.html5.min.js',
  'plugins/datatables-buttons/js/buttons.print.min.js',
  'plugins/datatables-buttons/js/buttons.colVis.min.js',
  'plugins/jszip/jszip.min.js',
  'plugins/pdfmake/pdfmake.min.js',
  'plugins/pdfmake/vfs_fonts.js',
  'dist/js/adminlte.min.js',
  'dist/js/demo.js',
  // /add_user only: the reference validates the create-panel form with it.
  'plugins/jquery-validation/jquery.validate.min.js'
];

// Whole directories: Font Awesome's webfonts sit next to its css, and the
// AdminLTE skin images next to its stylesheet.
const DIRS = [
  'plugins/fontawesome-free/webfonts',
  'dist/img'
];

function copyFile(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DEST, rel);
  if (!fs.existsSync(from)) {
    console.error('MISSING ' + rel);
    return false;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function copyDir(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DEST, rel);
  if (!fs.existsSync(from)) {
    console.error('MISSING ' + rel + '/');
    return 0;
  }
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) n += copyDir(path.join(rel, entry.name));
    else {
      fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      n++;
    }
  }
  return n;
}

let ok = 0;
for (const f of FILES) if (copyFile(f)) ok++;
let dirFiles = 0;
for (const d of DIRS) dirFiles += copyDir(d);

// Not part of AdminLTE: /token_stats uses Chart.js 4, which the reference
// pulls from jsDelivr. The UMD build is vendored once at
// public/plugins/chartjs/chart.umd.min.js so the page still works offline.

console.log('Vendored ' + ok + ' files + ' + dirFiles + ' from directories into public/');
