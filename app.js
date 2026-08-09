import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, addDoc, deleteDoc, query, orderBy, onSnapshot, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const root = document.getElementById('app');
let currentUser = null;      // Firestore user doc (+ uid)
let unsubMessages = null;    // active chat listener, torn down on nav
let replyTo = null;

/* ---------------- Tags, classes, subjects ---------------- */
const ALL_CLASSES = Array.from({length:12},(_,i)=>`Class ${i+1}`).concat(['12th Pass / College']);
const SUBJECTS = ['Mathematics','Physics','Chemistry','Biology','English','Hindi','Social Science','History','Geography','Political Science','Economics','Computer Science','Accountancy','Business Studies','Physical Education','Sanskrit','Environmental Science','Statistics','Psychology','Sociology','Fine Arts'];
const TAG_COLORS = { class:'#6366f1', teacher:'#16a34a', principal:'#d97706', admin:'#dc2626', student:'#6b7280' };
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

/* ---------------- Slugify class names for URLs ---------------- */
function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alphanumeric -> single dash
    .replace(/^-+|-+$/g, '');      // trim leading/trailing dashes
}

/* ---------------- Age from DOB ---------------- */
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

/* ---------------- Hash Router ----------------
   Every "page" is just #/something — because the server ONLY ever
   needs to serve index.html once, hash changes never hit the server,
   so there is NOTHING to configure on GitHub Pages / Netlify / Vercel.
   This structurally cannot 404 on refresh.
------------------------------------------------ */
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
    } else {
      currentUser = null;
    }
    route();
  });
});

function go(hash) { window.location.hash = hash; }
window.go = go; // used by inline onclick in templates

function currentPath() {
  return (window.location.hash || '#/login').slice(1); // "/login", "/chat/global"
}

function route() {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  const path = currentPath();
  const chatMatch = path.match(/^\/chat\/([a-z0-9-]+)$/i);

  // Auth gate: protected pages redirect to /login if not signed in
  const protectedPages = ['/home', '/start', '/rules', '/admin', '/notifications', '/apply-teacher'];
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
  if (path === '/apply-teacher') return renderApplyTeacher();
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
  <header><h1>🎓 Create Account</h1></header>
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

    // DP (profile photo) is the only optional field — everything else is required.
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
          schoolIdUrl: "",
          bio: "",
          role: "Student",
          tags: [makeTag(classLevel || "Class 9", 'class'), makeTag('Student', 'student')],
          classAccess: [classLevel || "Class 9"],
          isTeacher: false,
          teacherClasses: [],
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
  const classAccess = (u.classAccess && u.classAccess.length) ? u.classAccess : [u.classLevel || 'Class 9'];
  const classOpts = [...new Set(classAccess)].map(c => `
      <div class="opt" onclick="go('#/chat/${slugify(c)}')">
        <div class="ic" style="background:#dcfce7;">🏫</div>
        <div class="tx"><b>${escapeHtml(c)} Room</b><span>${u.isTeacher && (u.teacherClasses||[]).includes(c) ? 'Teaching access — aap yahan delete bhi kar sakte ho' : 'Sirf is class ke students'}</span></div>
      </div>`).join('');

  root.innerHTML = `
  <header>
    <h1>🎓 StudentChat</h1>
    <div style="display:flex; align-items:center; gap:8px;">
      <button id="btn-bell" style="position:relative; background:none; border:none; color:#fff; font-size:1.15rem; cursor:pointer;">
        🔔<span id="notif-badge" class="notif-badge hide">0</span>
      </button>
      <span class="pill">@${escapeHtml(u.username)}</span>
    </div>
  </header>
  <main>
    <div class="profile-card">
      <img class="avatar-img" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <h2>${escapeHtml(u.fullName || u.username)}</h2>
      <p>${escapeHtml(u.schoolName || 'Not Provided')}</p>
      ${renderTagChips(u.tags, u.role === 'Admin' || u.role === 'Owner')}
    </div>
    <div class="options">
      <div class="opt" onclick="go('#/chat/global')">
        <div class="ic" style="background:#dbeafe;">🌍</div>
        <div class="tx"><b>Global Chat</b><span>Sab verified students ke saath</span></div>
      </div>
      <div class="opt" onclick="go('#/chat/anonymous')">
        <div class="ic" style="background:#ede9fe;">🥷</div>
        <div class="tx"><b>Anonymous Chat</b><span>Naam/DP hidden rehta hai</span></div>
      </div>
      ${classOpts}
      <div class="opt" onclick="go('#/rules')">
        <div class="ic" style="background:#fef3c7;">📜</div>
        <div class="tx"><b>Community Rules</b><span>Chat guidelines padhein</span></div>
      </div>
      <div class="opt" onclick="go('#/start')">
        <div class="ic" style="background:#f3e8ff;">✏️</div>
        <div class="tx"><b>Edit Profile</b><span>DP aur bio update karein</span></div>
      </div>
      <div class="opt" id="opt-apply-teacher" onclick="go('#/apply-teacher')">
        <div class="ic" style="background:#fee2e2;">🍎</div>
        <div class="tx"><b id="apply-teacher-label">Apply for Teacher</b><span id="apply-teacher-sub">School Teacher ID ke saath apply karein</span></div>
      </div>
    </div>
  </main>
  ${navbar('home')}`;

  document.getElementById('btn-bell').onclick = () => go('#/notifications');

  // Unread notification badge
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

  // Teacher application status (hide/relabel the Apply button if already teacher or pending)
  (async () => {
    const opt = document.getElementById('opt-apply-teacher');
    if (!opt) return;
    if (u.isTeacher) { opt.classList.add('hide'); return; }
    try {
      const snap = await getDocs(query(collection(db, "TeacherApplications"), where("uid", "==", u.uid), where("status", "==", "pending")));
      if (!snap.empty) {
        opt.onclick = null;
        document.getElementById('apply-teacher-label').textContent = 'Teacher Application Pending';
        document.getElementById('apply-teacher-sub').textContent = 'Admin approval ka wait karein';
        opt.style.opacity = '.7';
        opt.style.cursor = 'default';
      }
    } catch (e) { /* ignore */ }
  })();
}

