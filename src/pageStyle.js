'use strict';
// Verbatim page-specific style blocks from the reference build. Only two pages
// carry one: the keys table colours its DataTables export buttons, and the token
// monitor styles its stat cards. Everything else lives in theme-pro.css.
const DT_BUTTONS = String.raw`
/* DT Buttons Styling */
.dt-buttons .btn {
  border-radius: 6px !important;
  font-weight: 800 !important;
  font-size: 13px !important;
  padding: 6px 14px !important;
  margin-right: 5px !important;
  transition: all 0.2s ease !important;
}
.dt-buttons .buttons-copy { background: linear-gradient(135deg, #ef4444, #dc2626) !important; border: 0 !important; color: #fff !important; }
.dt-buttons .buttons-csv { background: linear-gradient(135deg, #10b981, #059669) !important; border: 0 !important; color: #fff !important; }
.dt-buttons .buttons-excel { background: linear-gradient(135deg, #10b981, #059669) !important; border: 0 !important; color: #fff !important; }
.dt-buttons .buttons-pdf { background: linear-gradient(135deg, #f59e0b, #d97706) !important; border: 0 !important; color: #fff !important; }
.dt-buttons .buttons-print { background: linear-gradient(135deg, #3b82f6, #2563eb) !important; border: 0 !important; color: #fff !important; }
.dt-buttons .buttons-copy:hover, .dt-buttons .buttons-csv:hover, .dt-buttons .buttons-excel:hover, .dt-buttons .buttons-pdf:hover, .dt-buttons .buttons-print:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35) !important;
  opacity: 0.9 !important;
}
`;

const TOKEN_STATS = String.raw`
.stat-card {
    border-radius: 16px;
    padding: 24px 20px;
    color: #fff;
    position: relative;
    overflow: hidden;
    box-shadow: 0 8px 25px rgba(0,0,0,0.2);
    transition: transform 0.2s;
}
.stat-card:hover { transform: translateY(-3px); }
.stat-card .stat-num {
    font-size: 46px;
    font-weight: 900;
    line-height: 1;
    letter-spacing: -1px;
}
.stat-card .stat-label {
    font-size: 13px;
    font-weight: 700;
    opacity: 0.85;
    margin-top: 6px;
    text-transform: uppercase;
    letter-spacing: 1px;
}
.stat-card .stat-icon {
    position: absolute;
    right: 20px;
    top: 20px;
    font-size: 48px;
    opacity: 0.18;
}
.card-today   { background: linear-gradient(135deg, #2e7d32, #4caf50); }
.card-hour    { background: linear-gradient(135deg, #00c6ff, #0072ff); }
.card-total   { background: linear-gradient(135deg, #11998e, #38ef7d); }
.token-table  { font-size: 13px; }
.token-table td, .token-table th { vertical-align: middle !important; }
.badge-user   { background: linear-gradient(135deg,#2e7d32,#4caf50); color:#fff; padding:4px 10px; border-radius:20px; font-weight:700; font-size:12px; }
.sensor-pill  { background: rgba(255,255,255,0.08) !important; color: var(--ink) !important; border: 1px solid var(--line) !important; padding:3px 8px; border-radius:8px; font-size:11px; font-weight:700; margin:2px; display:inline-block; }
`;

module.exports = { DT_BUTTONS, TOKEN_STATS };
