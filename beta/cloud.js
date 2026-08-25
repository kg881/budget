/* ============================================================================
   Общий доступ по почте — Firebase Auth (вход по ссылке) + Firestore.

   Модель данных в Firestore:
     households/{hid}                 — владелец, список участников, настройки,
                                        шаблон, bonusOverrides, bonusSync
     households/{hid}/months/{ym}     — один документ на месяц
     households/{hid}/lists/{name}    — {items:[…]} для goals | bonuses |
                                        accounts | sinkingFunds | bonusHistory
     invites/{email}                  — {hid} : по какой почте в какое хозяйство

   Почему так, а не одним документом: два человека правят разные месяцы
   одновременно и не затирают друг друга. Конфликт возможен только внутри
   одного и того же месяца (или одного и того же списка) — для двоих это
   редкий случай, там побеждает последняя запись.

   Локальные данные — источник правды до первого входа. Облако НИКОГДА не
   применяется поверх локальных данных молча: при первой встрече двух непустых
   копий приложение спрашивает, какую взять за основу, и перед применением
   облачной версии кладёт снимок локальной в localStorage.
   ========================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import {
  getAuth, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, getDoc, getDocs, deleteDoc, onSnapshot, updateDoc,
  arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';

const B = window.__budget;                       // мост в основное приложение
const K_CFG   = 'budget-cloud-config';
const K_HID   = 'budget-cloud-hid';
const K_MAIL  = 'budget-cloud-email-pending';
const K_CLIENT= 'budget-cloud-client';
const K_SNAP  = 'budget-cloud-snapshot-precloud'; // снимок ДО первого применения облака

const APP_URL = 'https://kg881.github.io/budget/beta/';
const LISTS = ['goals', 'bonuses', 'accounts', 'sinkingFunds', 'bonusHistory'];

/* ---------- клиентский идентификатор (чтобы не реагировать на свои же записи) */
function clientId() {
  let c = localStorage.getItem(K_CLIENT);
  if (!c) { c = 'c' + Math.random().toString(36).slice(2, 10); localStorage.setItem(K_CLIENT, c); }
  return c;
}
const ME = clientId();

/* ---------- состояние модуля --------------------------------------------- */
let app = null, auth = null, db = null;
let user = null, hid = null, household = null;
let unsubs = [];
let applying = false;          // применяем облачные данные → не пушить обратно
let ready = false;             // слушатели подключены, начальная сверка пройдена
let lastPushed = null;         // снимок того, что уже уехало в облако
let status = 'off';            // off | setup | signedout | linking | syncing | ok | err
let statusText = '';
let pushTimer = null;

/* нормализация почты: убираем пробелы, регистр и приставку mailto: —
   почтовые клиенты часто копируют адрес именно как mailto:адрес */
const norm = s => String(s || '').trim().toLowerCase().replace(/^mailto:/, '').trim();
const J = v => JSON.stringify(v === undefined ? null : v);

/* ---------- конфиг Firebase (публичный, безопасно хранить в браузере) ----- */
/* Конфиг проекта вшит в код: apiKey у Firebase — не секрет, это идентификатор
   проекта. Доступ к данным закрывают правила Firestore на сервере. Благодаря
   этому ни владельцу, ни приглашённым не нужно ничего настраивать. */
const DEFAULT_CFG = {
  "apiKey": "AIzaSyBwJN79SJagmQEcnS6oAyKUuzxbAvp04ho",
  "authDomain": "budget-kg-ec93af.firebaseapp.com",
  "projectId": "budget-kg-ec93af",
  "appId": "1:249397233596:web:ff5e446750b23c76cd0db9",
  "messagingSenderId": "249397233596",
  "storageBucket": "budget-kg-ec93af.firebasestorage.app"
};
function loadCfg() {
  try { const c = JSON.parse(localStorage.getItem(K_CFG)); if (c && c.apiKey && c.projectId) return c; }
  catch (e) {}
  return (DEFAULT_CFG && DEFAULT_CFG.apiKey) ? DEFAULT_CFG : null;
}
function saveCfg(c) { localStorage.setItem(K_CFG, JSON.stringify(c)); }