/* ---------------- EDIT PROFILE (Start) ---------------- */
function renderStart() {
  const u = currentUser;
  root.innerHTML = `
  <header><h1>✏️ Edit Profile</h1></header>
  <main>
    <div class="card">
      <img class="avatar-img" style="margin:0 auto 14px;" src="${u.profilePhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />
      <label>Profile Photo</label><input id="s-photo" type="file" accept="image/*">
      <label>Bio</label><textarea id="s-bio" rows="3">${u.bio || ''}</textarea>
      <div id="s-msg" class="hide"></div>
      <button class="primary" id="btn-save">Save Changes</button>
      <p class="switch-link"><a onclick="go('#/home')">← Back to Home</a></p>
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
  </main>
  ${navbar('start')}`;

  const active = localStorage.getItem('studentchat-theme') || 'light';
  ['light', 'dark', 'sepia', 'ocean'].forEach(t => {
    const btn = document.getElementById(`theme-${t}`);
    btn.classList.toggle('active', active === t);
    btn.onclick = () => { setTheme(t); renderStart(); };
  });

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
  <main><div class="loading">Loading…</div></main>
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
        <span style="font-size:.68rem; color:var(--muted);">${n.sentBy ? 'From @' + escapeHtml(n.sentBy) : ''} ${n.toUid !== 'all' ? '· Personal' : '· Announcement'}</span>
      </div>`).join('');
  } catch (e) {
    root.querySelector('main').innerHTML = `<div class="err">Couldn't load notifications: ${escapeHtml(e.message)}</div>`;
  }
}
function renderRules() {
  root.innerHTML = `
  <header><h1>📜 Community Rules</h1></header>
  <main>
    <div class="card">
      <ol class="rules-list">
        <li>Kisi ke saath gaali-galoch ya bullying allowed nahi hai.</li>
        <li>Personal details (address, phone number) share na karein.</li>
        <li>Sirf apni class ke room mein message bhej sakte ho; doosri class ke rooms read-only hain.</li>
        <li>Spam ya baar-baar same message bhejna ban ka reason ban sakta hai.</li>
        <li>Admin/Owner ke decisions final hain.</li>
      </ol>
      <button class="primary" onclick="go('#/home')">Got it, back to Home</button>
    </div>
  </main>
  ${navbar('rules')}`;
}

