// Shared report navigation. Injected into every report so nobody needs to know
// a URL. One file: add a report here and it appears on all of them.
(function () {
  var REPORTS = [
    ['/sales-dashboard.html', 'Sales',           'Team board'],
    ['/mike-dashboard.html',  'Executive',       'Sales performance'],
    ['/ae-dashboard.html',    'AE Board',        'Closing and hygiene'],
    ['/arr-attainment.html',  'ARR Attainment',  'Against quota'],
    ['/arr-pipeline.html',    'Pipeline',        'Open and won'],
    ['/arr-touched.html',     'Last Week',       'ARR touched'],
    ['/leads-by-ae.html',     'Leads',           'Set per week'],
    ['/rfp.html',             'RFP Bids',        'From RFPSchoolWatch'],
    ['/ipeds.html',           'IPEDS',           'Institution data'],
    ['/leadership.html',      'Leadership',      'Presidential changes'],
    ['/plans.html',           'Strategic Plans', 'Researched with Claude'],
  ];

  // / redirects to the sales dashboard, so treat them as the same tab
  var here = location.pathname;
  if (here === '/' || here === '/index.html') here = '/sales-dashboard.html';

  var css = document.createElement('style');
  css.textContent = [
    '.ztnav{position:sticky;top:0;z-index:9000;background:rgba(251,252,254,.94);',
    'backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid #DCE7F1;',
    'margin:-40px -22px 28px;padding:0 22px}',
    '.ztnav-in{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:4px;',
    'overflow-x:auto;scrollbar-width:none}',
    '.ztnav-in::-webkit-scrollbar{display:none}',
    '.ztnav a{flex:none;text-decoration:none;padding:12px 14px 11px;border-bottom:3px solid transparent;',
    "font-family:'Sora',system-ui,sans-serif;font-size:13px;font-weight:600;color:#4A6076;",
    'white-space:nowrap;border-radius:8px 8px 0 0}',
    '.ztnav a:hover{background:#EDF3F9;color:#123B63}',
    '.ztnav a.on{color:#123B63;border-bottom-color:#F2872E;background:#E8F2FA}',
    '.ztnav .brand{flex:none;display:flex;align-items:center;gap:8px;padding-right:14px;',
    "font-family:'Sora',system-ui,sans-serif;font-size:13px;font-weight:700;color:#123B63}",
    '.ztnav .dot{width:7px;height:7px;border-radius:50%;background:#F2872E}',
    '.ztnav .stamp{margin-left:auto;flex:none;font-size:11px;color:#8AA0B4;padding-left:16px;white-space:nowrap}',
    '@media(max-width:760px){.ztnav .brand,.ztnav .stamp{display:none}}',
    '@media print{.ztnav{display:none}}',
  ].join('');
  document.head.appendChild(css);

  var bar = document.createElement('nav');
  bar.className = 'ztnav';
  bar.innerHTML = '<div class="ztnav-in"><span class="brand"><span class="dot"></span>ZogoTech</span>'
    + REPORTS.map(function (r) {
        var on = here === r[0] ? ' class="on"' : '';
        return '<a href="' + r[0] + '"' + on + ' title="' + r[2] + '">' + r[1] + '</a>';
      }).join('')
    + '<span class="stamp" id="ztstamp"></span></div>';

  function mount() {
    document.body.insertBefore(bar, document.body.firstChild);
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
      var el = document.getElementById('ztstamp');
      if (!el) return;
      el.textContent = s.pulledAt
        ? 'Data pulled ' + new Date(s.pulledAt).toLocaleDateString()
        : 'No refresh yet';
    }).catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