/* ---------- разбор куска state ------------------------------------------- */
function metaPart() {
  const s = B.state;
  return {
    settings:       s.settings       || {},
    template:       s.template       || { expenses: [] },
    bonusOverrides: s.bonusOverrides || {},
    bonusSync:      s.bonusSync      || null,
    version:        s.version        || 6,
  };
}
function snapshotParts() {
  const s = B.state;
  const out = { meta: J(metaPart()), months: {}, lists: {} };
  Object.keys(s.months || {}).forEach(ym => { out.months[ym] = J(s.months[ym]); });
  LISTS.forEach(n => { out.lists[n] = J(s[n] || []); });
  return out;
}

/* ============================ запись в облако ============================= */
function schedulePush() {
  if (!ready || applying || !hid) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch(() => setStatus('err', 'ошибка записи')), 1200);
}

async function push() {
  if (!ready || applying || !hid || !db) return;
  const now = snapshotParts();
  const prev = lastPushed || { meta: null, months: {}, lists: {} };
  const writes = [];

  if (now.meta !== prev.meta) {
    writes.push(setDoc(doc(db, 'households', hid),
      { ...metaPart(), savedAt: new Date().toISOString(), updatedBy: ME }, { merge: true }));
  }
  Object.keys(now.months).forEach(ym => {
    if (now.months[ym] !== prev.months[ym]) {
      writes.push(setDoc(doc(db, 'households', hid, 'months', ym),
        { ...B.state.months[ym], savedAt: new Date().toISOString(), updatedBy: ME }));
    }
  });
  // месяц удалён локально («сброс к шаблону») — убрать и в облаке
  Object.keys(prev.months).forEach(ym => {
    if (!(ym in now.months)) writes.push(deleteDoc(doc(db, 'households', hid, 'months', ym)));
  });
  LISTS.forEach(n => {
    if (now.lists[n] !== prev.lists[n]) {
      writes.push(setDoc(doc(db, 'households', hid, 'lists', n),
        { items: B.state[n] || [], savedAt: new Date().toISOString(), updatedBy: ME }));
    }
  });

  if (!writes.length) return;
  setStatus('syncing', 'синк…');
  await Promise.all(writes);
  lastPushed = now;
  setStatus('ok', 'облако ' + hhmm());
}

/* ============================ чтение из облака ============================ */
/* Синхронизированными помечаем ТОЛЬКО те части, которые реально пришли из облака.
   Иначе локальная правка в другом месяце, сделанная параллельно, была бы принята
   за уже отправленную и никогда бы не уехала. */
function markSynced(keys) {
  if (!lastPushed) lastPushed = { meta: null, months: {}, lists: {} };
  const cur = snapshotParts();
  keys.forEach(k => {
    if (k === 'meta') lastPushed.meta = cur.meta;
    else if (k.startsWith('month:')) {
      const ym = k.slice(6);
      if (ym in cur.months) lastPushed.months[ym] = cur.months[ym]; else delete lastPushed.months[ym];
    } else if (k.startsWith('list:')) lastPushed.lists[k.slice(5)] = cur.lists[k.slice(5)];
  });
}
function applyRemote(fn, keys) {
  applying = true;
  try { fn(); B.migrate(); B.persistLocal(); B.render(); }
  finally { applying = false; }
  markSynced(keys || []);
  schedulePush();   // если параллельно были локальные правки — они уедут следом
}

function attach() {
  detach();
  const hRef = doc(db, 'households', hid);

  unsubs.push(onSnapshot(hRef, snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    household = d;
    if (d.updatedBy === ME) { renderBox(); return; }
    applyRemote(() => {
      if (d.settings)       B.state.settings       = d.settings;
      if (d.template)       B.state.template       = d.template;
      if (d.bonusOverrides) B.state.bonusOverrides = d.bonusOverrides;
      if (d.bonusSync)      B.state.bonusSync      = d.bonusSync;
    }, ['meta']);
    setStatus('ok', 'облако ' + hhmm());
  }, () => setStatus('err', 'нет доступа')));

  unsubs.push(onSnapshot(collection(db, 'households', hid, 'months'), snap => {
    const changed = snap.docChanges().filter(c => (c.doc.data() || {}).updatedBy !== ME || c.type === 'removed');
    if (!changed.length) return;
    applyRemote(() => {
      changed.forEach(c => {
        const ym = c.doc.id;
        if (c.type === 'removed') { delete B.state.months[ym]; return; }
        const { savedAt, updatedBy, ...m } = c.doc.data();
        B.state.months[ym] = m;
      });
    }, changed.map(c => 'month:' + c.doc.id));
    setStatus('ok', 'облако ' + hhmm());
  }, () => setStatus('err', 'нет доступа')));

  unsubs.push(onSnapshot(collection(db, 'households', hid, 'lists'), snap => {
    const changed = snap.docChanges().filter(c => (c.doc.data() || {}).updatedBy !== ME);
    if (!changed.length) return;
    applyRemote(() => {
      changed.forEach(c => {
        if (LISTS.includes(c.doc.id)) B.state[c.doc.id] = c.doc.data().items || [];
      });
    }, changed.filter(c => LISTS.includes(c.doc.id)).map(c => 'list:' + c.doc.id));
    setStatus('ok', 'облако ' + hhmm());
  }, () => setStatus('err', 'нет доступа')));
}
function detach() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; }