/* ---------------- APPLY FOR TEACHER ---------------- */
function renderApplyTeacher() {
  const u = currentUser;
  root.innerHTML = `
  <header><h1>🍎 Apply for Teacher</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <div class="card">
      <div id="err" class="err hide"></div>
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:6px;">Sab fields compulsory hain (ID card ke ilava).</p>

      <label>Name</label>
      <input id="t-name" value="${escapeHtml(u.fullName || '')}">

      <label>Class (select all you want to teach)</label>
      <div class="multi-select" id="t-classes">
        ${ALL_CLASSES.map(c => `<label class="check-row"><input type="checkbox" value="${escapeHtml(c)}"> ${escapeHtml(c)}</label>`).join('')}
      </div>

      <label>Subject (search & select multiple)</label>
      <input id="t-subject-search" placeholder="Search subject...">
      <div class="multi-select" id="t-subjects">
        ${SUBJECTS.map(s => `<label class="check-row" data-subject-row><input type="checkbox" value="${escapeHtml(s)}"> ${escapeHtml(s)}</label>`).join('')}
      </div>

      <label>School Name</label>
      <input id="t-school" placeholder="DAV Public School">

      <label>School Teacher ID Card (photo)</label>
      <input id="t-idcard" type="file" accept="image/*">

      <button class="primary" id="btn-apply-teacher">Submit Application</button>
    </div>
  </main>
  ${navbar('')}`;

  document.getElementById('t-subject-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#t-subjects [data-subject-row]').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  document.getElementById('btn-apply-teacher').onclick = () => {
    const err = document.getElementById('err');
    err.classList.add('hide');
    const name = document.getElementById('t-name').value.trim();
    const school = document.getElementById('t-school').value.trim();
    const classes = Array.from(document.querySelectorAll('#t-classes input:checked')).map(i => i.value);
    const subjects = Array.from(document.querySelectorAll('#t-subjects input:checked')).map(i => i.value);
    const file = document.getElementById('t-idcard').files[0];

    const fail = (m) => { alert('Please fill: ' + m); err.textContent = m + ' is required.'; err.classList.remove('hide'); };
    if (!name) return fail('Name');
    if (!classes.length) return fail('Class (at least one)');
    if (!subjects.length) return fail('Subject (at least one)');
    if (!school) return fail('School Name');
    if (!file) return fail('School Teacher ID Card');

    processImageToBase64(file, 600, 0.6, async (idCardBase64) => {
      try {
        await addDoc(collection(db, "TeacherApplications"), {
          uid: u.uid, username: u.username, name, classes, subjects, schoolName: school,
          idCardPhoto: idCardBase64, status: 'pending', createdAt: serverTimestamp()
        });
        alert('Application submitted! Admin approval ka wait karein.');
        go('#/home');
      } catch (e) {
        err.textContent = 'Submit failed: ' + e.message;
        err.classList.remove('hide');
      }
    });
  };
}

