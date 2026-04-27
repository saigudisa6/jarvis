// ── State ──────────────────────────────────────────────────────────────────────
const quizEl       = document.getElementById('quiz');
const profileEl    = document.getElementById('profile');
const profileCard  = document.getElementById('profile-card');
const progressFill = document.getElementById('progress-fill');
const completion   = document.getElementById('completion-badge');
const statusEl     = document.getElementById('status');
const googleBadge  = document.getElementById('google-badge');

const steps = Array.from(document.querySelectorAll('#quiz .step'));
const totalSteps = steps.length;
let currentStep = 0;
let answers = {};

const FIELD_LABELS = {
  distraction: 'Distraction',
  chillness:   'Chillness',
  overallGoal: 'Overall goal',
  shortGoal:   'Short term',
  longGoal:    'Long term',
  food:        'Food',
  locations:   'Spots',
};

// ── Render ────────────────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  statusEl.innerHTML = type ? `<span class="badge ${type}">${msg}</span>` : msg;
}

function setGoogleBadge(connected) {
  googleBadge.textContent = connected ? 'connected' : 'not connected';
  googleBadge.className   = `badge ${connected ? 'ok' : 'err'}`;
}

function showQuiz() {
  quizEl.style.display = 'block';
  profileEl.style.display = 'none';
  goToStep(0);
}

function showProfile(opts = {}) {
  quizEl.style.display = 'none';
  profileEl.style.display = 'block';
  completion.style.display = opts.justSaved ? 'block' : 'none';
  renderProfileCard();
}

function renderProfileCard() {
  const p = answers || {};
  if (!Object.keys(p).length) { profileCard.innerHTML = '<div class="profile-row"><span class="pl">Profile</span><span class="pv">empty</span></div>'; return; }
  const rows = [];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const v = p[key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const display = Array.isArray(v) ? v.join(', ') : String(v);
    rows.push(`<div class="profile-row"><span class="pl">${label}</span><span class="pv">${escapeHtml(display)}</span></div>`);
  }
  profileCard.innerHTML = rows.join('') || '<div class="profile-row"><span class="pl">Profile</span><span class="pv">empty</span></div>';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Quiz navigation ───────────────────────────────────────────────────────────
function goToStep(n) {
  if (n < 0 || n >= totalSteps) return;
  currentStep = n;
  steps.forEach((s, i) => s.classList.toggle('active', i === n));
  progressFill.style.width = `${((n + 1) / totalSteps) * 100}%`;
  // Focus the input if there is one
  setTimeout(() => {
    const ta = steps[n].querySelector('textarea, input[type="text"]');
    if (ta) ta.focus();
  }, 50);
  refreshNextEnabled(n);
}

function refreshNextEnabled(n) {
  const step = steps[n];
  const nextBtn = step.querySelector('.btn-next');
  if (!nextBtn) return;
  const type = step.dataset.type;
  const field = step.dataset.field;
  const val = answers[field];
  let valid = false;
  if (type === 'scale')  valid = !!val;
  if (type === 'text')   valid = !!(val && val.trim().length);
  if (type === 'chips')  valid = Array.isArray(val) && val.length > 0;
  nextBtn.disabled = !valid;
}

function captureCurrentStep() {
  const step = steps[currentStep];
  const type = step.dataset.type;
  const field = step.dataset.field;
  if (type === 'text') {
    const ta = step.querySelector('textarea, input[type="text"]');
    if (ta) answers[field] = ta.value.trim();
  }
  // scale/chips already write into answers on click
}

async function finishQuiz() {
  captureCurrentStep();
  answers.completedAt = Date.now();
  console.log('[JARVIS quiz] saving profile:', answers);
  try {
    await chrome.storage.sync.set({ jarvis_profile: answers });
    console.log('[JARVIS quiz] profile saved');
    showProfile({ justSaved: true });
  } catch (err) {
    console.error('[JARVIS quiz] save failed:', err);
    statusEl.innerHTML = `<span class="badge err">Save failed: ${err.message}</span>`;
  }
}

// ── Wire up steps ─────────────────────────────────────────────────────────────
steps.forEach((step, idx) => {
  const type = step.dataset.type;
  const field = step.dataset.field;
  const nextBtn = step.querySelector('.btn-next');
  const backBtn = step.querySelector('.btn-back');

  if (type === 'scale') {
    step.querySelectorAll('.scale button').forEach(btn => {
      btn.addEventListener('click', () => {
        step.querySelectorAll('.scale button').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        answers[field] = parseInt(btn.dataset.value, 10);
        refreshNextEnabled(idx);
        // Auto-advance after a short delay
        setTimeout(() => {
          if (idx === totalSteps - 1) finishQuiz();
          else goToStep(idx + 1);
        }, 250);
      });
    });
  }

  if (type === 'text') {
    const ta = step.querySelector('textarea, input[type="text"]');
    ta.addEventListener('input', () => {
      answers[field] = ta.value.trim();
      refreshNextEnabled(idx);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!nextBtn.disabled) {
          captureCurrentStep();
          if (idx === totalSteps - 1) finishQuiz();
          else goToStep(idx + 1);
        }
      }
    });
  }

  if (type === 'chips') {
    step.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.dataset.value;
        // Re-resolve answers[field] every click — `answers` may have been reassigned
        // by the storage boot callback after this handler was bound.
        if (!Array.isArray(answers[field])) answers[field] = [];
        const arr = answers[field];
        if (chip.classList.toggle('selected')) {
          if (!arr.includes(val)) arr.push(val);
        } else {
          const i = arr.indexOf(val);
          if (i >= 0) arr.splice(i, 1);
        }
        refreshNextEnabled(idx);
      });
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      captureCurrentStep();
      if (idx === totalSteps - 1) finishQuiz();
      else goToStep(idx + 1);
    });
  }
  if (backBtn) {
    backBtn.addEventListener('click', () => goToStep(idx - 1));
  }
});