/* ==================== первая встреча локального и облачного =============== */
function localWeight() {
  const s = B.state;
  return Object.keys(s.months || {}).length + (s.goals || []).length +
         (s.bonuses || []).length + (s.accounts || []).length;
}
async function cloudWeight() {
  const [m, l] = await Promise.all([
    getDocs(collection(db, 'households', hid, 'months')),
    getDocs(collection(db, 'households', hid, 'lists')),
  ]);
  let n = m.size;
  l.forEach(d => { n += ((d.data() || {}).items || []).length; });
  return { n, months: m.size };
}

async function uploadAll() {
  const s = B.state;
  await setDoc(doc(db, 'households', hid),
    { ...metaPart(), savedAt: new Date().toISOString(), updatedBy: ME }, { merge: true });
  await Promise.all([
    ...Object.keys(s.months || {}).map(ym =>
      setDoc(doc(db, 'households', hid, 'months', ym),
        { ...s.months[ym], savedAt: new Date().toISOString(), updatedBy: ME })),
    ...LISTS.map(n =>
      setDoc(doc(db, 'households', hid, 'lists', n),
        { items: s[n] || [], savedAt: new Date().toISOString(), updatedBy: ME })),
  ]);
  lastPushed = snapshotParts();
}

async function downloadAll() {
  // снимок локального состояния ДО того, как облако его перекроет
  if (!localStorage.getItem(K_SNAP)) {
    localStorage.setItem(K_SNAP, JSON.stringify({ at: new Date().toISOString(), state: B.state }));
  }
  const [h, m, l] = await Promise.all([
    getDoc(doc(db, 'households', hid)),
    getDocs(collection(db, 'households', hid, 'months')),
    getDocs(collection(db, 'households', hid, 'lists')),
  ]);
  applyRemote(() => {
    const d = h.exists() ? h.data() : {};
    if (d.settings)       B.state.settings       = d.settings;
    if (d.template)       B.state.template       = d.template;
    if (d.bonusOverrides) B.state.bonusOverrides = d.bonusOverrides;
    if (d.bonusSync)      B.state.bonusSync      = d.bonusSync;
    B.state.months = {};
    m.forEach(x => { const { savedAt, updatedBy, ...mm } = x.data(); B.state.months[x.id] = mm; });
    l.forEach(x => { if (LISTS.includes(x.id)) B.state[x.id] = x.data().items || []; });
  }, []);
  lastPushed = snapshotParts();   // взяли облако целиком — расхождений нет
}

async function resolveFirstContact() {
  const cw = await cloudWeight();
  const lw = localWeight();

  if (cw.n === 0 && lw === 0) { lastPushed = snapshotParts(); return; }
  if (cw.n === 0) { await uploadAll(); return; }                 // облако пустое → залить своё
  if (lw === 0)   { await downloadAll(); return; }               // локально пусто → забрать облако

  const ok = confirm(
    'В облаке уже есть данные этого хозяйства.\n\n' +
    `В облаке: месяцев ${cw.months}, записей всего ${cw.n}\n` +
    `На этом устройстве: месяцев ${Object.keys(B.state.months || {}).length}, записей всего ${lw}\n\n` +
    'OK — взять за основу ОБЛАКО (локальная копия сохранится снимком, её можно вернуть в настройках).\n' +
    'Отмена — залить в облако данные ЭТОГО устройства.'
  );
  if (ok) await downloadAll(); else await uploadAll();
}

