import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, addDoc, deleteDoc, query, orderBy, onSnapshot, where, getDocs, limit, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const root = document.getElementById('app');
let currentUser = null;      
let unsubMessages = null;    
let replyTo = null;
let pendingPhoto = null;

/* ---------------- Background Music Player ---------------- */
let bgAudio = null;
let isBgMusicPlaying = false;

function initBgAudio() {
  if (!bgAudio) {
    bgAudio = new Audio('https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3');
    bgAudio.loop = true;
    bgAudio.volume = 0.4;
  }
}

window.toggleBgMusic = function() {
  initBgAudio();
  const btn = document.getElementById('bg-music-btn');
  if (isBgMusicPlaying) {
    bgAudio.pause();
    isBgMusicPlaying = false;
    if (btn) btn.textContent = "🔇 BG Audio: OFF";
  } else {
    bgAudio.play().catch(e => console.log("Audio play blocked:", e));
    isBgMusicPlaying = true;
    if (btn) btn.textContent = "🔊 BG Audio: ON";
  }
};

/* ---------------- Photo / cooldown / retention limits ---------------- */
const PHOTO_COOLDOWN_MS = 30 * 60 * 1000;  
const MAX_PHOTO_MB = 5;
const AUTO_DELETE_MS = 72 * 60 * 60 * 1000; 

function validatePhotoFile(file) {
  if (!file.type || !file.type.startsWith('image/')) return 'Sirf image files allowed hain.';
  if (file.size > MAX_PHOTO_MB * 1024 * 1024) return `Photo ${MAX_PHOTO_MB}MB se chhoti honi chahiye.`;
  return null;
}

function isAdminOrOwner(u) {
  return u && (u.role === 'Admin' || u.role === 'Owner');
}

function cooldownRemainingMs(roomKey) {
  const u = currentUser;
  if (isAdminOrOwner(u)) return 0;
  const last = u.photoCooldowns && u.photoCooldowns[roomKey];
  if (!last) return 0;
  return Math.max(0, PHOTO_COOLDOWN_MS - (Date.now() - last));
}

async function markCooldown(roomKey) {
  const u = currentUser;
  if (isAdminOrOwner(u)) return;
  try {
    await updateDoc(doc(db, "Users", u.uid), { [`photoCooldowns.${roomKey}`]: Date.now() });
    if (!u.photoCooldowns) u.photoCooldowns = {};
    u.photoCooldowns[roomKey] = Date.now();
  } catch (e) { /* non-fatal */ }
}

function cooldownText(ms) {
  const mins = Math.ceil(ms / 60000);
  return `⚠️ Photo cooldown active – ${mins} minute${mins === 1 ? '' : 's'} baaki hain.`;
}

async function cleanupOldMessages(chatRoomId) {
  try {
    const cutoff = Date.now() - AUTO_DELETE_MS;
    const snap = await getDocs(collection(db, "Chats", chatRoomId, "Messages"));
    const stale = [];
    snap.forEach(d => {
      const t = d.data().createdAt?.toMillis ? d.data().createdAt.toMillis() : 0;
      if (t && t < cutoff) stale.push(d.id);
    });
    await Promise.all(stale.map(id => deleteDoc(doc(db, "Chats", chatRoomId, "Messages", id)).catch(() => {})));
  } catch (e) { /* non-fatal */ }
}

/* ---------------- Per-room unread tracking ---------------- */
function roomSeenKey(roomId) {
  return `studentchat-seen-${currentUser.uid}-${roomId}`;
}
function markRoomSeen(roomId) {
  localStorage.setItem(roomSeenKey(roomId), String(Date.now()));
}

/* ---------------- Browser Push Notifications ---------------- */
const NOTIF_PREF_KEY = 'studentchat-notif-prefs';
// Categories: global chat, anonymous chat, class chat (also covers the admin room), admin/system announcements.
const DEFAULT_NOTIF_PREFS = { global: true, anonymous: true, classChat: true, announcements: true };

function getNotifPrefs() {
  try { return { ...DEFAULT_NOTIF_PREFS, ...JSON.parse(localStorage.getItem(NOTIF_PREF_KEY) || '{}') }; }
  catch (e) { return { ...DEFAULT_NOTIF_PREFS }; }
}
function setNotifPref(category, enabled) {
  const prefs = getNotifPrefs();
  prefs[category] = enabled;
  localStorage.setItem(NOTIF_PREF_KEY, JSON.stringify(prefs));
}
function notifPermissionState() {
  return ('Notification' in window) ? Notification.permission : 'unsupported'; // 'granted' | 'denied' | 'default' | 'unsupported'
}
async function requestNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
  try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
}
// Fires a real OS/browser notification. Only when permission is granted, the category is enabled,
// and the tab is in the background (avoids double-alerting someone already looking at the chat).
function fireBrowserNotification(title, body, tag) {
  if (notifPermissionState() !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body: body || '', tag, icon: 'https://cdn-icons-png.flaticon.com/512/149/149071.png' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { /* some browsers throw if called from a non-user gesture context on certain platforms */ }
}

// One realtime listener for admin/system announcements, set up once per login (not per page visit).
let unsubAnnouncements = null;
function setupAnnouncementListener() {
  if (unsubAnnouncements || !currentUser) return;
  const q = query(collection(db, "Notifications"), where("toUid", "in", ["all", currentUser.uid]));
  let initialLoadDone = false;
  unsubAnnouncements = onSnapshot(q, (snap) => {
    if (initialLoadDone && getNotifPrefs().announcements) {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          const n = change.doc.data();
          fireBrowserNotification(n.title || '📢 Announcement', n.body || n.text || '', 'announcement-' + change.doc.id);
        }
      });
    }
    initialLoadDone = true;
  }, () => { /* non-fatal if it fails (e.g. missing Firestore index on first run) */ });
}
async function roomHasUnread(roomId) {
  try {
    const lastSeen = Number(localStorage.getItem(roomSeenKey(roomId)) || 0);
    const snap = await getDocs(query(collection(db, "Chats", roomId, "Messages"), orderBy("createdAt", "desc"), limit(1)));
    if (snap.empty) return false;
    const t = snap.docs[0].data().createdAt?.toMillis ? snap.docs[0].data().createdAt.toMillis() : 0;
    return t > lastSeen;
  } catch (e) { return false; }
}

/* ---------------- GLOBAL ANTI-ABUSE (Bad Words) ---------------- */
let bannedWordsList = [];
onSnapshot(doc(db, "Settings", "AntiAbuse"), (snap) => {
  bannedWordsList = snap.exists() ? (snap.data().words || []) : [];
  if (currentPath() === 'admin' && typeof loadAdminBadWords === 'function') {
    loadAdminBadWords();
  }
});

