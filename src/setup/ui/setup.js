/* eslint-env browser */
// Einrichtungsseite des Gateways (docs/setup-page.md). Holt den Zustand von
// /api/state und zeichnet ihn; alles vom Gateway geht als Text in die Seite,
// nie als HTML. Sprache nach Browser, umschaltbar.
(function () {
  'use strict';

  var TEXT = {
    de: {
      title: 'GateControl Home Gateway',
      pill_setup: 'Nicht verbunden', pill_connecting: 'Verbindet', pill_connected: 'Verbunden', pill_invalid: 'Zugang ungültig',
      connect_title: 'Mit GateControl verbinden',
      connect_text: 'Öffne GateControl, wähle Gateways › Gateway hinzufügen und gib die dort angezeigte Serveradresse und den Einrichtungscode hier ein.',
      server_label: 'Serveradresse', server_hint: 'Die Adresse, unter der du GateControl öffnest.', server_ph: 'gate.example.de',
      code_label: 'Einrichtungscode', code_hint: 'Der Code gilt 10 Minuten und nur einmal.',
      connect: 'Verbinden', connecting_btn: 'Verbindet …', recheck: 'Erneut prüfen',
      ready_title: 'Dieses Gerät ist bereit', before_title: 'Vor dem Verbinden',
      auto_recheck: 'Die Seite prüft alle 10 Sekunden von selbst.',
      c_internet_ok: 'Internet erreichbar', c_internet_bad: 'Kein Internet',
      c_internet_help: 'Das Gerät erreicht das Internet nicht. Prüfe Netzwerkkabel, WLAN und Router.',
      c_clock_ok: 'Uhrzeit stimmt', c_clock_bad: 'Uhrzeit falsch', c_clock_unknown: 'Uhrzeit noch nicht geprüft',
      c_clock_help: 'Die Uhr des Geräts geht falsch. Stelle Datum und Uhrzeit ein oder schalte den Abgleich mit einem Zeitserver ein.',
      c_clock_help_syno: 'Die Uhr der Synology geht falsch. Systemsteuerung › Regionale Optionen › Zeit: mit einem Zeitserver synchronisieren.',
      c_tun_ok: 'VPN-Gerät vorhanden', c_tun_bad: 'VPN-Gerät fehlt',
      c_tun_help_syno: 'Die Synology stellt /dev/net/tun erst nach einem Befehl bereit.',
      c_tun_help: 'Das Gateway braucht das Gerät /dev/net/tun des Rechners.',
      c_config_ok: 'Ordner config beschreibbar', c_config_bad: 'Ordner config nicht beschreibbar',
      c_config_help: 'Das Gateway kann die Zugangsdaten nicht speichern.',
      fix_dsm: 'So behebst du das in DSM',
      fix_dsm_1: 'Systemsteuerung › Aufgabenplaner › Erstellen › Ausgelöste Aufgabe › Benutzerdefiniertes Skript',
      fix_dsm_2: 'Benutzer {root}, Ereignis {boot}', fix_dsm_boot: 'Hochfahren',
      fix_dsm_3: 'Befehl: {cmd}',
      fix_dsm_4: 'Aufgabe markieren und „Ausführen“ wählen',
      fix_tun: 'So behebst du das',
      fix_tun_1: 'Auf dem Rechner das Modul laden: {cmd}',
      fix_tun_2: 'In der Compose-Datei beim Dienst gateway unter {devices} eintragen: {line}',
      fix_tun_3: 'Container neu erstellen: {cmd}',
      fix_config: 'So behebst du das',
      fix_config_1: 'In der Compose-Datei beim Dienst gateway aus {old} die Zeile {neu} machen (ohne {ro})',
      fix_config_2: 'Projekt bzw. Container neu erstellen',
      fix_config_alt: 'Oder wie bisher: in GateControl die Datei gateway.env herunterladen und in den Ordner config legen.',
      conn_title: 'Verbindung zu {server}', conn_title_plain: 'Verbindung wird aufgebaut',
      s_code: 'Code angenommen', s_code_sub: 'Gateway „{name}“',
      s_saved: 'Zugangsdaten gespeichert', s_saved_sub: 'im Ordner config, nur für das Gateway lesbar', s_found: 'Zugangsdaten vorhanden',
      s_tunnel_wait: 'VPN-Tunnel wird aufgebaut …', s_tunnel_done: 'VPN-Tunnel steht',
      s_online: 'GateControl meldet das Gateway als online', s_online_wait: 'Warten auf die Bestätigung von GateControl …',
      conn_foot: 'Du kannst die Seite offen lassen oder in GateControl weiterschauen.',
      start_failed: 'Das Gateway konnte nicht starten.', start_failed_sub: 'Es versucht es gleich noch einmal. Einzelheiten stehen im Protokoll des Containers.',
      ok_title: 'Verbunden mit {server}', ok_title_plain: 'Verbunden',
      last_contact: 'Letzter Kontakt {ago}', last_contact_none: 'Noch kein Kontakt',
      k_name: 'Name', k_tunnel: 'VPN-Tunnel', k_version: 'Version', k_lan: 'Adresse im Heimnetz',
      tunnel_since: 'steht seit {dur}', tunnel_up: 'steht', tunnel_down: 'wird aufgebaut …',
      open_gc: 'In GateControl öffnen',
      ok_note: 'Funktionen und Einstellungen verwaltest du in GateControl. Erneuerst du dort den Zugang, fragt diese Seite von selbst nach einem neuen Code.',
      inv_title: 'Neuen Code eingeben',
      inv_text: '{server} nimmt den Zugang dieses Gateways nicht mehr an. Wähle in GateControl beim Gateway „Zugang erneuern“ und gib den neuen Einrichtungscode hier ein.',
      inv_foot: 'Routen und Einstellungen bleiben erhalten.',
      inv_readonly: 'Der Ordner config ist nur lesbar.',
      inv_readonly_sub: 'Dieses Gateway wurde mit einer Datei eingerichtet. Lade in GateControl eine neue gateway.env herunter und lege sie in den Ordner config – oder entferne in der Compose-Datei das :ro hinter ./config:/config.',
      e_code_rejected: 'Dieser Code ist abgelaufen oder wurde schon benutzt.', e_code_rejected_sub: 'Erzeuge in GateControl einen neuen Code und gib ihn hier ein.',
      e_server_unreachable: '{server} antwortet nicht.', e_server_unreachable_sub: 'Prüfe die Serveradresse und ob GateControl aus dem Internet erreichbar ist.',
      e_server_tls: 'Die Verbindung zu {server} ist nicht sicher.', e_server_tls_sub: 'Das Zertifikat des Servers wurde nicht angenommen. Prüfe die Serveradresse.',
      e_server_not_gatecontrol: 'Unter {server} antwortet kein GateControl.', e_server_not_gatecontrol_sub: 'Prüfe die Serveradresse. Es ist die Adresse, unter der du GateControl im Browser öffnest.',
      e_server_busy: '{server} nimmt gerade keine Codes an.', e_server_busy_sub: 'Dort gab es zu viele Versuche. Warte ein paar Minuten.',
      e_server_error: '{server} konnte den Code nicht einlösen.', e_server_error_sub: 'Versuche es noch einmal. Bleibt es dabei, hilft das Protokoll von GateControl.',
      e_rate_limited: 'Zu viele Versuche.', e_rate_limited_sub: 'Warte {dur}.',
      e_bad_code: 'Das sieht nicht nach einem Einrichtungscode aus.', e_bad_code_sub: 'Er hat die Form XXXX-XXXX-XXXX-XXXX.',
      e_bad_server: 'Das ist keine gültige Serveradresse.', e_bad_server_sub: 'Zum Beispiel gate.example.de – ohne Leerzeichen.',
      e_write_failed: 'Die Zugangsdaten ließen sich nicht speichern.', e_write_failed_sub: 'Prüfe, ob der Ordner config beschreibbar ist. Der Code ist verbraucht – erzeuge danach einen neuen.',
      e_config_readonly: 'Der Ordner config ist nicht beschreibbar.', e_config_readonly_sub: 'Der Code wurde nicht verwendet. Behebe das zuerst.',
      e_not_ready: 'Das Gerät ist noch nicht bereit.', e_not_ready_sub: 'Behebe zuerst die Punkte unter „Vor dem Verbinden“. Der Code wurde nicht verwendet.',
      e_generic: 'Das hat nicht geklappt.', e_generic_sub: 'Lade die Seite neu und versuche es noch einmal.',
      offline: 'Das Gateway antwortet gerade nicht. Die Seite versucht es weiter.',
      ago_now: 'gerade eben', ago: 'vor {dur}',
      sec_1: '1 Sekunde', sec_n: '{n} Sekunden', min_1: '1 Minute', min_n: '{n} Minuten', h_1: '1 Stunde', h_n: '{n} Stunden', d_1: '1 Tag', d_n: '{n} Tagen',
      lang_label: 'Sprache'
    },
    en: {
      title: 'GateControl Home Gateway',
      pill_setup: 'Not connected', pill_connecting: 'Connecting', pill_connected: 'Connected', pill_invalid: 'Access invalid',
      connect_title: 'Connect to GateControl',
      connect_text: 'Open GateControl, choose Gateways › Add gateway and enter the server address and the setup code shown there.',
      server_label: 'Server address', server_hint: 'The address you open GateControl with.', server_ph: 'gate.example.com',
      code_label: 'Setup code', code_hint: 'The code is valid for 10 minutes and only once.',
      connect: 'Connect', connecting_btn: 'Connecting …', recheck: 'Check again',
      ready_title: 'This device is ready', before_title: 'Before connecting',
      auto_recheck: 'The page checks again every 10 seconds.',
      c_internet_ok: 'Internet reachable', c_internet_bad: 'No internet',
      c_internet_help: 'The device cannot reach the internet. Check the network cable, Wi-Fi and router.',
      c_clock_ok: 'Clock is right', c_clock_bad: 'Clock is wrong', c_clock_unknown: 'Clock not checked yet',
      c_clock_help: 'The clock of the device is wrong. Set date and time or switch on time synchronisation.',
      c_clock_help_syno: 'The clock of the Synology is wrong. Control Panel › Regional Options › Time: synchronise with a time server.',
      c_tun_ok: 'VPN device present', c_tun_bad: 'VPN device missing',
      c_tun_help_syno: 'The Synology only provides /dev/net/tun after a command.',
      c_tun_help: 'The gateway needs the device /dev/net/tun of the host.',
      c_config_ok: 'Folder config writable', c_config_bad: 'Folder config not writable',
      c_config_help: 'The gateway cannot store the access data.',
      fix_dsm: 'How to fix this in DSM',
      fix_dsm_1: 'Control Panel › Task Scheduler › Create › Triggered Task › User-defined script',
      fix_dsm_2: 'User {root}, event {boot}', fix_dsm_boot: 'Boot-up',
      fix_dsm_3: 'Command: {cmd}',
      fix_dsm_4: 'Select the task and choose “Run”',
      fix_tun: 'How to fix this',
      fix_tun_1: 'Load the module on the host: {cmd}',
      fix_tun_2: 'In the compose file, add to the service gateway under {devices}: {line}',
      fix_tun_3: 'Recreate the container: {cmd}',
      fix_config: 'How to fix this',
      fix_config_1: 'In the compose file, turn {old} of the service gateway into {neu} (without {ro})',
      fix_config_2: 'Recreate the project or container',
      fix_config_alt: 'Or as before: download the file gateway.env in GateControl and put it into the folder config.',
      conn_title: 'Connecting to {server}', conn_title_plain: 'Connecting',
      s_code: 'Code accepted', s_code_sub: 'Gateway “{name}”',
      s_saved: 'Access data stored', s_saved_sub: 'in the folder config, readable by the gateway only', s_found: 'Access data present',
      s_tunnel_wait: 'Setting up the VPN tunnel …', s_tunnel_done: 'VPN tunnel is up',
      s_online: 'GateControl reports the gateway as online', s_online_wait: 'Waiting for GateControl to confirm …',
      conn_foot: 'You can leave this page open or carry on in GateControl.',
      start_failed: 'The gateway could not start.', start_failed_sub: 'It will try again in a moment. Details are in the log of the container.',
      ok_title: 'Connected to {server}', ok_title_plain: 'Connected',
      last_contact: 'Last contact {ago}', last_contact_none: 'No contact yet',
      k_name: 'Name', k_tunnel: 'VPN tunnel', k_version: 'Version', k_lan: 'Address in the home network',
      tunnel_since: 'up for {dur}', tunnel_up: 'up', tunnel_down: 'being set up …',
      open_gc: 'Open in GateControl',
      ok_note: 'Features and settings are managed in GateControl. If you renew the access there, this page asks for a new code by itself.',
      inv_title: 'Enter a new code',
      inv_text: '{server} no longer accepts the access of this gateway. In GateControl choose “Renew access” for the gateway and enter the new setup code here.',
      inv_foot: 'Routes and settings are kept.',
      inv_readonly: 'The folder config is read-only.',
      inv_readonly_sub: 'This gateway was set up with a file. Download a new gateway.env in GateControl and put it into the folder config – or remove the :ro after ./config:/config in the compose file.',
      e_code_rejected: 'This code has expired or was already used.', e_code_rejected_sub: 'Create a new code in GateControl and enter it here.',
      e_server_unreachable: '{server} does not answer.', e_server_unreachable_sub: 'Check the server address and whether GateControl is reachable from the internet.',
      e_server_tls: 'The connection to {server} is not secure.', e_server_tls_sub: 'The certificate of the server was not accepted. Check the server address.',
      e_server_not_gatecontrol: 'There is no GateControl at {server}.', e_server_not_gatecontrol_sub: 'Check the server address. It is the address you open GateControl with in the browser.',
      e_server_busy: '{server} is not taking codes right now.', e_server_busy_sub: 'There were too many attempts. Wait a few minutes.',
      e_server_error: '{server} could not redeem the code.', e_server_error_sub: 'Try again. If it stays like this, the log of GateControl helps.',
      e_rate_limited: 'Too many attempts.', e_rate_limited_sub: 'Wait {dur}.',
      e_bad_code: 'This does not look like a setup code.', e_bad_code_sub: 'It has the form XXXX-XXXX-XXXX-XXXX.',
      e_bad_server: 'This is not a valid server address.', e_bad_server_sub: 'For example gate.example.com – without spaces.',
      e_write_failed: 'The access data could not be stored.', e_write_failed_sub: 'Check that the folder config is writable. The code is used up – create a new one afterwards.',
      e_config_readonly: 'The folder config is not writable.', e_config_readonly_sub: 'The code was not used. Fix this first.',
      e_not_ready: 'The device is not ready yet.', e_not_ready_sub: 'Fix the items under “Before connecting” first. The code was not used.',
      e_generic: 'That did not work.', e_generic_sub: 'Reload the page and try again.',
      offline: 'The gateway does not answer right now. The page keeps trying.',
      ago_now: 'just now', ago: '{dur} ago',
      sec_1: '1 second', sec_n: '{n} seconds', min_1: '1 minute', min_n: '{n} minutes', h_1: '1 hour', h_n: '{n} hours', d_1: '1 day', d_n: '{n} days',
      lang_label: 'Language'
    }
  };

  var app = document.getElementById('app');
  var lang = 'de';
  try { lang = localStorage.getItem('gc-setup-lang') || ''; } catch (e) { lang = ''; }
  if (lang !== 'de' && lang !== 'en') lang = /^de\b/i.test(navigator.language || '') ? 'de' : 'en';

  var state = null;      // letzte Antwort von /api/state
  var offline = false;
  var form = { server: '', code: '' };
  var error = null;      // { code, server, retryAfterS }
  var sending = false;
  var timer = null;

  function t(key, params) {
    var s = (TEXT[lang] && TEXT[lang][key]) || TEXT.de[key] || key;
    if (params) Object.keys(params).forEach(function (p) { s = s.split('{' + p + '}').join(String(params[p])); });
    return s;
  }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function icon(id) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }
  /** Text mit {platzhaltern}, die als <code> eingesetzt werden. */
  function rich(key, codes) {
    var out = [];
    t(key).split(/(\{[a-z]+\})/).forEach(function (part) {
      var m = /^\{([a-z]+)\}$/.exec(part);
      if (m && codes[m[1]] !== undefined) out.push(h('code', { text: codes[m[1]] }));
      else if (part) out.push(part);
    });
    return out;
  }
  function dur(sec) {
    var n;
    if (sec < 60) { n = Math.max(1, Math.round(sec)); return t(n === 1 ? 'sec_1' : 'sec_n', { n: n }); }
    if (sec < 3600) { n = Math.round(sec / 60); return t(n === 1 ? 'min_1' : 'min_n', { n: n }); }
    if (sec < 172800) { n = Math.round(sec / 3600); return t(n === 1 ? 'h_1' : 'h_n', { n: n }); }
    n = Math.round(sec / 86400); return t(n === 1 ? 'd_1' : 'd_n', { n: n });
  }
  function ago(sec) { return sec < 5 ? t('ago_now') : t('ago', { dur: dur(sec) }); }

  // ── Eingaben ──
  function formatCode(v) {
    var hex = v.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 16);
    return (hex.match(/.{1,4}/g) || []).join('-');
  }
  function cleanServer(v) {
    return v.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  }
  function onCodeInput(e) {
    var v = e.target.value;
    var at = v.indexOf('@');
    // alte Form CODE@adresse: auf beide Felder verteilen
    if (at >= 0) {
      var host = cleanServer(v.slice(at + 1));
      if (host && !(state && state.mode === 'invalid')) {
        form.server = host;
        var sv = document.getElementById('f-server');
        if (sv) sv.value = host;
      }
      v = v.slice(0, at);
    }
    form.code = formatCode(v);
    if (e.target.value !== form.code) e.target.value = form.code;
    clearError();
  }
  function onServerInput(e) { form.server = e.target.value; clearError(); }
  function onServerBlur(e) { form.server = cleanServer(e.target.value); e.target.value = form.server; }
  function clearError() {
    if (!error) return;
    error = null;
    var n = document.getElementById('err');
    if (n) n.parentNode.removeChild(n);
    ['f-server', 'f-code'].forEach(function (id) { var i = document.getElementById(id); if (i) { i.classList.remove('bad'); i.removeAttribute('aria-invalid'); } });
  }

  function submit(e) {
    if (e) e.preventDefault();
    if (sending || !state) return;
    var inv = state.mode === 'invalid';
    form.server = cleanServer(form.server);
    if (!/^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/.test(form.code)) { error = { code: 'bad_code' }; render(); focus('f-code'); return; }
    if (!inv && !/^[^\s@]+\.[^\s@]+$/.test(form.server) && !/^\[.+\]/.test(form.server)) { error = { code: 'bad_server' }; render(); focus('f-server'); return; }
    sending = true; error = null; render();
    fetch('api/pair', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-GC-Setup': state.csrf || '' },
      body: JSON.stringify({ server: form.server, code: form.code })
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'generic' }; });
    }).then(function (j) {
      sending = false;
      if (j && j.ok) { form.code = ''; error = null; return poll(); }
      error = { code: (j && j.error) || 'generic', server: (j && j.server) || form.server || (state && state.server) || '', retryAfterS: j && j.retryAfterS };
      render();
      focus(/^(bad_server|server_)/.test(error.code) && !inv ? 'f-server' : 'f-code');
    }).catch(function () {
      sending = false; error = { code: 'generic' }; render();
    });
  }
  function focus(id) { var n = document.getElementById(id); if (n) n.focus(); }

  // ── Bausteine ──
  function top(sub, pillClass, pillText) {
    return h('div', { class: 'gw-top' }, [
      h('span', { class: 'logo' }, [icon('i-gate')]),
      h('div', { class: 'gw-id' }, [h('h1', { text: t('title') }), h('small', { text: sub || '' })]),
      h('span', { class: 'pill' + (pillClass ? ' ' + pillClass : ''), text: pillText })
    ]);
  }
  function check(cls, title, sub, strong) {
    var ic = h('span', { class: 'ic' }, cls === 'ok' ? [icon('i-check')] : cls === 'bad' ? [icon('i-x')] : []);
    var label = h('span', {}, [strong ? h('b', { text: title }) : title, sub ? h('small', { text: sub }) : null]);
    return h('li', { class: cls === 'ok' ? '' : cls }, [ic, label]);
  }
  function errorNote() {
    if (!error) return null;
    var known = TEXT.de['e_' + error.code] ? error.code : 'generic';
    var p = { server: error.server || '', dur: dur(error.retryAfterS || 300) };
    return h('div', { class: 'note crit', id: 'err', role: 'alert' }, [h('b', { text: t('e_' + known, p) }), h('span', { text: t('e_' + known + '_sub', p) })]);
  }
  function fields(inv) {
    var serverBad = error && /^(bad_server|server_)/.test(error.code) && !inv;
    var codeBad = error && /^(bad_code|code_rejected)$/.test(error.code);
    var server = h('input', { id: 'f-server', name: 'server', type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
      maxlength: 300, placeholder: t('server_ph'), readonly: inv, class: serverBad ? 'bad' : null, 'aria-invalid': serverBad ? 'true' : null, 'aria-describedby': 'f-server-hint' });
    server.value = inv ? (state.server || '') : form.server;
    if (!inv) { server.addEventListener('input', onServerInput); server.addEventListener('blur', onServerBlur); }
    var code = h('input', { id: 'f-code', name: 'code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false',
      maxlength: 400, placeholder: 'XXXX-XXXX-XXXX-XXXX', class: codeBad ? 'bad' : null, 'aria-invalid': codeBad ? 'true' : null, 'aria-describedby': 'f-code-hint' });
    code.value = form.code;
    code.addEventListener('input', onCodeInput);
    return [
      h('div', { class: 'field' }, [h('label', { for: 'f-server', text: t('server_label') }), server, h('span', { class: 'hint', id: 'f-server-hint', text: inv ? '' : t('server_hint') })]),
      h('div', { class: 'field' }, [h('label', { for: 'f-code', text: t('code_label') }), code, h('span', { class: 'hint', id: 'f-code-hint', text: t('code_hint') })])
    ];
  }
  function connectButton(disabled) {
    return h('button', { class: 'btn', type: 'submit', id: 'btn-connect', disabled: disabled || sending }, [sending ? t('connecting_btn') : t('connect')]);
  }
  function checkList(c) {
    var syno = state.platform === 'synology';
    return h('ul', { class: 'checks' }, [
      c.internet ? check('ok', t('c_internet_ok')) : check('bad', t('c_internet_bad'), t('c_internet_help'), true),
      c.clock === false ? check('bad', t('c_clock_bad'), t(syno ? 'c_clock_help_syno' : 'c_clock_help'), true)
        : c.clock === true ? check('ok', t('c_clock_ok')) : check('unknown', t('c_clock_unknown')),
      c.tun ? check('ok', t('c_tun_ok')) : check('bad', t('c_tun_bad'), t(syno ? 'c_tun_help_syno' : 'c_tun_help'), true),
      c.config ? check('ok', t('c_config_ok')) : check('bad', t('c_config_bad'), t('c_config_help'), true)
    ]);
  }
  function helpNotes(c) {
    var out = [];
    if (!c.tun) {
      if (state.platform === 'synology') {
        out.push(h('div', { class: 'note help' }, [h('b', { text: t('fix_dsm') }), h('ol', {}, [
          h('li', { text: t('fix_dsm_1') }),
          h('li', {}, rich('fix_dsm_2', { root: 'root', boot: t('fix_dsm_boot') })),
          h('li', {}, rich('fix_dsm_3', { cmd: 'insmod /lib/modules/tun.ko' })),
          h('li', { text: t('fix_dsm_4') })
        ])]));
      } else {
        out.push(h('div', { class: 'note help' }, [h('b', { text: t('fix_tun') }), h('ol', {}, [
          h('li', {}, rich('fix_tun_1', { cmd: 'sudo modprobe tun' })),
          h('li', {}, rich('fix_tun_2', { devices: 'devices:', line: '- /dev/net/tun:/dev/net/tun' })),
          h('li', {}, rich('fix_tun_3', { cmd: 'docker compose up -d' }))
        ])]));
      }
    }
    if (!c.config) {
      out.push(h('div', { class: 'note help' }, [h('b', { text: t('fix_config') }), h('ol', {}, [
        h('li', {}, rich('fix_config_1', { old: './config:/config:ro', neu: './config:/config', ro: ':ro' })),
        h('li', { text: t('fix_config_2') })
      ]), h('span', { text: t('fix_config_alt') })]));
    }
    return out;
  }
  function foot(items) {
    var kids = items.map(function (x) { return h('span', { text: x }); });
    if (offline) kids.unshift(h('span', { class: 'offline', role: 'status', text: t('offline') }));
    var langs = h('span', { class: 'lang', role: 'group', 'aria-label': t('lang_label') }, [['de', 'Deutsch'], ['en', 'English']].map(function (l) {
      var b = h('button', { type: 'button', 'aria-pressed': String(lang === l[0]), lang: l[0], text: l[1] });
      b.addEventListener('click', function () { lang = l[0]; try { localStorage.setItem('gc-setup-lang', lang); } catch (e) { /* privat */ } render(); });
      return b;
    }));
    kids.push(langs);
    return h('div', { class: 'foot' }, kids);
  }
  function baseFoot() {
    var s = state || {};
    return [s.version ? 'Gateway ' + s.version : null, s.lanIp || null].filter(Boolean);
  }

  // ── Zustände ──
  function viewSetup() {
    var c = state.checks || {};
    if (state.ready) {
      var formEl = h('form', { class: 'card', novalidate: true }, [
        h('h2', { text: t('connect_title') }), h('p', { text: t('connect_text') })
      ].concat(fields(false), [errorNote(), h('div', { class: 'row' }, [connectButton(false)])]));
      formEl.addEventListener('submit', submit);
      return [top(state.device, '', t('pill_setup')), formEl, h('h2', { class: 'sub', text: t('ready_title') }), checkList(c), foot(baseFoot())];
    }
    var again = h('button', { class: 'btn ghost', type: 'button', id: 'btn-recheck', text: t('recheck') });
    again.addEventListener('click', function () { poll(true); });
    return [top(state.device, '', t('pill_setup')), h('h2', { class: 'sub', text: t('before_title') }), checkList(c)]
      .concat(helpNotes(c), [errorNote(), h('div', { class: 'row' }, [again, connectButton(true)]), foot([t('auto_recheck')].concat(baseFoot()))]);
  }
  function viewInvalid() {
    var c = state.checks || {};
    var card;
    if (c.config === false) {
      card = h('div', { class: 'card' }, [h('h2', { text: t('inv_title') }), h('p', { text: t('inv_text', { server: state.server || 'GateControl' }) }),
        h('div', { class: 'note crit' }, [h('b', { text: t('inv_readonly') }), h('span', { text: t('inv_readonly_sub') })])]);
    } else {
      card = h('form', { class: 'card', novalidate: true }, [
        h('h2', { text: t('inv_title') }), h('p', { text: t('inv_text', { server: state.server || 'GateControl' }) })
      ].concat(fields(true), [errorNote(), h('div', { class: 'row' }, [connectButton(false)])]));
      card.addEventListener('submit', submit);
    }
    return [top(state.name || state.device, 'busy', t('pill_invalid')), card, foot([t('inv_foot')].concat(baseFoot()))];
  }
  function viewConnecting() {
    var st = state.steps || {};
    var items = [];
    if (st.code === 'done') items.push(check('ok', t('s_code'), state.name ? t('s_code_sub', { name: state.name }) : ''));
    items.push(st.code === 'done' ? check('ok', t('s_saved'), t('s_saved_sub')) : check('ok', t('s_found')));
    var tunnelDone = st.tunnel === 'done';
    items.push(tunnelDone ? check('ok', t('s_tunnel_done')) : check('wait', t('s_tunnel_wait')));
    items.push(st.online === 'done' ? check('ok', t('s_online')) : tunnelDone ? check('wait', t('s_online_wait')) : check('todo', t('s_online')));
    var card = h('div', { class: 'card' }, [
      h('h2', { text: state.server ? t('conn_title', { server: state.server }) : t('conn_title_plain') }),
      h('ul', { class: 'checks' }, items),
      state.startFailed ? h('div', { class: 'note crit', role: 'alert' }, [h('b', { text: t('start_failed') }), h('span', { text: t('start_failed_sub') })]) : null
    ]);
    return [top(state.name || state.device, 'busy', t('pill_connecting')), card, foot([t('conn_foot')].concat(baseFoot()))];
  }
  function viewConnected() {
    var kv = h('dl', { class: 'kv' }, []);
    function row(k, v) { if (v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); } }
    row(t('k_name'), state.name);
    row(t('k_tunnel'), state.tunnelUp ? (state.tunnelSinceS !== null && state.tunnelSinceS !== undefined && state.tunnelSinceS >= 5 ? t('tunnel_since', { dur: dur(state.tunnelSinceS) }) : t('tunnel_up')) : t('tunnel_down'));
    row(t('k_version'), state.version);
    row(t('k_lan'), state.lanIp);
    var last = state.lastContactS === null || state.lastContactS === undefined ? t('last_contact_none') : t('last_contact', { ago: ago(state.lastContactS) });
    var card = h('div', { class: 'card' }, [
      h('div', { class: 'big' }, [h('span', { class: 'ring' }, [icon('i-check')]),
        h('div', {}, [h('b', { text: state.server ? t('ok_title', { server: state.server }) : t('ok_title_plain') }), h('span', { text: last })])]),
      kv,
      /^https?:\/\//.test(state.openUrl || '') ? h('div', { class: 'row' }, [h('a', { class: 'btn', href: state.openUrl, target: '_blank', rel: 'noopener noreferrer' }, [t('open_gc'), icon('i-ext')])]) : null
    ]);
    return [top(state.name || state.device, 'ok', t('pill_connected')), card, h('div', { class: 'note help' }, [h('span', { text: t('ok_note') })]), foot([])];
  }

  function render() {
    document.documentElement.lang = lang;
    document.title = t('title');
    if (!state) {
      if (offline) { app.textContent = ''; app.appendChild(top('', '', '…')); app.appendChild(foot([])); }
      return;
    }
    var active = document.activeElement;
    var keep = active && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    var view = state.mode === 'setup' ? viewSetup() : state.mode === 'invalid' ? viewInvalid() : state.mode === 'connecting' ? viewConnecting() : viewConnected();
    app.textContent = '';
    view.forEach(function (n) { if (n) app.appendChild(n); });
    if (keep) {
      var n = document.getElementById(keep.id);
      if (n) { n.focus(); try { if (keep.start !== null && n.setSelectionRange) n.setSelectionRange(keep.start, keep.end); } catch (e) { /* kein Textfeld */ } }
    }
  }

  // Nur neu zeichnen, wenn sich etwas Sichtbares geändert hat (Eingaben bleiben ungestört).
  var lastKey = '';
  function poll(recheck) {
    clearTimeout(timer);
    // im Hintergrund nicht weiterfragen (jede Abfrage kann die Prüfungen anstoßen)
    if (document.hidden && state && !recheck) { timer = setTimeout(poll, 10000); return Promise.resolve(); }
    return fetch('api/state' + (recheck ? '?recheck=1' : ''), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (j) {
        var wasMode = state && state.mode;
        state = j; offline = false;
        if (wasMode && wasMode !== j.mode) { error = null; }
        var key = JSON.stringify(j) + lang;
        if (key !== lastKey || recheck) { lastKey = key; render(); }
      })
      .catch(function () { if (!offline) { offline = true; lastKey = ''; render(); } })
      .then(function () {
        var ms = state && state.mode === 'connecting' ? 2000 : state && state.mode === 'connected' ? 5000 : 10000;
        timer = setTimeout(poll, offline ? 3000 : ms);
      });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  poll();
})();