/* ============================== участники ================================= */
async function addMember(mail) {
  mail = norm(mail);
  if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { alert('Похоже, это не почта'); return; }
  if (norm(household && household.ownerEmail) !== norm(user.email)) {
    alert('Добавлять участников может только владелец'); return;
  }
  if ((household.memberEmails || []).map(norm).includes(mail)) { alert('Эта почта уже добавлена'); return; }
  try {
    await setDoc(doc(db, 'invites', mail), { hid, addedBy: norm(user.email), addedAt: new Date().toISOString() });
    await updateDoc(doc(db, 'households', hid), { memberEmails: arrayUnion(mail), updatedBy: ME });
    await inviteLink(mail, true);
  } catch (e) { alert('Не вышло: ' + e.message); }
}

/* Выслать участнику письмо со ссылкой входа. Отдельно от sendLink(): там почта
   запоминается для ЭТОГО браузера, а тут письмо уходит другому человеку. */
async function inviteLink(mail, first) {
  mail = norm(mail);
  try {
    setStatus('linking', 'отправляю…');
    await sendSignInLinkToEmail(auth, mail, { url: APP_URL, handleCodeInApp: true });
    setStatus('ok', 'облако ' + hhmm());
    alert((first ? 'Доступ выдан. ' : '') + 'Письмо со ссылкой для входа отправлено на ' + mail +
      '.\n\nПусть откроет ссылку на своём телефоне или компьютере и введёт эту же почту. ' +
      'Если письма нет во «Входящих» — искать в «Спаме», отправитель noreply@' +
      (auth.app.options.projectId || '') + '.firebaseapp.com');
  } catch (e) {
    setStatus('ok', 'облако ' + hhmm());
    alert('Доступ выдан, но письмо отправить не вышло: ' + e.message +
      '\n\nОна всё равно может войти сама: открыть ' + APP_URL + ' и запросить ссылку по своей почте.');
  }
}
async function removeMember(mail) {
  mail = norm(mail);
  if (norm(household && household.ownerEmail) !== norm(user.email)) { alert('Убирать участников может только владелец'); return; }
  if (mail === norm(household.ownerEmail)) { alert('Владельца убрать нельзя'); return; }
  if (!confirm('Отключить ' + mail + ' от бюджета?')) return;
  try {
    await updateDoc(doc(db, 'households', hid), { memberEmails: arrayRemove(mail), updatedBy: ME });
    await deleteDoc(doc(db, 'invites', mail));
  } catch (e) { alert('Не вышло: ' + e.message); }
}

/* =============================== вход ==================================== */
async function sendLink(mail) {
  mail = norm(mail);
  if (!mail) { alert('Введи почту'); return; }
  try {
    setStatus('linking', 'отправляю…');
    await sendSignInLinkToEmail(auth, mail, { url: APP_URL, handleCodeInApp: true });
    localStorage.setItem(K_MAIL, mail);
    setStatus('signedout', '');
    alert('Письмо отправлено на ' + mail + '.\nОткрой ссылку из письма на этом же устройстве.');
  } catch (e) {
    setStatus('err', 'ошибка входа');
    alert('Не вышло: ' + e.message + (String(e.message).includes('unauthorized-domain')
      ? '\n\nДобавь домен kg881.github.io в Firebase → Authentication → Settings → Authorized domains.' : ''));
  }
}

async function completeLinkSignIn() {
  if (!isSignInWithEmailLink(auth, location.href)) return false;
  // Почта может быть зашита в саму ссылку (?m=…) — тогда приглашённому вообще
  // ничего вводить не надо: нажал ссылку и уже внутри.
  let mail = norm(new URLSearchParams(location.search).get('m') || '') || localStorage.getItem(K_MAIL);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!mail) mail = norm(prompt(attempt === 0
      ? 'Введи почту, на которую пришло ЭТО письмо:'
      : 'Не совпало. Введи точно ту почту, в чей ящик пришло письмо с этой ссылкой (без опечаток):') || '');
    if (!mail) return false;
    try {
      await signInWithEmailLink(auth, mail, location.href);
      localStorage.removeItem(K_MAIL);
      history.replaceState({}, '', location.pathname);
      return true;
    } catch (e) {
      const code = e && e.code || '';
      if (code === 'auth/invalid-email') { mail = null; continue; }  // опечатка/не та почта — спросить ещё раз
      alert('Ссылка не подошла: ' + e.message +
        (code === 'auth/invalid-action-code' ? '\n\nСкорее всего, ссылка уже использована или устарела — запроси новую в приложении.' : ''));
      return false;
    }
  }
  alert('Почта так и не совпала. Открой самое свежее письмо и введи адрес того ящика, куда оно пришло.');
  return false;
}