function maskBadWords(text) {
  if (!bannedWordsList.length) return text;
  let masked = text;
  bannedWordsList.forEach(word => {
    const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${safeWord}\\b`, 'gi');
    masked = masked.replace(regex, '*'.repeat(word.length));
  });
  return masked;
}

/* ---------------- Community Rules State ---------------- */
let communityRulesText = "1. Kisi ke saath gaali-galoch ya bullying allowed nahi hai.\n2. Personal details (address, phone number) share na karein.\n3. Sirf apni class ke room mein message bhej sakte ho; doosri class ke rooms read-only hain.\n4. Spam ya baar-baar same message bhejna ban ka reason ban sakta hai.\n5. Admin/Owner ke decisions final hain.";
onSnapshot(doc(db, "Settings", "CommunityRules"), (snap) => {
  if (snap.exists() && snap.data().rules) {
    communityRulesText = snap.data().rules;
  }
});

/* ---------------- Tags, classes ---------------- */
const ALL_CLASSES = Array.from({length:12},(_,i)=>`Class ${i+1}`).concat(['12th Pass / College']);

const TAG_COLORS = {
  class:'#6366f1', admin:'#dc2626', student:'#6b7280'
};
const SUBJECT_PALETTE = ['#0ea5e9','#8b5cf6','#ec4899','#f59e0b','#10b981','#ef4444','#3b82f6','#a855f7','#14b8a6','#f97316'];

function hashColor(label) {
  let h = 0;
  for (const c of String(label)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SUBJECT_PALETTE[h % SUBJECT_PALETTE.length];
}

function makeTag(label, type) {
  const color = type === 'class' ? TAG_COLORS.class : (TAG_COLORS[type] || hashColor(label));
  return { id: type + '-' + slugify(label), label, color, type };
}

function renderTagChips(tags, viewerIsAdmin) {
  if (!tags || !tags.length) return '';
  const visible = tags.filter(t => t.type !== 'admin' || viewerIsAdmin);
  if (!visible.length) return '';
  return `<div class="tag-row">${visible.map(t =>
    `<span class="tag-chip" style="background:${t.color}22; color:${t.color}; border:1px solid ${t.color}66;">${escapeHtml(t.label)}</span>`
  ).join('')}</div>`;
}

/* ---------------- Theme (Light/Dark) ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('studentchat-theme', theme);
}
applyTheme(localStorage.getItem('studentchat-theme') || 'light');
window.setTheme = applyTheme;

function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')   
    .replace(/^-+|-+$/g, '');      
}

function ageFromDob(dob) {
  if (!dob || dob === 'N/A') return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 && age < 100 ? age : null;
}

/* ---------------- Hash Router ---------------- */
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const snap = await getDoc(doc(db, "Users", user.uid));
        currentUser = snap.exists() ? { uid: user.uid, ...snap.data() } : { uid: user.uid, username: "Student", role: "Student" };
      } catch (e) {
        console.error("Firestore error:", e);
        currentUser = { uid: user.uid, role: "Student" };
      }
      setupAnnouncementListener();
    } else {
      if (unsubAnnouncements) { unsubAnnouncements(); unsubAnnouncements = null; }
      currentUser = null;
    }
    route();
  });
});

function go(hash) { window.location.hash = hash; }
window.go = go; 

function currentPath() {
  return (window.location.hash || '#/login').slice(1);
}

function route() {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  const path = currentPath();
  const chatMatch = path.match(/^\/chat\/([a-z0-9-]+)$/i);
  
  const protectedPages = ['/home', '/start', '/rules', '/admin', '/notifications', '/suggestions', '/bug-report'];
  if ((protectedPages.includes(path) || chatMatch) && !currentUser) {
    return go('#/login');
  }
  
  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/forgot-password') return renderForgot();
  if (path === '/home') return renderHome();
  if (path === '/start') return renderStart();
  if (path === '/rules') return renderRules();
  if (path === '/admin') return renderAdmin();
  if (path === '/notifications') return renderNotifications();
  if (path === '/suggestions') return renderSuggestions();
  if (path === '/bug-report') return renderBugReport();
  if (chatMatch) return renderChat(chatMatch[1]);
  if (path === '/' || path === '') return go('#/login');
  
  return renderNotFound();
}

/* ---------------- Shared bits ---------------- */
function navbar(active) {
  return `
  <nav class="bottom">
    <button class="${active==='home'?'active':''}" onclick="go('#/home')"><span class="ic">🏠</span>Home</button>
    <button class="${active==='chat'?'active':''}" onclick="go('#/chat/global')"><span class="ic">💬</span>Chat</button>
    <button class="${active==='start'?'active':''}" onclick="go('#/start')"><span class="ic">👤</span>Profile</button>
    <button onclick="doLogout()"><span class="ic">🚪</span>Logout</button>
  </nav>`;
}
window.doLogout = async () => { await signOut(auth); go('#/login'); };

/* ---------------- LOGIN ---------------- */
function renderLogin() {
  root.innerHTML = `
  <header><h1>🎓 StudentChat</h1></header>
  <main>
    <div class="card">
      <h2 class="section-title">Login</h2>
      <div id="err" class="err hide"></div>
      <label>Username</label>
      <input id="f-user" placeholder="e.g. ravi_kumar" autocomplete="username">
      <label>Password</label>
      <input id="f-pass" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="primary" id="btn-login">Login</button>
      <p class="switch-link">Don't have an account? <a onclick="go('#/register')">Register</a></p>
      <p class="switch-link"><a onclick="go('#/forgot-password')">Forgot Password?</a></p>
    </div>
  </main>`;
  document.getElementById('btn-login').onclick = async () => {
    const username = document.getElementById('f-user').value.trim().toLowerCase();
    const password = document.getElementById('f-pass').value;
    const err = document.getElementById('err');
    err.classList.add('hide');
    if (!username || !password) {
      err.textContent = "Username aur password dono chahiye.";
      err.classList.remove('hide');
      return;
    }
    try {
      const email = `${username}@studentchat.com`;
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const snap = await getDoc(doc(db, "Users", cred.user.uid));
      const data = snap.exists() ? snap.data() : {};
      go(data.role === 'Admin' || data.role === 'Owner' ? '#/admin' : '#/home');
    } catch (e) {
      err.textContent = "Invalid Username or Password.";
      err.classList.remove('hide');
    }
  };
}

/* ---------------- REGISTER ---------------- */
function processImageToBase64(file, maxWidth, quality, cb) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * (maxWidth / w)); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function renderRegister() {
  root.innerHTML = `
  <header><h1>📝 Create Account</h1></header>
  <main>
    <div class="card">
      <div id="err" class="err hide"></div>
      <label>Full Name</label><input id="r-name" placeholder="Ravi Kumar">
      <label>Username</label><input id="r-user" placeholder="ravi_kumar">
      <label>Password</label><input id="r-pass" type="password" placeholder="••••••••">
      <label>Date of Birth</label><input id="r-dob" type="date">
      <label>Class Level</label>
      <select id="r-class">
        <option value="">-- Select Class --</option>
        ${Array.from({length:12},(_,i)=>i+1).map(n=>`<option>Class ${n}</option>`).join('')}
        <option value="12th Pass / College">12th Pass / College</option>
      </select>
      <label>School Name</label><input id="r-school" placeholder="DAV Public School">
      <label>Profile Photo (optional)</label><input id="r-photo" type="file" accept="image/*">
      <button class="primary" id="btn-register">Register</button>
      <p class="switch-link">Already have an account? <a onclick="go('#/login')">Login</a></p>
    </div>
  </main>`;
  document.getElementById('btn-register').onclick = () => {
    const fullName = document.getElementById('r-name').value.trim();
    const username = document.getElementById('r-user').value.trim().toLowerCase();
    const password = document.getElementById('r-pass').value;
    const dob = document.getElementById('r-dob').value;
    const classLevel = document.getElementById('r-class').value;
    const schoolName = document.getElementById('r-school').value.trim();
    const file = document.getElementById('r-photo').files[0];
    const err = document.getElementById('err');
    err.classList.add('hide');
    
    const requiredFields = [
      { id: 'r-name',   value: fullName,   label: 'Full Name' },
      { id: 'r-user',   value: username,   label: 'Username' },
      { id: 'r-pass',   value: password,   label: 'Password' },
      { id: 'r-dob',    value: dob,        label: 'Date of Birth' },
      { id: 'r-class',  value: classLevel, label: 'Class Level' },
      { id: 'r-school', value: schoolName, label: 'School Name' },
    ];
    for (const field of requiredFields) {
      if (!field.value) {
        alert(`Please fill: ${field.label}`);
        const el = document.getElementById(field.id);
        el.focus();
        err.textContent = `${field.label} is required.`;
        err.classList.remove('hide');
        return;
      }
    }
    if (password.length < 6) {
      alert('Please fill: Password (minimum 6 characters)');
      document.getElementById('r-pass').focus();
      err.textContent = "Password kam se kam 6 characters ka hona chahiye.";
      err.classList.remove('hide');
      return;
    }
    const finish = async (photoBase64) => {
      try {
        const email = `${username}@studentchat.com`;
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(db, "Users", cred.user.uid), {
          uid: cred.user.uid,
          fullName: fullName || "Student",
          username,
          dob: dob || "N/A",
          classLevel: classLevel || "Class 9",
          schoolName: schoolName || "Not Provided",
          profilePhoto: photoBase64 || "https://cdn-icons-png.flaticon.com/512/149/149071.png",
          bio: "",
          role: "Student",
          tags: [makeTag(classLevel || "Class 9", 'class'), makeTag('Student', 'student')],
          classAccess: [classLevel || "Class 9"],
          createdAt: serverTimestamp(),
          isBanned: false,
          timeoutExpiry: null
        });
        go('#/home');
      } catch (e) {
        err.textContent = e.message.includes('email-already-in-use') ? "Yeh username pehle se liya gaya hai." : e.message;
        err.classList.remove('hide');
      }
    };
    if (file) {
      processImageToBase64(file, 500, 0.6, finish);
    } else {
      finish(null);
    }
  };
}

/* ---------------- FORGOT PASSWORD ---------------- */
function renderForgot() {
  root.innerHTML = `
  <header><h1>🔑 Reset Password</h1></header>
  <main>
    <div class="card">
      <div id="msg" class="hide"></div>
      <label>Username</label>
      <input id="fp-user" placeholder="Enter your username">
      <button class="primary" id="btn-fp">Send Reset Link</button>
      <p class="switch-link"><a onclick="go('#/login')">Back to Login</a></p>
    </div>
  </main>`;
  document.getElementById('btn-fp').onclick = async () => {
    const username = document.getElementById('fp-user').value.trim().toLowerCase();
    const msg = document.getElementById('msg');
    msg.className = '';
    try {
      await sendPasswordResetEmail(auth, `${username}@studentchat.com`);
      msg.textContent = "Reset link bhej diya gaya hai (aapke registered email pattern par).";
      msg.className = 'note';
    } catch (e) {
      msg.textContent = "Username nahi mila.";
      msg.className = 'err';
    }
    msg.classList.remove('hide');
  };
}

/* ---------------- HOME ---------------- */
function renderHome() {
  const u = currentUser;
  const isAdmin = isAdminOrOwner(u);
  const classAccess = (u.classAccess && u.classAccess.length) ? u.classAccess : [u.classLevel || 'Class 9'];
  const classOpts = [...new Set(classAccess)].map(c => `
      <div class="opt" onclick="go('#/chat/${slugify(c)}')">
        <div class="ic" style="background:#dcfce7; position:relative;">🎓 <span class="unread-dot hide" id="dot-${slugify(c)}"></span></div>
        <div class="tx"><b>${escapeHtml(c)} Room</b><span>Sirf is class ke students</span></div>
      </div>`).join('');

  root.innerHTML = `
  <header>
    <h1>🎓 StudentChat</h1>
    <div style="display:flex; align-items:center; gap:8px;">
      <button id="btn-bell" style="position:relative; background:none; border:none; color:#fff; font-size:1.15rem; cursor:pointer;">
        🔔 <span id="notif-badge" class="notif-badge hide">0</span>
      </button>
      <span class="pill">@${escapeHtml(u.username)}</span>
    </div>
  </header>
  <main>
    <div class="profile-card">
      <img class="avatar-img" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <h2>${escapeHtml(u.fullName || u.username)}</h2>
      <p>${escapeHtml(u.schoolName || 'Not Provided')}</p>
      ${renderTagChips(u.tags, isAdmin)}
    </div>

    <div class="options">
      <div class="opt" onclick="go('#/chat/global')">
        <div class="ic" style="background:#dbeafe; position:relative;">🌍 <span class="unread-dot hide" id="dot-global"></span></div>
        <div class="tx"><b>Global Chat</b><span>Sab verified students ke saath</span></div>
      </div>
      <div class="opt" onclick="go('#/chat/anonymous')">
        <div class="ic" style="background:#ede9fe; position:relative;">🥷 <span class="unread-dot hide" id="dot-anonymous"></span></div>
        <div class="tx"><b>Anonymous Chat</b><span>Naam/DP hidden rehta hai</span></div>
      </div>
      
      ${classOpts}
      
      <div class="opt" onclick="go('#/rules')">
        <div class="ic" style="background:#fef3c7;">📜</div>
        <div class="tx"><b>Community Rules</b><span>Chat guidelines padhein</span></div>
      </div>
      <div class="opt" onclick="go('#/suggestions')">
        <div class="ic" style="background:#e0f2fe;">💡</div>
        <div class="tx"><b>Suggestion Box</b><span>Apna suggestion Admin tak pahunchayein</span></div>
      </div>
      <div class="opt" onclick="go('#/bug-report')">
        <div class="ic" style="background:#fee2e2;">🐛</div>
        <div class="tx"><b>Report a Bug</b><span>Screenshot ke saath bug batayein</span></div>
      </div>
      <div class="opt" onclick="go('#/start')">
        <div class="ic" style="background:#f3e8ff;">✏️</div>
        <div class="tx"><b>Edit Profile</b><span>DP aur bio update karein</span></div>
      </div>

      ${isAdmin ? `
      <div class="opt" onclick="go('#/chat/admin-room')" style="border-color:#dc2626; background:var(--soft-accent);">
        <div class="ic" style="background:#fecaca; font-size:1.2rem; position:relative;">🛡️ <span class="unread-dot hide" id="dot-admin-room"></span></div>
        <div class="tx"><b style="color:#dc2626;">Admin Chat Room</b><span>Sirf Admin/Owner ke liye – secret room</span></div>
      </div>
      <div class="opt" onclick="go('#/admin')" style="border-color: #dc2626; background: var(--soft-accent);">
        <div class="ic" style="background:#fecaca; font-size:1.2rem;">⚙️</div>
        <div class="tx"><b style="color:#dc2626;">Admin Panel</b><span>Manage users & filters</span></div>
      </div>
      ` : ''}

    </div>
  </main>
  ${navbar('home')}`;

  document.getElementById('btn-bell').onclick = () => go('#/notifications');

  (async () => {
    try {
      const snap = await getDocs(query(collection(db, "Notifications"), where("toUid", "in", ["all", u.uid])));
      const lastSeen = Number(localStorage.getItem('studentchat-lastseen-' + u.uid) || 0);
      let unread = 0;
      snap.forEach(d => {
        const t = d.data().createdAt?.toMillis ? d.data().createdAt.toMillis() : 0;
        if (t > lastSeen) unread++;
      });
      const badge = document.getElementById('notif-badge');
      if (badge && unread > 0) { badge.textContent = unread > 9 ? '9+' : String(unread); badge.classList.remove('hide'); }
    } catch (e) { /* ignore */ }
  })();

  const roomIds = ['global', 'anonymous', ...classAccess.map(slugify), ...(isAdmin ? ['admin-room'] : [])];
  roomIds.forEach(async (rid) => {
    if (await roomHasUnread(rid)) {
      document.getElementById(`dot-${rid}`)?.classList.remove('hide');
    }
  });
}

/* ---------------- EDIT PROFILE (Start) ---------------- */
function renderStart() {
  const u = currentUser;
  root.innerHTML = `
  <header><h1>⚙️ Edit Profile</h1></header>
  <main>
    <div class="card">
      <img class="avatar-img" style="margin:0 auto 14px;" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <label>Profile Photo</label><input id="s-photo" type="file" accept="image/*">
      <label>Bio</label><textarea id="s-bio" rows="3">${u.bio || ''}</textarea>
      <div id="s-msg" class="hide"></div>
      <button class="primary" id="btn-save">Save Changes</button>
      <p class="switch-link"><a onclick="go('#/home')">🔙 Back to Home</a></p>
    </div>
    <h2 class="section-title" style="margin-top:20px;">Appearance</h2>
    <div class="card">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Apni pasand ki theme chuno.</p>
      <div class="theme-toggle">
        <button id="theme-light" class="theme-btn">☀️ Light</button>
        <button id="theme-dark" class="theme-btn">🌙 Dark</button>
        <button id="theme-sepia" class="theme-btn">📜 Sepia</button>
        <button id="theme-ocean" class="theme-btn">🌊 Ocean</button>
      </div>
    </div>

    <h2 class="section-title" style="margin-top:20px;">🔔 Notifications</h2>
    <div class="card">
      <div id="notif-perm-note" style="font-size:.78rem; margin-bottom:10px;"></div>
      <label class="check-row"><input type="checkbox" id="notif-global"> Global Chat</label>
      <label class="check-row"><input type="checkbox" id="notif-anonymous"> Anonymous Chat</label>
      <label class="check-row"><input type="checkbox" id="notif-classChat"> Class Chat</label>
      <label class="check-row"><input type="checkbox" id="notif-announcements"> Announcements</label>
      <p style="font-size:.7rem; color:var(--muted); margin-top:8px;">Jab tab background mein ho tabhi notification aayega — jab aap chat khud dekh rahe ho tab nahi (taaki double alert na ho).</p>
    </div>
  </main>
  ${navbar('start')}`;
  
  const active = localStorage.getItem('studentchat-theme') || 'light';
  ['light', 'dark', 'sepia', 'ocean'].forEach(t => {
    const btn = document.getElementById(`theme-${t}`);
    btn.classList.toggle('active', active === t);
    btn.onclick = () => { setTheme(t); renderStart(); };
  });

  /* --- Notification preference checkboxes --- */
  const prefs = getNotifPrefs();
  ['global', 'anonymous', 'classChat', 'announcements'].forEach(cat => {
    const box = document.getElementById('notif-' + cat);
    box.checked = !!prefs[cat];
    box.onchange = async () => {
      if (box.checked && notifPermissionState() !== 'granted') {
        const result = await requestNotifPermission();
        if (result !== 'granted') {
          box.checked = false;
          renderPermNote();
          alert('Browser notifications block ho gayi hain — apni browser settings mein StudentChat ke liye allow karein.');
          return;
        }
      }
      setNotifPref(cat, box.checked);
      renderPermNote();
    };
  });

  function renderPermNote() {
    const note = document.getElementById('notif-perm-note');
    const state = notifPermissionState();
    if (state === 'unsupported') note.innerHTML = `⚠️ Yeh browser notifications support nahi karta.`;
    else if (state === 'granted') note.innerHTML = `✅ Browser notifications allowed hain.`;
    else if (state === 'denied') note.innerHTML = `🚫 Browser notifications block hain — kisi bhi category ko ON karne ke liye apni browser settings se allow karein.`;
    else note.innerHTML = `ℹ️ Kisi bhi category ko ON karte hi browser permission maangi jaayegi.`;
  }
  renderPermNote();

  document.getElementById('btn-save').onclick = () => {
    const bio = document.getElementById('s-bio').value.trim();
    const file = document.getElementById('s-photo').files[0];
    const msg = document.getElementById('s-msg');
    const save = async (photoBase64) => {
      const updates = { bio };
      if (photoBase64) updates.profilePhoto = photoBase64;
      try {
        await updateDoc(doc(db, "Users", u.uid), updates);
        Object.assign(currentUser, updates);
        msg.textContent = "Saved ✅";
        msg.className = 'note';
        msg.classList.remove('hide');
      } catch (e) {
        msg.textContent = "Save failed: " + e.message;
        msg.className = 'err';
        msg.classList.remove('hide');
      }
    };
    if (file) processImageToBase64(file, 500, 0.6, save);
    else save(null);
  };
}

/* ---------------- NOTIFICATIONS ---------------- */
async function renderNotifications() {
  const u = currentUser;
  root.innerHTML = `
  <header><h1>🔔 Notifications</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main><div class="loading">Loading...</div></main>
  ${navbar('')}`;
  
  localStorage.setItem('studentchat-lastseen-' + u.uid, String(Date.now()));
  try {
    const snap = await getDocs(query(collection(db, "Notifications"), where("toUid", "in", ["all", u.uid])));
    const items = [];
    snap.forEach(d => items.push(d.data()));
    items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    
    if (!items.length) {
      root.querySelector('main').innerHTML = `<div class="card" style="text-align:center; color:var(--muted);">Koi notification nahi hai abhi.</div>`;
      return;
    }
    
    root.querySelector('main').innerHTML = items.map(n => `
      <div class="card notif-item">
        ${n.title ? `<b>${escapeHtml(n.title)}</b>` : ''}
        <p style="font-size:.85rem; margin-top:4px;">${escapeHtml(n.body || n.text || '')}</p>
        <span style="font-size:.68rem; color:var(--muted);">${n.sentBy ? 'From @' + escapeHtml(n.sentBy) : ''} ${n.toUid !== 'all' ? '• Personal' : '• Announcement'}</span>
      </div>`).join('');
  } catch (e) {
    root.querySelector('main').innerHTML = `<div class="err">Couldn't load notifications: ${escapeHtml(e.message)}</div>`;
  }
}

/* ---------------- COMMUNITY RULES WITH BACKGROUND VIDEO ---------------- */
function renderRules() {
  const rulesHtml = communityRulesText.split('\n').map(line => `<li>${escapeHtml(line)}</li>`).join('');
  root.innerHTML = `
  <header><h1>📜 Community Rules</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <div class="card">
      <div class="section-video-container">
        <video class="section-bg-video" autoplay muted loop playsinline id="rules-video">
          <source src="7P44RR032Y.mp4" type="video/mp4">
          Your browser does not support the video tag.
        </video>
        <div class="video-controls-bar">
          <button id="vid-play-btn" onclick="toggleVideoPlay()" type="button">⏸️ Pause</button>
          <button id="vid-audio-btn" onclick="toggleVideoAudio()" type="button">🔇 Audio: OFF</button>
        </div>
      </div>
      <ol class="rules-list">
        ${rulesHtml}
      </ol>
      <button class="primary" onclick="go('#/home')" style="margin-top:16px;">Got it, back to Home</button>
    </div>
  </main>
  ${navbar('rules')}`;
}

window.toggleVideoPlay = function() {
  const vid = document.getElementById('rules-video');
  const btn = document.getElementById('vid-play-btn');
  if (!vid) return;
  if (vid.paused) {
    vid.play();
    if (btn) btn.textContent = "⏸️ Pause";
  } else {
    vid.pause();
    if (btn) btn.textContent = "▶️ Play";
  }
};

window.toggleVideoAudio = function() {
  const vid = document.getElementById('rules-video');
  const btn = document.getElementById('vid-audio-btn');
  if (!vid) return;
  vid.muted = !vid.muted;
  if (btn) {
    btn.textContent = vid.muted ? "🔇 Audio: OFF" : "🔊 Audio: ON";
  }
};

/* ---------------- SUGGESTION BOX ---------------- */
function renderSuggestions() {
  const u = currentUser;
  const isAdmin = isAdminOrOwner(u);
  root.innerHTML = `
  <header><h1>💡 Suggestion Box</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <div class="card">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:8px;">Apna suggestion likhein – sirf Admin/Owner isse dekh sakte hain. Photo optional hai${isAdmin ? '' : ' (1 submission har 40 minute mein)'}.</p>
      <div id="sugg-err" class="err hide"></div>
      <label>Suggestion</label>
      <textarea id="sugg-text" rows="3" placeholder="Aapka suggestion..."></textarea>
      <label>Photo (optional)</label>
      <input id="sugg-photo" type="file" accept="image/*">
      <button class="primary" id="btn-sugg-submit">Submit</button>
      <div id="sugg-msg" class="hide"></div>
    </div>
    ${isAdmin ? `<h2 class="section-title" style="margin-top:20px;">All Suggestions</h2><div class="card" id="sugg-list"><div class="loading">Loading...</div></div>` : ''}
  </main>
  ${navbar('')}`;

  document.getElementById('btn-sugg-submit').onclick = () => {
    const err = document.getElementById('sugg-err');
    err.classList.add('hide');
    const text = document.getElementById('sugg-text').value.trim();
    if (!text) { err.textContent = 'Suggestion likhein.'; err.classList.remove('hide'); return; }
    
    const remaining = cooldownRemainingMs('suggestions');
    if (remaining > 0) { err.textContent = cooldownText(remaining); err.classList.remove('hide'); return; }

    const file = document.getElementById('sugg-photo').files[0];
    if (file) {
      const v = validatePhotoFile(file);
      if (v) { err.textContent = v; err.classList.remove('hide'); return; }
    }

    const submit = async (photoBase64) => {
      try {
        await addDoc(collection(db, "Suggestions"), {
          uid: u.uid, username: u.username, text, photo: photoBase64 || null, createdAt: serverTimestamp()
        });
        await markCooldown('suggestions');
        const msg = document.getElementById('sugg-msg');
        msg.textContent = 'Submitted – Thank you!';
        msg.className = 'note';
        msg.classList.remove('hide');
        document.getElementById('sugg-text').value = '';
        document.getElementById('sugg-photo').value = '';
      } catch (e) {
        err.textContent = 'Submit failed: ' + e.message;
        err.classList.remove('hide');
      }
    };
    if (file) processImageToBase64(file, 800, 0.6, submit);
    else submit(null);
  };

  if (isAdmin) loadSuggestionsList();
}

async function loadSuggestionsList() {
  const box = document.getElementById('sugg-list');
  if (!box) return;
  try {
    const snap = await getDocs(collection(db, "Suggestions"));
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    if (!items.length) { box.innerHTML = `<p style="font-size:.8rem; color:var(--muted);">Koi suggestion nahi hai abhi.</p>`; return; }
    box.innerHTML = items.map(s => `
      <div class="card" id="sugg-${s.id}" style="margin-bottom:10px;">
        <b>@${escapeHtml(s.username || 'unknown')}</b>
        <span style="font-size:.68rem; color:var(--muted); float:right;">${s.createdAt?.toDate ? s.createdAt.toDate().toLocaleString() : ''}</span>
        <p style="font-size:.85rem; margin-top:6px; clear:both;">${escapeHtml(s.text)}</p>
        ${s.photo ? `<img src="${s.photo}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid var(--line); cursor:pointer;" onclick="openLightbox(this.src)">` : ''}
        <button class="del-btn" onclick="adminDeleteSuggestion('${s.id}')">Delete</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="err">Couldn't load: ${escapeHtml(e.message)}</div>`;
  }
}

window.adminDeleteSuggestion = async (id) => {
  if (!confirm('Delete this suggestion?')) return;
  await deleteDoc(doc(db, "Suggestions", id));
  document.getElementById('sugg-' + id)?.remove();
};

/* ---------------- BUG REPORT BOX ---------------- */
function renderBugReport() {
  const u = currentUser;
  const isAdmin = isAdminOrOwner(u);
  root.innerHTML = `
  <header><h1>🐛 Bug Report</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <div class="card">
      <div id="bug-err" class="err hide"></div>
      <label>Describe the bug</label>
      <textarea id="bug-text" rows="3" placeholder="Kya hua? Kaise reproduce karein?"></textarea>
      <label>Screenshots (up to 4, optional)</label>
      <input id="bug-photos" type="file" accept="image/*" multiple>
      <button class="primary" id="btn-bug-submit">Submit Report</button>
      <div id="bug-msg" class="hide"></div>
    </div>
    ${isAdmin ? `<h2 class="section-title" style="margin-top:20px;">All Bug Reports</h2><div class="card" id="bug-list"><div class="loading">Loading...</div></div>` : ''}
  </main>
  ${navbar('')}`;

  document.getElementById('btn-bug-submit').onclick = async () => {
    const err = document.getElementById('bug-err');
    err.classList.add('hide');
    const text = document.getElementById('bug-text').value.trim();
    if (!text) { err.textContent = 'Bug description likhein.'; err.classList.remove('hide'); return; }
    
    const files = Array.from(document.getElementById('bug-photos').files).slice(0, 4);
    for (const f of files) {
      const v = validatePhotoFile(f);
      if (v) { err.textContent = v; err.classList.remove('hide'); return; }
    }

    try {
      const photos = [];
      for (const f of files) {
        const b64 = await new Promise((resolve) => processImageToBase64(f, 800, 0.6, resolve));
        photos.push(b64);
      }
      await addDoc(collection(db, "BugReports"), {
        uid: u.uid, username: u.username, text, photos, createdAt: serverTimestamp()
      });
      const msg = document.getElementById('bug-msg');
      msg.textContent = 'Report submitted – Thank you!';
      msg.className = 'note';
      msg.classList.remove('hide');
      document.getElementById('bug-text').value = '';
      document.getElementById('bug-photos').value = '';
    } catch (e) {
      err.textContent = 'Submit failed: ' + e.message;
      err.classList.remove('hide');
    }
  };

  if (isAdmin) loadBugReportsList();
}

async function loadBugReportsList() {
  const box = document.getElementById('bug-list');
  if (!box) return;
  try {
    const snap = await getDocs(collection(db, "BugReports"));
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    if (!items.length) { box.innerHTML = `<p style="font-size:.8rem; color:var(--muted);">Koi bug report nahi hai abhi.</p>`; return; }
    box.innerHTML = items.map(b => `
      <div class="card" id="bug-${b.id}" style="margin-bottom:10px;">
        <b>@${escapeHtml(b.username || 'unknown')}</b>
        <span style="font-size:.68rem; color:var(--muted); float:right;">${b.createdAt?.toDate ? b.createdAt.toDate().toLocaleString() : ''}</span>
        <p style="font-size:.85rem; margin-top:6px; clear:both;">${escapeHtml(b.text)}</p>
        ${(b.photos && b.photos.length) ? `<div class="bug-photo-row">${b.photos.map((p,i) => `<img src="${p}" onclick="openLightbox(this.src)">`).join('')}</div>` : ''}
        <button class="del-btn" onclick="adminDeleteBug('${b.id}')">Delete</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="err">Couldn't load: ${escapeHtml(e.message)}</div>`;
  }
}

window.adminDeleteBug = async (id) => {
  if (!confirm('Delete this bug report?')) return;
  await deleteDoc(doc(db, "BugReports", id));
  document.getElementById('bug-' + id)?.remove();
};

/* ---------------- CHAT ---------------- */
function renderChat(chatRoomId) {
  const u = currentUser;
  const room = String(chatRoomId).toLowerCase();
  const isAdmin = isAdminOrOwner(u);
  if (room === 'admin-room' && !isAdmin) { go('#/home'); return; }

  const myClasses = ((u.classAccess && u.classAccess.length) ? u.classAccess : [u.classLevel || 'Class 9']).map(slugify);
  const isAnonymous = room.includes('anonymous');
  const isGlobal = room === 'global';
  const timeoutExpiry = u.timeoutExpiry?.toDate ? u.timeoutExpiry.toDate() : (u.timeoutExpiry ? new Date(u.timeoutExpiry) : null);
  const isTimedOut = timeoutExpiry && timeoutExpiry.getTime() > Date.now();
  const isRestricted = (u.isBanned || isTimedOut) && !isAdmin;
  
  const canChat = (isGlobal || isAnonymous || myClasses.includes(room) || room === 'admin-room' || isAdmin) && !isRestricted;
  const canDeleteAnyHere = isAdmin; 
  
  pendingPhoto = null;
  markRoomSeen(room);
  cleanupOldMessages(room);

  root.innerHTML = `
  <main style="padding-bottom:80px;">
    <div class="chat-head">
      <span class="back" onclick="go('#/home')">⬅️</span>
      <b>${room.replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase())}</b>
    </div>
    ${!canChat ? `<div class="readonly-banner">⚠️ Read-only: aap yahan message nahi bhej sakte.</div>` : ''}
    <div class="msgs" id="msgs"><div class="loading">Loading messages...</div></div>
  </main>
  <div class="composer-wrap">
    <div id="reply-bar-wrap"></div>
    <div id="photo-preview-wrap"></div>
    <div id="cooldown-note" class="cooldown-note hide"></div>
    ${canChat ? `
      <div class="composer">
        <input id="chat-photo-input" type="file" accept="image/*" class="hide">
        <button id="btn-attach" type="button" title="Attach photo">📷</button>
        <input id="chat-input" placeholder="Type a message... (@username to tag)">
        <button id="btn-send">➤</button>
      </div>` : `<div class="disabled-note">Read-only mode – send disabled.</div>`}
  </div>`;
  
  if (canChat) {
    document.getElementById('btn-send').onclick = () => sendMsg(chatRoomId, isAnonymous);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMsg(chatRoomId, isAnonymous);
    });
    document.getElementById('btn-attach').onclick = () => {
      const remaining = cooldownRemainingMs(room);
      if (remaining > 0) { alert(cooldownText(remaining)); return; }
      document.getElementById('chat-photo-input').click();
    };
    document.getElementById('chat-photo-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const err = validatePhotoFile(file);
      if (err) { alert(err); e.target.value = ''; return; }
      processImageToBase64(file, 900, 0.6, (b64) => {
        pendingPhoto = b64;
        document.getElementById('photo-preview-wrap').innerHTML = `
          <div class="photo-preview-strip">
            <img src="${b64}">
            <span>Photo attached</span>
            <button id="cancel-photo">✖</button>
          </div>`;
        document.getElementById('cancel-photo').onclick = () => {
          pendingPhoto = null;
          document.getElementById('photo-preview-wrap').innerHTML = '';
          document.getElementById('chat-photo-input').value = '';
        };
      });
    });
  }

  const msgsRef = collection(db, "Chats", chatRoomId, "Messages");
  const q = query(msgsRef, orderBy("createdAt", "asc"));
  const notifCategory = isGlobal ? 'global' : (isAnonymous ? 'anonymous' : 'classChat');
  let initialMsgLoadDone = false;

  unsubMessages = onSnapshot(q, (snap) => {
    const wrap = document.getElementById('msgs');
    if (!wrap) return; 

    // Fire browser notifications for genuinely NEW messages from others (skip the initial history load).
    if (initialMsgLoadDone && getNotifPrefs()[notifCategory]) {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          const nm = change.doc.data();
          if (nm.senderId !== u.uid) {
            fireBrowserNotification(
              isAnonymous ? 'Anonymous Ninja' : (nm.senderName || 'New message'),
              nm.photoUrl ? '📷 Sent a photo' : (nm.text || ''),
              'chat-' + room
            );
          }
        }
      });
    }
    initialMsgLoadDone = true;

    wrap.innerHTML = '';
    snap.forEach((d) => {
      const m = d.data();
      const mine = m.senderId === u.uid;
      const canDeleteThis = mine || canDeleteAnyHere; 
      
      let rawText = m.text || '';
      rawText = maskBadWords(rawText); 
      let safeText = escapeHtml(rawText); 
      
      const myUname = u.username.toLowerCase();
      const mentionRegex = new RegExp(`@${myUname}(?![\\w.-])`, 'gi'); 
      const isTagged = !isAnonymous && mentionRegex.test(safeText);
      const isRepliedToMe = !isAnonymous && m.replyTo && m.replyTo.senderName.toLowerCase() === myUname;
      
      if (!isAnonymous) {
        safeText = safeText.replace(/@([a-zA-Z0-9_.-]+)/g, '<span class="mention">@$1</span>');
      }
      
      let extraClass = '';
      if ((isTagged || isRepliedToMe) && !mine) {
        extraClass = ' mentioned-msg'; 
      }
      
      const div = document.createElement('div');
      div.className = 'msg ' + (mine ? 'right' : 'left') + extraClass;
      div.id = 'msg-' + d.id;
      div.innerHTML = `
        <div class="msg-head">
          ${!isAnonymous ? `<img class="msg-avatar" data-profile="${m.senderId}" src="${m.senderPhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />` : ''}
          <span class="sender ${!isAnonymous ? 'clickable' : ''}" ${!isAnonymous ? `data-profile="${m.senderId}"` : ''}>${escapeHtml(m.senderName || 'Student')}</span>
        </div>
        ${m.replyTo ? `<div class="reply-preview" data-jump="${m.replyTo.id || ''}">↩️ <b>${escapeHtml(m.replyTo.senderName||'')}</b>: ${escapeHtml(m.replyTo.text || '').slice(0,40)}</div>` : ''}
        ${m.photoUrl ? `<img class="msg-photo" data-lightbox="${d.id}" src="${m.photoUrl}">` : ''}
        ${safeText ? `<div class="msg-text">${safeText}</div>` : ''}
        <div class="msg-actions">
          <button data-reply="${d.id}">Reply</button>
          ${canDeleteThis ? `<button data-del="${d.id}">Delete${!mine && canDeleteAnyHere ? ' (mod)' : ''}</button>` : ''}
        </div>`;
      wrap.appendChild(div);
      
      div.querySelector('[data-reply]').onclick = () => {
        replyTo = { id: d.id, text: m.text || (m.photoUrl ? '📷 Photo' : ''), senderName: m.senderName };
        document.getElementById('reply-bar-wrap').innerHTML = 
          `<div class="reply-bar"><span>↩️ Replying to <b>${escapeHtml(m.senderName)}</b></span><button id="cancel-reply">✖</button></div>`;
        document.getElementById('cancel-reply').onclick = () => { replyTo = null; document.getElementById('reply-bar-wrap').innerHTML = ''; };
        highlightMessage(d.id);
      };
      
      const delBtn = div.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (confirm('Delete this message?')) await deleteDoc(doc(db, "Chats", chatRoomId, "Messages", d.id));
      };
      
      const jumpEl = div.querySelector('[data-jump]');
      if (jumpEl && m.replyTo?.id) {
        jumpEl.style.cursor = 'pointer';
        jumpEl.onclick = () => highlightMessage(m.replyTo.id);
      }

      const photoEl = div.querySelector('[data-lightbox]');
      if (photoEl) photoEl.onclick = () => openLightbox(m.photoUrl);
      
      if (!isAnonymous) {
        div.querySelectorAll('[data-profile]').forEach(el => {
          el.onclick = () => showProfile(m.senderId);
        });
      }
    });
    wrap.scrollTop = wrap.scrollHeight;
    markRoomSeen(room);
  }, (error) => {
    const wrap = document.getElementById('msgs');
    if (wrap) wrap.innerHTML = `<div class="err">Couldn't load messages: ${error.message}</div>`;
  });
}