// ── Traffic-light buttons ─────────────────────────────────────────────────────
document.querySelector('.traffic-lights .red').addEventListener('click', () => window.close());
document.querySelector('.traffic-lights .green').addEventListener('click', () => {
  // jump to profile view
  if (Object.keys(answers).length && answers.completedAt) showProfile();
});

// ── Settings handlers (API key, Google) ───────────────────────────────────────
chrome.storage.sync.get('asi_key', ({ asi_key }) => {
  if (asi_key) document.getElementById('asi-key').value = asi_key;
});

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, ({ authed } = {}) => {
  setGoogleBadge(!!authed);
});

document.getElementById('btn-save').addEventListener('click', () => {
  const key = document.getElementById('asi-key').value.trim();
  if (!key) { setStatus('Enter a key first', 'err'); return; }
  chrome.storage.sync.set({ asi_key: key }, () => setStatus('Saved!', 'ok'));
});

document.getElementById('btn-auth').addEventListener('click', () => {
  setStatus('Opening Google auth…');
  chrome.runtime.sendMessage({ type: 'AUTH' }, response => {
    if (response?.success) {
      setGoogleBadge(true);
      setStatus('Google connected!', 'ok');
    } else {
      setStatus(response?.error || 'Auth failed', 'err');
    }
  });
});

document.getElementById('btn-edit-profile').addEventListener('click', () => {
  // Prefill answers, restart quiz
  steps.forEach((step, idx) => {
    const field = step.dataset.field;
    const type = step.dataset.type;
    const v = answers[field];
    if (v == null) return;
    if (type === 'scale') {
      step.querySelectorAll('.scale button').forEach(b => {
        b.classList.toggle('selected', parseInt(b.dataset.value, 10) === v);
      });
    } else if (type === 'text') {
      const ta = step.querySelector('textarea, input[type="text"]');
      if (ta) ta.value = v;
    } else if (type === 'chips' && Array.isArray(v)) {
      step.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('selected', v.includes(c.dataset.value));
      });
    }
    refreshNextEnabled(idx);
  });
  showQuiz();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
chrome.storage.sync.get('jarvis_profile', ({ jarvis_profile }) => {
  if (jarvis_profile && jarvis_profile.completedAt) {
    answers = jarvis_profile;
    showProfile();
  } else {
    answers = jarvis_profile || {};
    showQuiz();
  }
});