async function bootUser(u) {
  user = u;
  if (!u) { detach(); ready = false; hid = null; household = null; setStatus('signedout', ''); return; }
  const mail = norm(u.email);
  try {
    setStatus('syncing', 'подключаюсь…');
    const inv = await getDoc(doc(db, 'invites', mail));
    if (inv.exists()) hid = inv.data().hid;

    if (!hid) {
      hid = localStorage.getItem(K_HID) || doc(collection(db, 'households')).id;
      const h = await getDoc(doc(db, 'households', hid));
      if (!h.exists()) {
        await setDoc(doc(db, 'households', hid), {
          ownerEmail: mail, memberEmails: [mail],
          createdAt: new Date().toISOString(), updatedBy: ME,
        });
        await setDoc(doc(db, 'invites', mail), { hid, addedBy: mail, addedAt: new Date().toISOString() });
      }
    }
    localStorage.setItem(K_HID, hid);

    const h = await getDoc(doc(db, 'households', hid));
    household = h.exists() ? h.data() : null;

    await resolveFirstContact();
    ready = true;
    attach();
    setStatus('ok', 'облако ' + hhmm());
  } catch (e) {
    ready = false;
    setStatus('err', e.code === 'permission-denied' ? 'нет доступа' : 'ошибка');
    console.warn('[cloud]', e);
  }
  renderBox();
}

/* ============================== инициализация ============================= */
function start() {
  const cfg = loadCfg();
  if (!cfg) { setStatus('setup', ''); renderBox(); return; }
  try {
    app  = initializeApp(cfg);
    auth = getAuth(app);
    db   = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) { setStatus('err', 'конфиг не принят'); renderBox(); return; }

  completeLinkSignIn().finally(() => {
    onAuthStateChanged(auth, u => bootUser(u));
  });
}