/* ---------------- CHAT ---------------- */
function renderChat(chatRoomId) {
  const u = currentUser;
  const room = String(chatRoomId).toLowerCase();
  const myClasses = ((u.classAccess && u.classAccess.length) ? u.classAccess : [u.classLevel || 'Class 9']).map(slugify);
  const isAnonymous = room.includes('anonymous');
  const isGlobal = room === 'global';
  const isAdmin = u.role === 'Admin' || u.role === 'Owner';
  const myTeacherClasses = (u.teacherClasses || []).map(slugify);
  const isTeacherHere = u.isTeacher && myTeacherClasses.includes(room);
  const timeoutExpiry = u.timeoutExpiry?.toDate ? u.timeoutExpiry.toDate() : (u.timeoutExpiry ? new Date(u.timeoutExpiry) : null);
  const isTimedOut = timeoutExpiry && timeoutExpiry.getTime() > Date.now();
  const isRestricted = (u.isBanned || isTimedOut) && !isAdmin;
  const canChat = (isGlobal || isAnonymous || myClasses.includes(room) || isAdmin) && !isRestricted;
  const canDeleteAnyHere = isAdmin || isTeacherHere; // teachers can moderate their assigned class rooms too

  root.innerHTML = `
  <main style="padding-bottom:80px;">
    <div class="chat-head">
      <span class="back" onclick="go('#/home')">←</span>
      <b>${room.replace(/-/g,' ').replace(/\b\w/g, c=>c.toUpperCase())}</b>
    </div>
    ${!canChat ? `<div class="readonly-banner">🔒 Read-only: aap yahan message nahi bhej sakte.</div>` : ''}
    <div class="msgs" id="msgs"><div class="loading">Loading messages…</div></div>
  </main>
  <div class="composer-wrap">
    <div id="reply-bar-wrap"></div>
    ${canChat ? `
      <div class="composer">
        <input id="chat-input" placeholder="Type a message...">
        <button id="btn-send">➤</button>
      </div>` : `<div class="disabled-note">Read-only mode — send disabled.</div>`}
  </div>`;

  if (canChat) {
    document.getElementById('btn-send').onclick = () => sendMsg(chatRoomId, isAnonymous);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMsg(chatRoomId, isAnonymous);
    });
  }

  const msgsRef = collection(db, "Chats", chatRoomId, "Messages");
  const q = query(msgsRef, orderBy("createdAt", "asc"));
  unsubMessages = onSnapshot(q, (snap) => {
    const wrap = document.getElementById('msgs');
    if (!wrap) return; // navigated away
    wrap.innerHTML = '';
    snap.forEach((d) => {
      const m = d.data();
      const mine = m.senderId === u.uid;
      const canDeleteThis = mine || canDeleteAnyHere; // admin/teacher-in-their-class can delete ANY message here
      const div = document.createElement('div');
      div.className = 'msg ' + (mine ? 'right' : 'left');
      div.id = 'msg-' + d.id;
      div.innerHTML = `
        <div class="msg-head">
          ${!isAnonymous ? `<img class="msg-avatar" data-profile="${m.senderId}" src="${m.senderPhoto || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}" />` : ''}
          <span class="sender ${!isAnonymous ? 'clickable' : ''}" ${!isAnonymous ? `data-profile="${m.senderId}"` : ''}>${escapeHtml(m.senderName || 'Student')}</span>
        </div>
        ${m.replyTo ? `<div class="reply-preview" data-jump="${m.replyTo.id || ''}">↩ <b>${escapeHtml(m.replyTo.senderName||'')}</b>: ${escapeHtml(m.replyTo.text || '').slice(0,40)}</div>` : ''}
        <div class="msg-text">${escapeHtml(m.text || '')}</div>
        <div class="msg-actions">
          <button data-reply="${d.id}">Reply</button>
          ${canDeleteThis ? `<button data-del="${d.id}">Delete${!mine && canDeleteAnyHere ? ' (mod)' : ''}</button>` : ''}
        </div>`;
      wrap.appendChild(div);

      // Reply: remember original message id too, so we can jump+highlight it later
      div.querySelector('[data-reply]').onclick = () => {
        replyTo = { id: d.id, text: m.text, senderName: m.senderName };
        document.getElementById('reply-bar-wrap').innerHTML =
          `<div class="reply-bar"><span>↩ Replying to <b>${escapeHtml(m.senderName)}</b></span><button id="cancel-reply">✕</button></div>`;
        document.getElementById('cancel-reply').onclick = () => { replyTo = null; document.getElementById('reply-bar-wrap').innerHTML = ''; };
        // Highlight the message being replied to, for both people in the thread
        highlightMessage(d.id);
      };

      const delBtn = div.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (confirm('Delete this message?')) await deleteDoc(doc(db, "Chats", chatRoomId, "Messages", d.id));
      };

      // Click the reply-preview quote to jump to + highlight the original message
      const jumpEl = div.querySelector('[data-jump]');
      if (jumpEl && m.replyTo?.id) {
        jumpEl.style.cursor = 'pointer';
        jumpEl.onclick = () => highlightMessage(m.replyTo.id);
      }

      // Click avatar/name to view that person's profile (disabled in Anonymous rooms)
      if (!isAnonymous) {
        div.querySelectorAll('[data-profile]').forEach(el => {
          el.onclick = () => showProfile(m.senderId);
        });
      }
    });
    wrap.scrollTop = wrap.scrollHeight;
  }, (error) => {
    const wrap = document.getElementById('msgs');
    if (wrap) wrap.innerHTML = `<div class="err">Couldn't load messages: ${error.message}</div>`;
  });
}