function openLightbox(src) {
  let modal = document.getElementById('lightbox-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'lightbox-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<img src="${src}" style="max-width:100%; max-height:85vh; border-radius:10px;">`;
  modal.onclick = () => modal.remove();
}
window.openLightbox = openLightbox;

function highlightMessage(msgId) {
  const el = document.getElementById('msg-' + msgId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1600);
}

/* ---------------- Profile viewer ---------------- */
async function showProfile(uid) {
  let modal = document.getElementById('profile-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal-card"><div class="loading">Loading profile...</div></div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  try {
    const snap = await getDoc(doc(db, "Users", uid));
    if (!snap.exists()) throw new Error('User not found');
    const p = snap.data();
    const age = ageFromDob(p.dob);
    modal.innerHTML = `
      <div class="modal-card">
        <button class="modal-close" id="modal-close-btn">✖</button>
        <img class="avatar-img" style="margin:0 auto 12px;" src="${p.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
        <h2 style="text-align:center;">${escapeHtml(p.fullName || p.username || 'Student')}</h2>
        <p style="text-align:center; color:var(--muted); font-size:.82rem;">@${escapeHtml(p.username || '')}</p>
        <div class="profile-fact-list">
          <div class="fact"><span>School</span><b>${escapeHtml(p.schoolName || 'Not Provided')}</b></div>
          <div class="fact"><span>Class</span><b>${escapeHtml(p.classLevel || 'N/A')}</b></div>
          <div class="fact"><span>Age</span><b>${age !== null ? age + ' yrs' : 'Not shared'}</b></div>
        </div>
        ${renderTagChips(p.tags, currentUser && (currentUser.role === 'Admin' || currentUser.role === 'Owner'))}
        ${p.bio ? `<p class="profile-bio">"${escapeHtml(p.bio)}"</p>` : ''}
      </div>`;
    document.getElementById('modal-close-btn').onclick = () => modal.remove();
  } catch (e) {
    modal.innerHTML = `<div class="modal-card"><button class="modal-close" onclick="document.getElementById('profile-modal').remove()">✖</button><div class="err">Couldn't load profile.</div></div>`;
  }
}
window.showProfile = showProfile;