/* ================================ UI ===================================== */
function hhmm() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function setStatus(s, t) { status = s; statusText = t; B.setCloudChip(s, t); renderBox(); }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderBox() {
  const box = document.getElementById('cloudBox');
  if (!box) return;
  const snap = localStorage.getItem(K_SNAP);
  const restoreBtn = snap
    ? `<div class="set-actions"><button class="btn sm" id="clRestore">Вернуть копию до подключения облака</button></div>`
    : '';

  if (status === 'setup') {
    box.innerHTML = `<h3>Общий доступ по почте</h3>
      <p class="hint" style="margin-top:0">Один раз создай проект Firebase (бесплатно) и вставь сюда его конфиг — инструкция в файле <b>SETUP-FIREBASE.md</b> в репозитории. Конфиг публичный, доступ к данным закрывают правила на сервере, а не он.</p>
      <textarea class="inp" id="clCfg" placeholder='{"apiKey":"…","authDomain":"…","projectId":"…","appId":"…"}' style="width:100%;min-height:78px;margin:6px 0;font-family:'IBM Plex Mono',monospace;font-size:10px"></textarea>
      <div class="set-actions"><button class="btn solid sm" id="clCfgSave">Сохранить конфиг</button></div>${restoreBtn}`;
    box.querySelector('#clCfgSave').onclick = () => {
      try {
        const raw = box.querySelector('#clCfg').value.trim()
          .replace(/^const\s+firebaseConfig\s*=\s*/, '').replace(/;$/, '');
        const c = JSON.parse(raw.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":').replace(/'/g, '"'));
        if (!c.apiKey || !c.projectId) throw new Error('нет apiKey/projectId');
        saveCfg(c); location.reload();
      } catch (e) { alert('Конфиг не разобрался: ' + e.message); }
    };
    if (snap) box.querySelector('#clRestore').onclick = restoreSnapshot;
    return;
  }

  if (!user) {
    box.innerHTML = `<h3>Общий доступ по почте</h3>
      <div class="set-row" style="border:none"><span class="l">Войди по почте — ссылка придёт письмом, пароль не нужен</span></div>
      <input class="inp" id="clMail" type="email" autocomplete="email" placeholder="почта" value="${esc(localStorage.getItem(K_MAIL) || '')}" style="margin:6px 0">
      <div class="set-actions"><button class="btn solid sm" id="clSend">Прислать ссылку для входа</button><button class="btn sm" id="clReset">Сменить проект</button></div>
      ${restoreBtn}
      <p class="hint">Пока не вошёл — приложение работает как раньше, данные лежат только в этом браузере.</p>`;
    box.querySelector('#clSend').onclick = () => sendLink(box.querySelector('#clMail').value);
    box.querySelector('#clReset').onclick = () => { if (confirm('Забыть конфиг Firebase на этом устройстве? Данные бюджета не затрагиваются.')) { localStorage.removeItem(K_CFG); location.reload(); } };
    if (snap) box.querySelector('#clRestore').onclick = restoreSnapshot;
    return;
  }

  const mine = norm(user.email);
  const owner = norm(household && household.ownerEmail);
  const isOwner = mine === owner;
  const members = (household && household.memberEmails || []).map(norm);
  const rows = members.map(m => `
    <div class="set-row"><span class="l">${esc(m)}${m === owner ? ' · владелец' : ''}${m === mine ? ' · это ты' : ''}</span>
    ${isOwner && m !== owner
        ? `<span style="display:flex;gap:6px"><button class="btn sm" data-send="${esc(m)}">Выслать ссылку</button><button class="btn sm" data-rm="${esc(m)}">Отключить</button></span>`
        : '<span class="l" style="color:var(--ink-3)">доступ есть</span>'}</div>`).join('');

  box.innerHTML = `<h3>Общий доступ по почте</h3>
    <div class="set-row"><span class="l">Ты вошёл как</span><span class="l" style="color:var(--pos)">${esc(user.email)}${isOwner ? ' · владелец' : ' · участник'}</span></div>
    <div class="set-row"><span class="l">Состояние синхронизации</span><span class="l">${status === 'ok' ? 'всё синхронизировано · ' + esc(statusText) : status === 'syncing' ? 'обмен…' : status === 'err' ? 'ошибка: ' + esc(statusText) : '—'}</span></div>
    <div class="set-row" style="border:none;padding-top:10px"><span class="l"><b>Кто пользуется бюджетом</b></span></div>
    ${rows || '<p class="hint" style="margin-top:0">Пока только ты.</p>'}
    ${isOwner ? `
      <div class="set-row" style="border:none;margin-top:6px"><span class="l">Добавить почту — человек получит полный доступ</span></div>
      <input class="inp" id="clNew" type="email" autocomplete="off" placeholder="почта жены" style="margin:6px 0">
      <div class="set-actions"><button class="btn solid sm" id="clAdd">Дать доступ</button></div>` : ''}
    <div class="set-actions" style="margin-top:8px"><button class="btn sm" id="clOut">Выйти</button></div>
    ${restoreBtn}
    <p class="hint">Данные лежат в Firestore и видны только почтам из списка выше — это проверяет сервер, а не браузер. Правки прилетают на все устройства сразу. Месяцы хранятся раздельно, поэтому одновременная работа над разными месяцами не затирает чужое.</p>`;

  box.querySelector('#clAdd') && (box.querySelector('#clAdd').onclick = () => addMember(box.querySelector('#clNew').value));
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => removeMember(b.dataset.rm));
  box.querySelectorAll('[data-send]').forEach(b => b.onclick = () => inviteLink(b.dataset.send, false));
  box.querySelector('#clOut').onclick = async () => { detach(); ready = false; await signOut(auth); location.reload(); };
  if (snap) box.querySelector('#clRestore').onclick = restoreSnapshot;
}

function restoreSnapshot() {
  const raw = localStorage.getItem(K_SNAP);
  if (!raw) return;
  let s; try { s = JSON.parse(raw); } catch (e) { alert('Снимок повреждён'); return; }
  if (!confirm('Вернуть данные бюджета к состоянию на ' + new Date(s.at).toLocaleString('ru-RU') +
               ' (до подключения облака)?\n\nТекущие данные на этом устройстве будут заменены. Облако не трогается, пока ты не сохранишь что-нибудь заново.')) return;
  applying = true;
  try { B.state = s.state; B.migrate(); B.persistLocal(); B.render(); } finally { applying = false; }
  lastPushed = null;
  alert('Готово. Проверь данные; если всё верно — правки уедут в облако при следующем изменении.');
}

/* ---------- мост ---------------------------------------------------------- */
B.onSave = () => schedulePush();
B.onRender = () => renderBox();
window.__cloud = { push, status: () => status, hid: () => hid };

start();