function highlightMessage(msgId) {
  const el = document.getElementById('msg-' + msgId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1600);
}

/* ---------------- Profile viewer (click DP/name in chat) ---------------- */
async function showProfile(uid) {
  let modal = document.getElementById('profile-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal-card"><div class="loading">Loading profile…</div></div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  try {
    const snap = await getDoc(doc(db, "Users", uid));
    if (!snap.exists()) throw new Error('User not found');
    const p = snap.data();
    const age = ageFromDob(p.dob);
    modal.innerHTML = `
      <div class="modal-card">
        <button class="modal-close" id="modal-close-btn">✕</button>
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
    modal.innerHTML = `<div class="modal-card"><button class="modal-close" onclick="document.getElementById('profile-modal').remove()">✕</button><div class="err">Couldn't load profile.</div></div>`;
  }
}
window.showProfile = showProfile;

async function sendMsg(chatRoomId, isAnonymous) {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const u = currentUser;
  try {
    await addDoc(collection(db, "Chats", chatRoomId, "Messages"), {
      text,
      senderId: u.uid,
      senderName: isAnonymous ? "Anonymous Ninja" : u.username,
      senderPhoto: isAnonymous ? "https://cdn-icons-png.flaticon.com/512/1752/1752184.png" : (u.profilePhoto || "https://cdn-icons-png.flaticon.com/512/149/149071.png"),
      createdAt: serverTimestamp(),
      replyTo: replyTo
    });
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
let adminCustomTags = []; // cached custom tags loaded when admin panel opens
let adminEditUid = null;  // uid currently loaded in the user editor

function renderAdmin() {
  const u = currentUser;
  if (u.role !== 'Admin' && u.role !== 'Owner') {
    root.innerHTML = `
    <main>
      <div class="card">
        <b>Access denied.</b>
        <p style="font-size:.82rem; color:var(--muted); margin-top:8px;">
          Aapka account "${escapeHtml(u.role || 'Student')}" role pe hai. Admin panel dekhne ke liye
          role Firestore mein "Admin" ya "Owner" hona chahiye — koi bhi apne aap ko admin nahi bana sakta
          (security ke liye). Pehli baar kisi ko Owner banane ke liye Firebase Console → Firestore →
          <code>Users/${u.uid}</code> document kholo aur field <code>role</code> ko manually
          <code>"Owner"</code> set karo. Uske baad woh Owner is Admin panel se doosron ko Admin bana sakta hai.
        </p>
        <button class="primary" onclick="go('#/home')">Back to Home</button>
      </div>
    </main>`;
    return;
  }

  const classChips = ALL_CLASSES.map(c => `<button class="chip-btn" onclick="go('#/chat/${slugify(c)}')">${c}</button>`).join('');

  root.innerHTML = `
  <header style="background:#111827;"><h1>👑 Admin Panel</h1><span class="pill" onclick="go('#/home')" style="cursor:pointer;">Home</span></header>
  <main>
    <h2 class="section-title">Jump into any class chat</h2>
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:10px;">Admin/Owner ko sab class rooms mein access hai — inside a room, aap kisi ka bhi message delete kar sakte ho.</p>
      <div class="chip-row">
        <button class="chip-btn" onclick="go('#/chat/global')">Global</button>
        <button class="chip-btn" onclick="go('#/chat/anonymous')">Anonymous</button>
        ${classChips}
      </div>
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

    <h2 class="section-title">🍎 Teacher Applications</h2>
    <div class="card" style="margin-bottom:20px;" id="teacher-apps-list">
      <div class="loading">Loading…</div>
    </div>

    <h2 class="section-title">Manage Users — edit any profile</h2>
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
      <p style="font-size:.78rem; color:var(--muted); margin-bottom:8px;">Class tags (Class 1–12 / Pass) sab ek hi color share karte hain. Teacher/Principal/Admin/Student aur custom tags sab ke apne-apne colors hain. Custom tags user ko "Manage Users" se assign karo.</p>
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

    <p class="switch-link">Ban/timeout tools abhi is static version mein nahi hain — bolo toh add kar dunga.</p>
  </main>`;

  /* --- Send notification --- */
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

  /* --- Teacher applications --- */
  loadTeacherApplications();

  /* --- Manage users --- */
  document.getElementById('btn-search-user').onclick = () => adminSearchUser();
  document.getElementById('admin-search-user').addEventListener('keypress', (e) => { if (e.key === 'Enter') adminSearchUser(); });

  /* --- Tags --- */
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
    { label: 'Class 1–12 / Pass (all share this color)', color: TAG_COLORS.class },
    { label: 'Teacher', color: TAG_COLORS.teacher },
    { label: 'Principal', color: TAG_COLORS.principal },
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
  box.innerHTML = `<div class="loading">Searching…</div>`;
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

        <label>Role tag</label>
        <select id="e-roletag">
          <option value="student" ${!currentTags.includes('teacher-teacher') && !currentTags.includes('principal-principal') ? 'selected' : ''}>Student</option>
          <option value="teacher" ${currentTags.includes('teacher-teacher') ? 'selected' : ''}>Teacher</option>
          <option value="principal" ${currentTags.includes('principal-principal') ? 'selected' : ''}>Principal</option>
        </select>

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
    const roleTag = document.getElementById('e-roletag').value; // student | teacher | principal
    const classAccess = Array.from(document.querySelectorAll('#admin-user-editor .multi-select input:checked'))
      .map(i => i.value)
      .filter(v => ALL_CLASSES.includes(v));
    const customTagIds = Array.from(document.querySelectorAll('#e-customtags input:checked')).map(i => i.value);

    const tags = classAccess.map(c => makeTag(c, 'class'));
    tags.push(roleTag === 'teacher' ? makeTag('Teacher', 'teacher') : roleTag === 'principal' ? makeTag('Principal', 'principal') : makeTag('Student', 'student'));
    if (role === 'Admin' || role === 'Owner') tags.push(makeTag(role, 'admin'));
    customTagIds.forEach(id => {
      const t = adminCustomTags.find(ct => ct.id === id);
      if (t) tags.push(t);
    });

    const updates = {
      fullName, schoolName, bio, role,
      classAccess: classAccess.length ? classAccess : [existing.classLevel || 'Class 9'],
      tags,
      isTeacher: roleTag === 'teacher',
    };
    if (roleTag === 'teacher') {
      updates.teacherClasses = classAccess.length ? classAccess : (existing.teacherClasses || []);
    }

    await updateDoc(doc(db, "Users", adminEditUid), updates);
    msg.textContent = 'Saved ✅';
    msg.className = 'note';
  } catch (e) {
    msg.textContent = 'Save failed: ' + e.message;
    msg.className = 'err';
  }
}
window.adminSaveUser = adminSaveUser;

/* --- Teacher applications: list + approve/reject --- */
async function loadTeacherApplications() {
  const box = document.getElementById('teacher-apps-list');
  if (!box) return;
  try {
    const snap = await getDocs(query(collection(db, "TeacherApplications"), where("status", "==", "pending")));
    if (snap.empty) {
      box.innerHTML = `<p style="font-size:.82rem; color:var(--muted);">Koi pending application nahi hai.</p>`;
      return;
    }
    box.innerHTML = snap.docs.map(d => {
      const a = d.data();
      return `
      <div class="app-item" id="app-${d.id}" style="border-bottom:1px solid var(--line); padding:10px 0;">
        <b>${escapeHtml(a.name)}</b> <span style="font-size:.75rem; color:var(--muted);">@${escapeHtml(a.username || '')}</span>
        <p style="font-size:.78rem; margin-top:4px;">School: ${escapeHtml(a.schoolName)}</p>
        <p style="font-size:.78rem;">Classes: ${a.classes.map(escapeHtml).join(', ')}</p>
        <p style="font-size:.78rem;">Subjects: ${a.subjects.map(escapeHtml).join(', ')}</p>
        ${a.idCardPhoto ? `<img src="${a.idCardPhoto}" style="width:100%; max-width:220px; border-radius:8px; margin-top:6px; border:1px solid var(--line);">` : ''}
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="primary" style="margin-top:0; background:var(--green);" onclick="adminApproveTeacher('${d.id}')">Approve</button>
          <button class="primary" style="margin-top:0; background:var(--red);" onclick="adminRejectTeacher('${d.id}')">Reject</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="err">Couldn't load applications: ${escapeHtml(e.message)}</div>`;
  }
}

async function adminApproveTeacher(appId) {
  const u = currentUser;
  try {
    const appSnap = await getDoc(doc(db, "TeacherApplications", appId));
    if (!appSnap.exists()) return;
    const a = appSnap.data();
    await updateDoc(doc(db, "TeacherApplications", appId), { status: 'approved' });

    const userSnap = await getDoc(doc(db, "Users", a.uid));
    const p = userSnap.exists() ? userSnap.data() : {};
    const existingClassAccess = p.classAccess || [p.classLevel || 'Class 9'];
    const newClassAccess = [...new Set([...existingClassAccess, ...a.classes])];
    const newTags = [
      ...newClassAccess.map(c => makeTag(c, 'class')),
      makeTag('Teacher', 'teacher'),
      ...a.subjects.map(s => makeTag(s, 'subject')),
    ];
    await updateDoc(doc(db, "Users", a.uid), {
      isTeacher: true,
      teacherClasses: [...new Set([...(p.teacherClasses || []), ...a.classes])],
      classAccess: newClassAccess,
      tags: newTags,
    });
    await addDoc(collection(db, "Notifications"), {
      toUid: a.uid, title: 'Teacher Application', body: '🎉 You are approved for Teacher!',
      createdAt: serverTimestamp(), sentBy: u.username
    });
    document.getElementById(`app-${appId}`)?.remove();
  } catch (e) {
    alert('Approve failed: ' + e.message);
  }
}
window.adminApproveTeacher = adminApproveTeacher;

async function adminRejectTeacher(appId) {
  const u = currentUser;
  try {
    const appSnap = await getDoc(doc(db, "TeacherApplications", appId));
    if (!appSnap.exists()) return;
    const a = appSnap.data();
    await updateDoc(doc(db, "TeacherApplications", appId), { status: 'rejected' });
    await addDoc(collection(db, "Notifications"), {
      toUid: a.uid, title: 'Teacher Application', body: '❌ You are rejected for Teacher application.',
      createdAt: serverTimestamp(), sentBy: u.username
    });
    document.getElementById(`app-${appId}`)?.remove();
  } catch (e) {
    alert('Reject failed: ' + e.message);
  }
}
window.adminRejectTeacher = adminRejectTeacher;

/* ---------------- 404 ---------------- */
function renderNotFound() {
  root.innerHTML = `
  <main>
    <div class="card" style="text-align:center;">
      <div style="font-size:2.4rem;">🤷</div>
      <h2 class="section-title" style="margin-top:10px;">Page Not Found</h2>
      <p style="color:var(--muted); font-size:.85rem; margin-bottom:14px;">Yeh room exist nahi karta ya aapke paas permission nahi hai.</p>
      <button class="primary" onclick="go('#/home')">Go Home</button>
    </div>
  </main>`;
}