async function sendMsg(chatRoomId, isAnonymous) {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  const room = String(chatRoomId).toLowerCase();
  if (!text && !pendingPhoto) return;

  const u = currentUser;
  const cooldownBox = document.getElementById('cooldown-note');
  if (pendingPhoto && cooldownRemainingMs(room) > 0) {
    cooldownBox.textContent = cooldownText(cooldownRemainingMs(room));
    cooldownBox.classList.remove('hide');
    return;
  }

  input.value = '';
  const photoToSend = pendingPhoto;
  pendingPhoto = null;
  document.getElementById('photo-preview-wrap').innerHTML = '';
  cooldownBox.classList.add('hide');

  try {
    await addDoc(collection(db, "Chats", chatRoomId, "Messages"), {
      text,
      photoUrl: photoToSend || null,
      senderId: u.uid,
      senderName: isAnonymous ? "Anonymous Ninja" : u.username,
      senderPhoto: isAnonymous ? "https://cdn-icons-png.flaticon.com/512/1752/1752184.png" : (u.profilePhoto || "https://cdn-icons-png.flaticon.com/512/149/149071.png"),
      createdAt: serverTimestamp(),
      replyTo: replyTo
    });
    if (photoToSend) await markCooldown(room);
    replyTo = null;
    document.getElementById('reply-bar-wrap').innerHTML = '';
  } catch (e) {
    alert("Message send nahi hua: " + e.message);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- ADMIN ---------------- */
let adminCustomTags = []; 
let adminEditUid = null;  

async function renderAdmin() {
  const u = currentUser;
  if (u.role !== 'Admin' && u.role !== 'Owner') {
    root.innerHTML = `
    <main>
      <div class="card">
        <b>Access denied.</b>
        <p style="font-size:.82rem; color:var(--muted); margin-top:8px;">
          Aapka account "${escapeHtml(u.role || 'Student')}" role pe hai. Admin panel dekhne ke liye
          role Firestore mein "Admin" ya "Owner" hona chahiye.
        </p>
        <button class="primary" onclick="go('#/home')">Back to Home</button>
      </div>
    </main>`;
    return;
  }

  let totalMembersCount = "...";
  try {
    const snapCount = await getCountFromServer(collection(db, "Users"));
    totalMembersCount = snapCount.data().count;
  } catch (e) { /* ignore */ }
  
  const classChips = ALL_CLASSES.map(c => `<button class="chip-btn" onclick="go('#/chat/${slugify(c)}')">${c}</button>`).join('');
  
  root.innerHTML = `
  <header style="background:#111827;"><h1>🛡️ Admin Panel</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <div class="card" style="margin-bottom:20px; background:var(--profile-grad); text-align:center;">
      <h3 style="font-size:1.1rem; color:var(--ink);">👥 Total Registered Members: <span style="color:var(--blue); font-weight:900;" id="total-users-count">${totalMembersCount}</span></h3>
    </div>

    <h2 class="section-title">👥 All Registered Members</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.85rem; margin-bottom:10px; color:var(--muted);">Click on a name to view profile, click 'Edit' to manage a to z thing.</p>
      <div id="all-users-list" style="max-height: 250px; overflow-y: auto; border:1px solid var(--line); border-radius:8px; padding:10px; background:var(--input-bg);">
        <div class="loading">Loading users...</div>
      </div>
    </div>

    <h2 class="section-title">Jump into any class chat</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Admin/Owner ko sab class rooms mein access hai – inside a room, aap kisi ka bhi message delete kar sakte ho.</p>
      <div class="chip-row">
        <button class="chip-btn" onclick="go('#/chat/global')">Global</button>
        <button class="chip-btn" onclick="go('#/chat/anonymous')">Anonymous</button>
        ${classChips}
      </div>
    </div>

    <h2 class="section-title">📜 Edit Community Rules</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:8px;">Yahan rules edit karein, har line ek naya rule banegi.</p>
      <textarea id="admin-rules-input" rows="6">${escapeHtml(communityRulesText)}</textarea>
      <button class="primary" id="btn-save-rules" style="margin-top:10px;">Save Rules</button>
      <div id="rules-msg" class="hide"></div>
    </div>

    <h2 class="section-title">🤬 Anti-Abuse (Bad Words)</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:12px;">Yahan comma (,) lagakar words add/remove kar sakte ho.</p>
      
      <label>Add Word(s)</label>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
        <input id="new-bad-word" placeholder="e.g. mc, bc, bsdk" style="flex:1;">
        <button class="primary" id="btn-add-bad-word" style="margin-top:0; width:auto; padding:10px 16px; background:var(--green);">Add</button>
      </div>

      <label>Remove Word(s)</label>
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="remove-bad-word" placeholder="e.g. mc, bc" style="flex:1;">
        <button class="primary" id="btn-remove-bad-word" style="margin-top:0; width:auto; padding:10px 16px; background:var(--red);">Remove</button>
      </div>

      <div id="bad-words-list" style="margin-top:16px; display:flex; flex-wrap:wrap; gap:6px; border-top: 1px solid var(--line); padding-top: 12px;"></div>
    </div>

    <h2 class="section-title">Send Notification</h2>
    <div class="card" style="margin-bottom:20px;">
      <label>Title</label>
      <input id="notif-title" placeholder="e.g. Test Postponed">
      <label>Message</label>
      <textarea id="notif-text" rows="2" placeholder="e.g. Tomorrow's test postponed to Friday"></textarea>
      <button class="primary" id="btn-notif">Send to Everyone</button>
      <div id="notif-msg" class="hide"></div>
    </div>

    <h2 class="section-title">💡 Suggestions & 🐛 Bug Reports</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Full list + delete options in-page.</p>
      <div style="display:flex; gap:8px;">
        <button class="primary" style="margin-top:0;" onclick="go('#/suggestions')">Open Suggestion Box</button>
        <button class="primary" style="margin-top:0; background:var(--red);" onclick="go('#/bug-report')">Open Bug Reports</button>
      </div>
    </div>
    
    <h2 class="section-title">Manage Users (edit any profile)</h2>
    <div class="card" style="margin-bottom:20px;">
      <label>Search by username</label>
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <input id="admin-search-user" placeholder="username" style="flex:1;">
        <button class="primary" id="btn-search-user" style="margin-top:12px; width:auto; padding:10px 16px;">Search</button>
      </div>
      <div id="admin-user-editor"></div>
    </div>

    <h2 class="section-title">🏷️ Tags</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:8px;">Class tags aur Admin tags. Custom tags user ko "Manage Users" se assign karo.</p>
      <div id="tag-list" class="tag-row" style="margin-bottom:14px;"></div>
      <label>Create new tag</label>
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="new-tag-label" placeholder="e.g. Sports Captain" style="flex:1;">
        <input id="new-tag-color" type="color" value="#2563eb" style="width:44px; height:38px; padding:2px; border-radius:8px;">
      </div>
      <button class="primary" id="btn-create-tag">Create Tag</button>
      <div id="tag-msg" class="hide"></div>
    </div>

    ${u.role === 'Owner' ? `
    <h2 class="section-title">Grant / Revoke Admin (Owner only)</h2>
    <div class="card" style="margin-bottom:20px;">
      <label>Username</label>
      <input id="grant-user" placeholder="username to promote/demote">
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="primary" id="btn-grant" style="margin-top:0;">Make Admin</button>
        <button class="primary" id="btn-revoke" style="margin-top:0; background:#dc2626;">Remove Admin</button>
      </div>
      <div id="grant-msg" class="hide"></div>
    </div>` : ''}
  </main>`;

  (async () => {
    try {
      const snap = await getDocs(query(collection(db, "Users"), orderBy("createdAt", "desc")));
      const total = snap.size;
      const countEl = document.getElementById('total-users-count');
      if (countEl && totalMembersCount === "...") countEl.textContent = total;
      
      const listEl = document.getElementById('all-users-list');
      if (!listEl) return;
      
      if (snap.empty) {
        listEl.innerHTML = '<div class="note">Koi user nahi mila.</div>';
        return;
      }
      
      listEl.innerHTML = snap.docs.map(d => {
        const p = d.data();
        const dateStr = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString('en-IN') : 'N/A';
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);">
          <div>
            <b style="color:var(--blue); cursor:pointer; text-decoration:underline;" onclick="showProfile('${p.uid}')">${escapeHtml(p.fullName || 'Student')}</b>
            <div style="font-size:.72rem; color:var(--muted); margin-top:2px;">@${escapeHtml(p.username)} • Joined: ${dateStr}</div>
          </div>
          <button class="primary" style="width:auto; padding:6px 12px; margin-top:0; font-size:.75rem;" onclick="adminEditUserDirect('${escapeHtml(p.username)}')">Edit</button>
        </div>`;
      }).join('');
    } catch (e) {
      const listEl = document.getElementById('all-users-list');
      if (listEl) listEl.innerHTML = `<div class="err">Failed to load users: ${e.message}</div>`;
    }
  })();
  
  window.adminEditUserDirect = (uname) => {
    document.getElementById('admin-search-user').value = uname;
    adminSearchUser();
    document.getElementById('admin-search-user').scrollIntoView({behavior: 'smooth', block: 'center'});
  };

  document.getElementById('btn-save-rules').onclick = async () => {
    const rules = document.getElementById('admin-rules-input').value.trim();
    const rMsg = document.getElementById('rules-msg');
    rMsg.classList.remove('hide');
    try {
      await setDoc(doc(db, "Settings", "CommunityRules"), { rules }, { merge: true });
      communityRulesText = rules;
      rMsg.textContent = "Rules updated successfully ✅";
      rMsg.className = "note";
    } catch (e) {
      rMsg.textContent = "Failed: " + e.message;
      rMsg.className = "err";
    }
  };

  window.loadAdminBadWords = () => {
    const box = document.getElementById('bad-words-list');
    if (!box) return;
    if (bannedWordsList.length === 0) {
      box.innerHTML = '<span style="font-size:.78rem; color:var(--muted);">Koi word banned nahi hai.</span>';
      return;
    }
    box.innerHTML = bannedWordsList.map(w => `
      <span class="tag-chip" style="background:#fee2e2; color:#991b1b; border:1px solid #f87171; display:flex; align-items:center; word-break: break-all;">
        ${escapeHtml(w)}
      </span>
    `).join('');
  };
  loadAdminBadWords(); 

  document.getElementById('btn-add-bad-word').onclick = async () => {
    const inputVal = document.getElementById('new-bad-word').value.trim().toLowerCase();
    if (!inputVal) return;
    const wordsToAdd = inputVal.split(',').map(s => s.trim()).filter(s => s);
    const newList = [...new Set([...bannedWordsList, ...wordsToAdd])];
    await setDoc(doc(db, "Settings", "AntiAbuse"), { words: newList }, { merge: true });
    document.getElementById('new-bad-word').value = '';
  };

  document.getElementById('btn-remove-bad-word').onclick = async () => {
    const inputVal = document.getElementById('remove-bad-word').value.trim().toLowerCase();
    if (!inputVal) return;
    const wordsToRemove = inputVal.split(',').map(s => s.trim()).filter(s => s);
    const newList = bannedWordsList.filter(word => !wordsToRemove.includes(word));
    await setDoc(doc(db, "Settings", "AntiAbuse"), { words: newList }, { merge: true });
    document.getElementById('remove-bad-word').value = '';
    alert(`Words list se hat gaye hain ✅`);
  };

  document.getElementById('btn-notif').onclick = async () => {
    const title = document.getElementById('notif-title').value.trim();
    const text = document.getElementById('notif-text').value.trim();
    const msg = document.getElementById('notif-msg');
    if (!text) return;
    try {
      await addDoc(collection(db, "Notifications"), {
        toUid: 'all', title: title || 'Announcement', body: text, createdAt: serverTimestamp(), sentBy: u.username
      });
      msg.textContent = "Sent ✅";
      msg.className = 'note';
      document.getElementById('notif-title').value = '';
      document.getElementById('notif-text').value = '';
    } catch (e) {
      msg.textContent = "Failed: " + e.message;
      msg.className = 'err';
    }
    msg.classList.remove('hide');
  };

  document.getElementById('btn-search-user').onclick = () => adminSearchUser();
  document.getElementById('admin-search-user').addEventListener('keypress', (e) => { if (e.key === 'Enter') adminSearchUser(); });

  loadAdminTags();
  document.getElementById('btn-create-tag').onclick = async () => {
    const label = document.getElementById('new-tag-label').value.trim();
    const color = document.getElementById('new-tag-color').value;
    const tmsg = document.getElementById('tag-msg');
    tmsg.classList.remove('hide');
    if (!label) { tmsg.textContent = 'Tag label likho.'; tmsg.className = 'err'; return; }
    try {
      const id = 'custom-' + slugify(label);
      await setDoc(doc(db, "Tags", id), { id, label, color, type: 'custom' });
      document.getElementById('new-tag-label').value = '';
      tmsg.textContent = 'Tag created ✅';
      tmsg.className = 'note';
      loadAdminTags();
    } catch (e) {
      tmsg.textContent = 'Failed: ' + e.message;
      tmsg.className = 'err';
    }
  };

  if (u.role === 'Owner') {
    const setRole = async (newRole) => {
      const uname = document.getElementById('grant-user').value.trim().toLowerCase();
      const msg = document.getElementById('grant-msg');
      msg.classList.remove('hide');
      if (!uname) { msg.textContent = 'Username likho.'; msg.className = 'err'; return; }
      try {
        const snap = await getDocs(query(collection(db, "Users"), where("username", "==", uname)));
        if (snap.empty) { msg.textContent = 'User nahi mila.'; msg.className = 'err'; return; }
        const targetDoc = snap.docs[0];
        await updateDoc(doc(db, "Users", targetDoc.id), { role: newRole });
        msg.textContent = `@${uname} ab ${newRole} hai ✅`;
        msg.className = 'note';
      } catch (e) {
        msg.textContent = 'Failed: ' + e.message;
        msg.className = 'err';
      }
    };
    document.getElementById('btn-grant').onclick = () => setRole('Admin');
    document.getElementById('btn-revoke').onclick = () => setRole('Student');
  }
}

/* --- Tag list rendering --- */
async function loadAdminTags() {
  const box = document.getElementById('tag-list');
  if (!box) return;
  const predefined = [
    { label: 'Class 1-12 / Pass (all share this color)', color: TAG_COLORS.class },
    { label: 'Admin (admin-only visible)', color: TAG_COLORS.admin },
    { label: 'Student', color: TAG_COLORS.student },
  ];
  try {
    const snap = await getDocs(collection(db, "Tags"));
    adminCustomTags = [];
    snap.forEach(d => adminCustomTags.push(d.data()));
  } catch (e) { /* ignore */ }
  const chip = (t) => `<span class="tag-chip" style="background:${t.color}22; color:${t.color}; border:1px solid ${t.color}66;">${escapeHtml(t.label)}</span>`;
  box.innerHTML = predefined.map(chip).join('') + adminCustomTags.map(chip).join('');
}

/* --- Manage users: search + edit --- */
async function adminSearchUser() {
  const uname = document.getElementById('admin-search-user').value.trim().toLowerCase();
  const box = document.getElementById('admin-user-editor');
  if (!uname) return;
  box.innerHTML = `<div class="loading">Searching...</div>`;
  try {
    const snap = await getDocs(query(collection(db, "Users"), where("username", "==", uname)));
    if (snap.empty) { box.innerHTML = `<div class="err">User nahi mila.</div>`; return; }
    const d = snap.docs[0];
    const p = d.data();
    adminEditUid = d.id;
    const currentTags = (p.tags || []).map(t => t.id);
    const classAccess = p.classAccess || [p.classLevel || 'Class 9'];
    
    box.innerHTML = `
      <div style="margin-top:14px; border-top:1px solid var(--line); padding-top:14px;">
        <label>Full Name</label><input id="e-name" value="${escapeHtml(p.fullName || '')}">
        <label>School Name</label><input id="e-school" value="${escapeHtml(p.schoolName || '')}">
        <label>Bio</label><textarea id="e-bio" rows="2">${escapeHtml(p.bio || '')}</textarea>
        
        <label>Class chat access (multiple)</label>
        <div class="multi-select">
          ${ALL_CLASSES.map(c => `<label class="check-row"><input type="checkbox" value="${escapeHtml(c)}" ${classAccess.includes(c) ? 'checked' : ''}> ${escapeHtml(c)}</label>`).join('')}
        </div>
        
        <label>Custom tags</label>
        <div class="multi-select" id="e-customtags">
          ${adminCustomTags.length ? adminCustomTags.map(t => `<label class="check-row"><input type="checkbox" value="${escapeHtml(t.id)}" ${currentTags.includes(t.id) ? 'checked' : ''}> ${escapeHtml(t.label)}</label>`).join('') : '<span style="font-size:.78rem; color:var(--muted);">Koi custom tag nahi bana abhi tak.</span>'}
        </div>
        
        <label>Admin/Owner role</label>
        <select id="e-role">
          <option value="Student" ${p.role === 'Student' || !p.role ? 'selected' : ''}>Student</option>
          <option value="Admin" ${p.role === 'Admin' ? 'selected' : ''}>Admin</option>
          <option value="Owner" ${p.role === 'Owner' ? 'selected' : ''}>Owner</option>
        </select>
        
        <button class="primary" id="btn-save-user">Save Changes</button>
        <div id="e-msg" class="hide"></div>
      </div>`;
    document.getElementById('btn-save-user').onclick = () => adminSaveUser(p);
  } catch (e) {
    box.innerHTML = `<div class="err">Search failed: ${escapeHtml(e.message)}</div>`;
  }
}
window.adminSearchUser = adminSearchUser;

async function adminSaveUser(existing) {
  const msg = document.getElementById('e-msg');
  msg.classList.remove('hide');
  try {
    const fullName = document.getElementById('e-name').value.trim();
    const schoolName = document.getElementById('e-school').value.trim();
    const bio = document.getElementById('e-bio').value.trim();
    const role = document.getElementById('e-role').value;
    
    const classAccess = Array.from(document.querySelectorAll('#admin-user-editor .multi-select input:checked'))
      .map(i => i.value)
      .filter(v => ALL_CLASSES.includes(v));
      
    const customTagIds = Array.from(document.querySelectorAll('#e-customtags input:checked')).map(i => i.value);
    
    const tags = classAccess.map(c => makeTag(c, 'class'));
    tags.push(makeTag('Student', 'student')); 
    if (role === 'Admin' || role === 'Owner') tags.push(makeTag(role, 'admin'));
    
    customTagIds.forEach(id => {
      const t = adminCustomTags.find(ct => ct.id === id);
      if (t) tags.push(t);
    });
    
    const updates = {
      fullName, schoolName, bio, role,
      classAccess: classAccess.length ? classAccess : [existing.classLevel || 'Class 9'],
      tags
    };
    
    await updateDoc(doc(db, "Users", adminEditUid), updates);
    msg.textContent = 'Saved ✅';
    msg.className = 'note';
  } catch (e) {
    msg.textContent = 'Save failed: ' + e.message;
    msg.className = 'err';
  }
}
window.adminSaveUser = adminSaveUser;

/* ---------------- 404 ---------------- */
function renderNotFound() {
  root.innerHTML = `
  <main>
    <div class="card" style="text-align:center;">
      <div style="font-size:2.4rem;">🚫</div>
      <h2 class="section-title" style="margin-top:10px;">Page Not Found</h2>
      <p style="color:var(--muted); font-size:.85rem; margin-bottom:14px;">Yeh room exist nahi karta ya aapke paas permission nahi hai.</p>
      <button class="primary" onclick="go('#/home')">Go Home</button>
    </div>
  </main>`;
}
