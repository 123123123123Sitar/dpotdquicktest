// Firebase globals
const appAuth = firebase.auth();
const firestore = firebase.firestore();

// API Keys (Gemini helper reused)
// API Keys (Gemini helper reused)

const LATEX_BOILERPLATE = `\\documentclass{article}
\\usepackage{amsmath}

\\begin{document}

Write your proof here. 

For inline math, use: $x^2 + y^2 = z^2$

For display math, use double dollar signs:
$$
\\frac{a}{b} = \\frac{c}{d}
$$

Common symbols:
- Fractions: $\\frac{numerator}{denominator}$
- Exponents: $x^2$ or $x^{10}$
- Subscripts: $x_1$ or $x_{10}$
- Square root: $\\sqrt{x}$ or $\\sqrt[3]{x}$
- Summation: $\\sum_{i=1}^{n} i$
- Integral: $\\int_0^1 f(x) dx$

\\end{document}`;


// Cache admin emails to filter out admin accounts from student views
async function getAdminEmails() {
    if (window._dpotd_adminEmails) return window._dpotd_adminEmails;
    const set = new Set();
    try {
        const snap = await firestore.collection('users').where('isAdmin', '==', true).get();
        snap.forEach(doc => {
            const e = doc.data().email;
            if (e) set.add(e.toLowerCase());
        });
        window._dpotd_adminEmails = set;
    } catch (e) {
        console.warn('getAdminEmails failed', e);
    }
    try {
        const settingsDoc = await firestore.collection('settings').doc('appSettings').get();
        if (settingsDoc.exists) {
            const adminEmail = settingsDoc.data().adminEmail;
            if (adminEmail) set.add(adminEmail.toLowerCase());
        }
    } catch (e) {
        // ignore
    }
    return set;
}

// State
let currentUser = null;
let startTime, timerInterval, questionsData;
let q1StartTime, q2StartTime, q3StartTime;
let q1EndTime, q2EndTime, q3EndTime;
let exitCount = 0, exitLogs = [];
let testActive = false, currentDay = null, currentQuestion = 0;
let TEST_DURATION = 120 * 60 * 1000;
let latexUpdateTimer = null;
let autoSaveInterval = null;
let fullscreenChangeHandler, visibilityChangeHandler;
let domReady = false;
let pendingMainRender = false;
let statusCacheHTML = '';
let statusKeepaliveInterval = null;
let geminiWorkingEndpoint = null; // cache the first working Gemini endpoint to avoid slow retries

function setStatusHTML(html) {
    statusCacheHTML = html || '';
    const statusEl = document.getElementById('testStatus');
    if (statusEl) statusEl.innerHTML = statusCacheHTML;
}

function startStatusKeepalive() {
    if (statusKeepaliveInterval) return;
    statusKeepaliveInterval = setInterval(() => {
        const statusEl = document.getElementById('testStatus');
        if (statusEl && !statusEl.innerHTML.trim()) {
            statusEl.innerHTML = statusCacheHTML || '<p style="color:#666;">Loading today\'s test...</p>';
        }
    }, 1500);
}

function formatTimeLeft(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatMinutes(seconds) {
    const s = Number(seconds) || 0;
    const mins = s / 60;
    return `${mins.toFixed(2)} min`;
}

// ------------------ Auth lifecycle ------------------
appAuth.onAuthStateChanged(async (user) => {
    if (!user) {
        currentUser = null;
        localStorage.removeItem('dpotdUser');
        const mainPortal = document.getElementById('mainPortal');
        if (mainPortal) mainPortal.style.display = 'none';
        else pendingMainRender = true;
        return;
    }

    // Determine if this account is an admin; if so, redirect to admin page
    let isAdmin = false;
    let name = user.email;
    try {
        const userDoc = await firestore.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            const d = userDoc.data();
            isAdmin = !!d.isAdmin;
            name = d.name || user.email;
        } else {
            // fallback: legacy docs keyed by email
            const snap = await firestore.collection('users').where('email', '==', user.email || '').limit(1).get();
            if (!snap.empty) {
                const d = snap.docs[0].data();
                isAdmin = !!d.isAdmin;
                name = d.name || user.email;
            }
        }
    } catch (e) {
        console.warn('Auth lookup failed', e);
    }

    if (isAdmin) {
        // Redirect admin users to the admin UI instead of using the student portal
        window.location.href = '/admin.html';
        return;
    }

    currentUser = { uid: user.uid, email: user.email, name };
    localStorage.setItem('dpotdUser', JSON.stringify(currentUser));
    showMainPortal();
});

window.addEventListener('DOMContentLoaded', () => {
    domReady = true;
    const storedUser = localStorage.getItem('dpotdUser');
    if (storedUser) {
        try {
            currentUser = JSON.parse(storedUser);
        } catch (_) {
            currentUser = null;
        }
    }
    if (appAuth.currentUser && currentUser) {
        showMainPortal();
    }
    if (pendingMainRender && currentUser) showMainPortal();
    startStatusKeepalive();

    // Answer input sanitization
    ['q1Answer', 'q2Answer'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', (e) => {
                const cleaned = cleanAnswer(e.target.value);
                if (e.target.value !== cleaned) e.target.value = cleaned;
            });
        }
    });

    // Latex helper initialization
    const latexInput = document.getElementById('latexInput');
    if (latexInput) {
        latexInput.addEventListener('input', updateLatexPreview);
        // Pre-fill helper text if empty
        if (!latexInput.value.trim()) {
            latexInput.value = LATEX_BOILERPLATE;
            updateLatexPreview();
        }
    }

    // Expose helpers globally if not already
    window.toggleAIHelper = toggleAIHelper;
    window.showLatexHelp = showLatexHelp;
    window.hideLatexHelp = hideLatexHelp;
    window.sendAIMessage = sendAIMessage;
    window.handleAIEnter = handleAIEnter;
});

// ------------------ UI helpers ------------------
function showStatus(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = 'status ' + type;
    el.style.display = 'block';
}

function showLoading(message) {
    const txt = document.getElementById('loadingText');
    const modal = document.getElementById('loadingModal');
    if (txt) txt.textContent = message;
    if (modal) modal.classList.add('show');
}

function hideLoading() {
    const modal = document.getElementById('loadingModal');
    if (modal) modal.classList.remove('show');
}

function cleanAnswer(answer) {
    return answer.replace(/[^0-9-]/g, '').replace(/(?!^)-/g, '');
}

function handleLoginEnter(event) {
    if (event.key === 'Enter') login();
}

function showLogin() {
    const loginForm = document.getElementById('loginForm');
    const forgotForm = document.getElementById('forgotPasswordForm');
    const resetForm = document.getElementById('resetPasswordForm');
    if (loginForm) loginForm.classList.remove('hidden');
    if (forgotForm) forgotForm.classList.add('hidden');
    if (resetForm) resetForm.classList.add('hidden');
}

function showForgotPassword() {
    const loginForm = document.getElementById('loginForm');
    const forgotForm = document.getElementById('forgotPasswordForm');
    const resetForm = document.getElementById('resetPasswordForm');
    if (loginForm) loginForm.classList.add('hidden');
    if (forgotForm) forgotForm.classList.remove('hidden');
    if (resetForm) resetForm.classList.add('hidden');
}

async function requestPasswordReset() {
    const email = document.getElementById('resetEmail').value.trim();
    if (!email) {
        showStatus('resetStatus', 'Please enter your email address', 'error');
        return;
    }
    showLoading('Sending reset link...');
    try {
        // USE CUSTOM API ENDPOINT (NodeMailer)
        const response = await fetch('/api/send-password-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
        });

        const result = await response.json();
        hideLoading();

        if (response.ok && result.success) {
            showStatus('resetStatus', 'If an account exists with that email, a “Set new password” email is on the way. Open it and tap the button to choose a new password.', 'success');
            document.getElementById('resetEmail').value = '';
        } else {
            throw new Error(result.error || 'Failed to send reset email');
        }
    } catch (error) {
        hideLoading();
        showStatus('resetStatus', 'Error: ' + error.message, 'error');
    }
}

async function verifyResetToken(token) {
    showStatus('loginStatus', 'Please use the “Set new password” email we sent to update your password.', 'info');
}

async function resetPassword() {
    showStatus('resetPasswordStatus', 'Please use the “Set new password” email we sent to update your password.', 'info');
}

async function login() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
        showStatus('loginStatus', 'Please enter email and password', 'error');
        return;
    }

    showLoading('Signing in...');
    try {
        const cred = await appAuth.signInWithEmailAndPassword(email, password);

        // After sign-in, verify this account is not an admin
        let isAdmin = false;
        let name = email;
        try {
            const userDoc = await firestore.collection('users').doc(cred.user.uid).get();
            if (userDoc.exists) {
                const d = userDoc.data();
                isAdmin = !!d.isAdmin;
                name = d.name || email;
            } else {
                const snap = await firestore.collection('users').where('email', '==', email).limit(1).get();
                if (!snap.empty) {
                    const d = snap.docs[0].data();
                    isAdmin = !!d.isAdmin;
                    name = d.name || email;
                }
            }
        } catch (e) {
            console.warn('Post-login lookup failed', e);
        }

        if (isAdmin) {
            hideLoading();
            window.location.href = '/admin.html';
            return;
        }

        currentUser = { uid: cred.user.uid, email, name };
        localStorage.setItem('dpotdUser', JSON.stringify(currentUser));
        hideLoading();
        showMainPortal();
    } catch (error) {
        hideLoading();
        showStatus('loginStatus', 'Account credentials incorrect. Please try again.', 'error');
    }
}

function logout() {
    appAuth.signOut();
    currentUser = null;
    localStorage.removeItem('dpotdUser');
    document.getElementById('mainPortal').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
}

function showMainPortal() {
    if (!currentUser) return;
    if (!domReady) {
        pendingMainRender = true;
        return;
    }
    pendingMainRender = false;
    const authScreenEl = document.getElementById('authScreen');
    const mainPortal = document.getElementById('mainPortal');
    if (authScreenEl) authScreenEl.classList.add('hidden');
    if (mainPortal) {
        mainPortal.classList.remove('hidden');
        mainPortal.style.display = 'block';
    }
    setStatusHTML('<p style="color:#666;">Loading today\'s test...</p>');
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = currentUser.name;
    const nameInput = document.getElementById('profileNameInput');
    if (nameInput) nameInput.value = currentUser.name;
    const emailInput = document.getElementById('profileEmailInput');
    if (emailInput) emailInput.value = currentUser.email;
    const profileRank = document.getElementById('profileRank');
    if (profileRank) profileRank.classList.add('hidden');
    loadUserRank();
    checkTodayTest();
    setTimeout(() => {
        const statusNow = document.getElementById('testStatus');
        if (statusNow && !statusNow.innerHTML.trim()) {
            checkTodayTest();
        }
    }, 800);
    loadHistory();
    loadLeaderboard();
    loadSettings();
}

async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;

    if (!currentPassword || !newPassword || !confirmPassword) {
        showStatus('profileStatus', 'Please fill in all fields', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showStatus('profileStatus', 'New passwords do not match', 'error');
        return;
    }

    try {
        const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPassword);
        await appAuth.currentUser.reauthenticateWithCredential(cred);
        await appAuth.currentUser.updatePassword(newPassword);
        showStatus('profileStatus', 'Password updated successfully', 'success');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmNewPassword').value = '';
    } catch (error) {
        showStatus('profileStatus', error.message, 'error');
    }
}

// ------------------ Settings & schedule ------------------
async function loadSettings() {
    try {
        const doc = await firestore.collection('settings').doc('appSettings').get();
        const data = doc.exists ? doc.data() : {};
        const duration = data.testDuration || 120;
        TEST_DURATION = duration * 60 * 1000;
        const el = document.getElementById('testDurationDisplay');
        if (el) el.textContent = `${duration} minutes`;
    } catch (e) {
        // Fall back to default if rules prevent read
        TEST_DURATION = 120 * 60 * 1000;
    }
}

async function getCurrentDay() {
    const now = new Date();
    let maxDay = null;
    try {
        const snap = await firestore.collection('schedule').get();
        snap.forEach(doc => {
            const data = doc.data();
            if (!data.day || !data.openTime) return;
            const open = data.openTime.toDate();
            if (open <= now) {
                if (maxDay === null || data.day > maxDay) maxDay = data.day;
            }
        });
    } catch (e) {
        console.error('Error reading schedule', e);
    }
    return maxDay;
}

// ------------------ Rank & leaderboard ------------------
async function loadUserRank() {
    if (!currentUser) return;
    try {
        const adminEmails = await getAdminEmails();
        const snap = await firestore.collection('submissions').get();
        const scores = {};
        snap.forEach(doc => {
            const d = doc.data();
            const email = (d.studentEmail || '').toLowerCase();
            if (adminEmails && adminEmails.has(email)) return; // skip admin submissions
            const q1 = d.q1Correct ? 4 : 0;
            const q2 = d.q2Correct ? 6 : 0;
            const q3 = parseInt(d.q3Score || 0);
            if (!scores[email]) scores[email] = { email, totalScore: 0, totalTime: 0 };
            scores[email].totalScore += q1 + q2 + q3;
            scores[email].totalTime += d.totalTime || 0;
        });

        const leaderboardArray = Object.values(scores);
        leaderboardArray.sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            return a.totalTime - b.totalTime;
        });

        const idx = leaderboardArray.findIndex(s => s.email === currentUser.email);
        if (idx === -1) {
            const profileRank = document.getElementById('profileRank');
            if (profileRank) profileRank.classList.add('hidden');
            return;
        }

        const rank = idx + 1;
        const total = leaderboardArray.length;
        const userRank = document.getElementById('userRank');
        const profileRank = document.getElementById('profileRank');
        if (userRank) userRank.textContent = `Rank: ${rank}/${total}`;
        if (profileRank) profileRank.classList.remove('hidden');
        const rankDisplay = document.getElementById('rankDisplay');
        const rankDetails = document.getElementById('rankDetails');
        if (rankDisplay) rankDisplay.textContent = `#${rank}`;
        if (rankDetails) rankDetails.textContent = `out of ${total} students`;
    } catch (error) {
        console.error('loadUserRank failed', error);
    }
}

async function loadLeaderboard() {
    const container = document.getElementById('leaderboardContainer');
    if (container) container.innerHTML = '<p style="color: #666; text-align: center;">Loading leaderboard...</p>';
    try {
        const adminEmails = await getAdminEmails();
        const snap = await firestore.collection('submissions').get();
        const scores = {};
        snap.forEach(doc => {
            const d = doc.data();
            const email = (d.studentEmail || '').toLowerCase();
            if (adminEmails && adminEmails.has(email)) return; // skip admin submissions
            const name = d.studentName;
            const q1 = d.q1Correct ? 4 : 0;
            const q2 = d.q2Correct ? 6 : 0;
            const q3 = parseInt(d.q3Score || 0);
            if (!scores[email]) scores[email] = { name, email, totalScore: 0, completedDays: 0 };
            scores[email].totalScore += q1 + q2 + q3;
            scores[email].completedDays += 1;
        });
        const leaderboardArray = Object.values(scores).sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
            return 0;
        }).slice(0, 10);

        if (!container) return;
        if (leaderboardArray.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666;">No submissions yet.</p>';
            return;
        }

        let tableHTML = `
            <table class="leaderboard-table">
                <thead>
                    <tr>
                        <th>Rank</th>
                        <th>Name</th>
                        <th>Total Score</th>
                        <th>Tests Completed</th>
                    </tr>
                </thead>
                <tbody>
        `;

        leaderboardArray.forEach((entry, index) => {
            const rank = index + 1;
            let rankClass = 'rank-other';
            if (rank === 1) rankClass = 'rank-1';
            else if (rank === 2) rankClass = 'rank-2';
            else if (rank === 3) rankClass = 'rank-3';
            tableHTML += `
                <tr>
                    <td><span class="rank-badge ${rankClass}">${rank}</span></td>
                    <td>${entry.name || entry.email}</td>
                    <td>${entry.totalScore}</td>
                    <td>${entry.completedDays}</td>
                </tr>
            `;
        });

        tableHTML += '</tbody></table>';
        container.innerHTML = tableHTML;
    } catch (error) {
        if (container) container.innerHTML = '<p style="color:#dc3545; text-align:center;">Leaderboard unavailable (permissions)</p>';
        console.error('loadLeaderboard failed', error);
    }
}

// ------------------ Test flow ------------------
async function checkTodayTest() {
    try {
        if (!currentUser) return;
        if (!statusCacheHTML) setStatusHTML('<p style="color: #666;">Checking your test status...</p>');
        const day = await getCurrentDay();
        currentDay = day;
        const banner = document.getElementById('resumeTestBanner');
        if (banner) banner.style.display = 'none';
        const titleEl = document.getElementById('testTitle');
        if (titleEl && day) titleEl.textContent = `D.PotD Day ${day}`;

        if (!day) {
            setStatusHTML(`
                <div style="text-align: center; padding: 40px;">
                    <h3 style="color: #666; margin-bottom: 15px;">No Test Available Today</h3>
                    <p style="color: #999;">There is no scheduled test for today. Please check back on a scheduled test day.</p>
                </div>
            `);
            return;
        }

        setStatusHTML('<p style="color: #666;">Checking your test status...</p>');

        // Check if already submitted (needs composite index: submissions on studentEmail+day)
        const submittedSnap = await firestore.collection('submissions')
            .where('studentEmail', '==', currentUser.email)
            .where('day', '==', day)
            .limit(1)
            .get();
        if (!submittedSnap.empty) {
            setStatusHTML(`
                <div style="text-align: center; padding: 40px;">
                    <h3 style="color: #28a745; margin-bottom: 15px;">Test Already Submitted</h3>
                    <p style="color: #666;">You have already completed Day ${day}'s test.</p>
                    <p style="color: #666; margin-top: 10px;">Check the "Score History" tab to view your results.</p>
                </div>
            `);
            return;
        }

        // Check active test
        const activeDoc = await firestore.collection('activeTests').doc(`${currentUser.uid}_day${day}`).get();
        if (activeDoc.exists) {
            const data = activeDoc.data();
            exitCount = data.exitCount || 0;
            exitLogs = data.exitLogs || [];
            if (banner) banner.style.display = 'none';
            const resumeDay = document.getElementById('resumeDay');
            if (resumeDay) resumeDay.textContent = day;

            let endMs = data.endTime && data.endTime.toMillis ? data.endTime.toMillis() : null;
            const startMs = data.startTime && data.startTime.toMillis ? data.startTime.toMillis() : null;
            if (!endMs && startMs) endMs = startMs + TEST_DURATION;
            if (!endMs) endMs = Date.now() + TEST_DURATION;
            const timeLeft = formatTimeLeft(endMs - Date.now());

            setStatusHTML(`
                <div class="resume-test-banner">
                    <h3>You Have an Active Test in Progress</h3>
                    <p>You started Day ${day}'s test but didn't complete it.</p>
                    <p><strong>Violations recorded: ${exitCount}</strong></p>
                    <p><strong>Time remaining: ${timeLeft}</strong></p>
                    <button class="btn" onclick="resumeTest()" style="margin-top: 15px;">Resume Test</button>
                </div>
            `);
            return;
        }

        const minutes = Math.floor(TEST_DURATION / 60000);
        setStatusHTML(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #EA5A2F; margin-bottom: 20px;">Day ${day} Test Available</h2>
                <p style="font-size: 18px; color: #666; margin-bottom: 20px;">Ready to take today's test?</p>
                <button class="btn" onclick="showConfirmation()" style="padding: 15px 40px, font-size: 18px;">Start Test</button>
                <p style="margin-top: 12px; color: #999;">Time limit: ${minutes} minutes</p>
            </div>
        `);
    } catch (error) {
        console.error('checkTodayTest failed', error);
        setStatusHTML('<p style="color:#dc3545;">Unable to check today\'s test. Please try again later.</p>');
    }
}

async function resumeTest() {
    const doc = await firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay}`).get();
    if (!doc.exists) return;
    const data = doc.data();
    const titleEl = document.getElementById('testTitle');
    if (titleEl) titleEl.textContent = `D.PotD Day ${currentDay}`;

    questionsData = await loadQuestions(currentDay);
    if (!questionsData) return;

    renderQuestions(questionsData);
    document.getElementById('q1Answer').value = data.q1Answer || '';
    document.getElementById('q2Answer').value = data.q2Answer || '';
    document.getElementById('latexInput').value = data.q3Answer || LATEX_BOILERPLATE;
    exitCount = data.exitCount || 0;
    exitLogs = data.exitLogs || [];
    startTime = data.startTime ? data.startTime.toMillis() : Date.now();
    enterFullscreenAndStart((typeof data.currentQuestion === 'number') ? data.currentQuestion : 0);
}

function showConfirmation() {
    document.getElementById('confirmationModal').classList.add('show');
}

function cancelTest() {
    document.getElementById('confirmationModal').classList.remove('show');
}

function confirmStart() {
    document.getElementById('confirmationModal').classList.remove('show');
    startTest();
}

async function startTest() {
    if (!currentDay) {
        currentDay = await getCurrentDay();
    }
    if (!currentDay) {
        alert('No active test today.');
        return;
    }

    const titleEl = document.getElementById('testTitle');
    if (titleEl) titleEl.textContent = `D.PotD Day ${currentDay}`;

    showLoading(`Loading Day ${currentDay} questions...`);
    questionsData = await loadQuestions(currentDay);
    if (!questionsData) {
        hideLoading();
        alert('Questions not found for today.');
        return;
    }

    renderQuestions(questionsData);

    startTime = Date.now();
    const endTime = startTime + TEST_DURATION;

    await firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay}`).set({
        userId: currentUser.uid,
        email: currentUser.email,
        day: currentDay,
        startTime: firebase.firestore.Timestamp.fromDate(new Date(startTime)),
        endTime: firebase.firestore.Timestamp.fromDate(new Date(endTime)),
        currentQuestion: 0,
        q1Answer: '',
        q2Answer: '',
        q2Answer: '',
        q3Answer: LATEX_BOILERPLATE,
        exitCount: 0,
        exitLogs: [],
        status: 'active'
    });

    hideLoading();
    await enterFullscreenAndStart(0);
}

async function loadQuestions(day) {
    try {
        const doc = await firestore.collection('questions').doc(`day${day}`).get();
        if (!doc.exists) return null;
        const d = doc.data();
        return {
            instructions: d.instructions || '',
            q1_text: d.q1Text || '',
            q1_answer: String(d.q1Answer || ''),
            q1_image: d.q1Image || '',
            q2_text: d.q2Text || '',
            q2_answer: String(d.q2Answer || ''),
            q2_image: d.q2Image || '',
            q3_text: d.q3Text || '',
            q3_answer: d.q3Answer || '',
            q3_image: d.q3Image || ''
        };
    } catch (e) {
        console.error('loadQuestions failed', e);
        return null;
    }
}

async function enterFullscreenAndStart(questionNum) {
    const mainPortalEl = document.getElementById('mainPortal');
    const questionSectionEl = document.getElementById('questionSection');
    const navigationBarEl = document.getElementById('navigationBar');
    const sponsorFooter = document.querySelector('.sponsor-footer');
    if (mainPortalEl) mainPortalEl.style.display = 'none';
    if (questionSectionEl) questionSectionEl.style.display = 'block';
    if (navigationBarEl) navigationBarEl.style.display = 'block';

    // KEEP SPONSOR LOGO visible per user request
    if (sponsorFooter) sponsorFooter.style.display = 'flex';

    const profileRank = document.getElementById('profileRank');
    if (profileRank) profileRank.classList.add('hidden');
    // REMOVED locked class to disable banner/scroll lock
    testActive = true;
    monitorFullscreen();
    // timing will be set when each question is shown
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
    startAutoSave();
    showQuestion(questionNum);

    try {
        if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    } catch (err) {
        console.error('Fullscreen error:', err);
    }
}

function showQuestion(num) {
    // pages: 0 = instructions, 1..3 = questions
    ['instructionsPage', 'q1Page', 'q2Page', 'q3Page'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    if (num === 0) {
        const inst = document.getElementById('instructionsPage');
        if (inst) inst.style.display = 'block';
    } else {
        const qp = document.getElementById(`q${num}Page`);
        if (qp) qp.style.display = 'block';
    }

    // Nav button highlighting logic
    ['navBtn0', 'navBtn1', 'navBtn2', 'navBtn3'].forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.remove('active');
    });
    const currentBtn = document.getElementById('navBtn' + num);
    if (currentBtn) currentBtn.classList.add('active');

    const nextBtn = document.getElementById('nextBtn');
    const submitBtn = document.getElementById('submitBtn');
    if (nextBtn && submitBtn) {
        if (num === 3) {
            nextBtn.style.display = 'none';
            submitBtn.style.display = 'block';
        } else {
            nextBtn.style.display = 'block';
            submitBtn.style.display = 'none';
        }
    }

    const aiBtn = document.getElementById('aiToggleBtn');
    const helpBtn = document.getElementById('latexHelpBtn');
    if (aiBtn && helpBtn) {
        if (num === 3) {
            aiBtn.style.display = 'block';
            helpBtn.style.display = 'flex';
        } else {
            aiBtn.style.display = 'none';
            helpBtn.style.display = 'none';
        }
    }

    // NO RUBRIC SHOWN HERE - removed logic

    // record end-time for previous question when moving forward, and start time for shown question
    const prev = currentQuestion;
    if (prev === 1) q1EndTime = Date.now();
    if (prev === 2) q2EndTime = Date.now();
    if (prev === 3) q3EndTime = Date.now();

    if (num === 1 && !q1StartTime) q1StartTime = Date.now();
    if (num === 2 && !q2StartTime) q2StartTime = Date.now();
    if (num === 3) q3StartTime = Date.now();

    currentQuestion = num;

    // Save currentQuestion to activeTests so resume works
    if (testActive && currentUser && currentDay !== null) {
        try {
            firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay}`).set({
                exitCount,
                exitLogs
            }, { merge: true });
        } catch (e) {
            console.warn('Could not update currentQuestion:', e);
        }
    }
}

function nextQuestion() {
    if (currentQuestion < 3) showQuestion(currentQuestion + 1);
}

function updateTimer() {
    if (!startTime) return;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, TEST_DURATION - elapsed);
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    const timer = document.getElementById('timer');
    if (timer) {
        timer.textContent = `Time Remaining: ${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timer.style.display = 'block';
        timer.style.color = remaining < 600000 ? '#ff6b6b' : '#000';
    }
    if (remaining <= 0) {
        clearInterval(timerInterval);
        submitTest(true);
    }
}

// ------------------ LaTeX helper / AI ------------------
function updateLatexPreview() {
    if (latexUpdateTimer) clearTimeout(latexUpdateTimer);
    latexUpdateTimer = setTimeout(() => {
        const inputEl = document.getElementById('latexInput');
        const preview = document.getElementById('latexPreview');
        const input = inputEl ? inputEl.value : '';
        if (!preview) return;

        if (!input.trim()) {
            preview.innerHTML = '<p style="color: #999;">Your formatted proof will appear here...</p>';
            return;
        }

        let content = input;

        // Remove document structure wrappers that cause MathJax errors
        content = content.replace(/\\documentclass\{[^}]+\}/g, '');
        content = content.replace(/\\usepackage\{[^}]+\}/g, '');
        content = content.replace(/\\begin\{document\}/g, '');
        content = content.replace(/\\end\{document\}/g, '');

        // Basic environment handling (strip wrapper, keep content)
        // Note: For enumerate/itemize, we might just letting them render as text or rely on formatRichText 
        // if we were pre-processing, but for live preview we just want to avoid "Unknown environment" error.
        // We can just strip the begin/end tags for these specific environments if MathJax complains,
        // but let's just strip the preamble first as requested.

        // Also ensure we trim whitespace
        content = content.trim();

        preview.innerHTML = formatRichText(content) || '<p style="color: #999;">Write your proof...</p>';

        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetClear([preview]);
            MathJax.typesetPromise([preview]).catch((err) => {
                console.error('MathJax error:', err);
                preview.innerHTML += '<p style="color: #dc3545; font-size: 12px; margin-top: 10px;"><strong>LaTeX Error:</strong> Check your syntax</p>';
            });
        }
    }, 500);
}

// ------------------ Submission Logic ------------------

function submitTest(isForced = false) {
    if (!testActive && !isForced) return;

    // If forced (timeout), just go straight to confirmation logic
    if (isForced) {
        confirmSubmission(true);
        return;
    }

    // Otherwise show summary modal
    const q1Answer = (document.getElementById('q1Answer') && document.getElementById('q1Answer').value.trim());
    const q2Answer = (document.getElementById('q2Answer') && document.getElementById('q2Answer').value.trim());
    const q3Answer = (document.getElementById('latexInput') && document.getElementById('latexInput').value.trim());

    // Update summary in modal
    const s1 = document.getElementById('summaryQ1');
    const s2 = document.getElementById('summaryQ2');
    const s3 = document.getElementById('summaryQ3');

    if (s1) {
        s1.textContent = q1Answer ? 'Answered' : 'Not Answered';
        s1.style.color = q1Answer ? '#28a745' : '#dc3545';
        s1.style.fontWeight = 'bold';
    }
    if (s2) {
        s2.textContent = q2Answer ? 'Answered' : 'Not Answered';
        s2.style.color = q2Answer ? '#28a745' : '#dc3545';
        s2.style.fontWeight = 'bold';
    }
    if (s3) {
        // Check if it's just boilerplate
        const isBoilerplate = q3Answer === LATEX_BOILERPLATE.trim() || !q3Answer;
        s3.textContent = !isBoilerplate ? 'Answered' : 'Not Answered';
        s3.style.color = !isBoilerplate ? '#28a745' : '#dc3545';
        s3.style.fontWeight = 'bold';
    }

    const modal = document.getElementById('submissionSummaryModal');
    if (modal) {
        modal.style.display = 'block';
        modal.classList.add('show');
    }
}

function closeSubmissionSummary() {
    const modal = document.getElementById('submissionSummaryModal');
    if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
    }
}

async function confirmSubmission(isForced = false) {
    closeSubmissionSummary();

    showLoading('Submitting your test...');

    // Stop timers, etc. (reusing existing logic from old submitTest)
    clearInterval(timerInterval);
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    testActive = false;

    // Unlock body (though we removed the lock class, good to be safe)
    document.body.classList.remove('locked');

    try {
        if (document.exitFullscreen) await document.exitFullscreen();
    } catch (e) { /* ignore */ }

    const q1Answer = (document.getElementById('q1Answer') && cleanAnswer(document.getElementById('q1Answer').value.trim())) || '';
    const q2Answer = (document.getElementById('q2Answer') && cleanAnswer(document.getElementById('q2Answer').value.trim())) || '';
    const q3Answer = (document.getElementById('latexInput') && document.getElementById('latexInput').value.trim()) || '';

    const endTime = firebase.firestore.Timestamp.now();
    const durationMs = startTime ? (Date.now() - startTime) : 0;
    const totalSeconds = Math.floor(durationMs / 1000);

    // Auto-grade Q1/Q2
    let q1Correct = false;
    let q2Correct = false;

    if (questionsData) {
        // Simple exact match check
        if (questionsData.q1_answer && q1Answer === questionsData.q1_answer) q1Correct = true;
        if (questionsData.q2_answer && q2Answer === questionsData.q2_answer) q2Correct = true;
    }

    // Call AI Grading API for Q3
    let q3Score = null;
    let q3Feedback = 'Pending grading...';

    try {
        const gradeResp = await fetch('/api/grade-submission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                questionText: questionsData.q3_text,
                studentAnswer: q3Answer,
                rubric: 'Standard Proof Rubric (10pts)', // You might want to pass actual rubric if you have it
                correctAnswer: questionsData.q3_answer // Pass correct answer to API
            })
        });
        const gradeData = await gradeResp.json();
        if (gradeData.score !== undefined) {
            q3Score = gradeData.score;
            q3Feedback = gradeData.feedback;
        }
    } catch (err) {
        console.warn('AI autograding failed, will be manual', err);
    }

    // Filter out restricted properties from exitLogs
    const sanitizedExitLogs = (exitLogs || []).map(log => ({
        time: log.time,
        type: log.type
    }));

    // Save submission
    try {
        await firestore.collection('submissions').add({
            userId: currentUser.uid,
            studentEmail: currentUser.email,
            studentName: currentUser.name,
            day: currentDay,
            q1Answer,
            q2Answer,
            q3Answer,
            q1Correct,
            q2Correct,
            q3Score: q3Score, // null if failed/manual
            aiFeedback: q3Feedback,
            totalTime: totalSeconds,
            timestamp: endTime,
            exitCount: exitCount || 0,
            exitLogs: sanitizedExitLogs,
            graded: (q3Score !== null) // if AI graded it, mark as graded? Or keep manual review? 
            // Usually we mark as 'pending' for manual review, but if AI is trusted we can mark graded.
            // Let's assume mixed approach: AI gives preliminary score.
        });

        // Clean up active test
        await firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay}`).delete();

        hideLoading();
    } catch (error) {
        hideLoading();
        alert('Error submitting test: ' + error.message + '\n\nPlease contact your administrator.');
        testActive = true;
    }
}

function recordViolation(type) {
    if (!testActive) return;
    exitCount++;
    exitLogs.push({ time: new Date().toISOString(), type });
    const vc = document.getElementById('violationCount');
    if (vc) vc.textContent = exitCount;
    const warning = document.getElementById('warningOverlay');
    if (warning) warning.classList.add('show');

    // persist to activeTests
    if (currentUser && currentDay !== null) {
        try {
            firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay} `).set({
                exitCount,
                exitLogs
            }, { merge: true });
        } catch (e) {
            console.warn('Could not persist violation:', e);
        }
    }
}

function hideWarning() {
    const warning = document.getElementById('warningOverlay');
    if (warning) warning.classList.remove('show');
}

function returnToFullscreen() {
    if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().then(() => hideWarning()).catch(() => alert('Please allow fullscreen'));
    } else {
        alert('Fullscreen not supported in this browser');
    }
}

function monitorFullscreen() {
    fullscreenChangeHandler = () => {
        if (!document.fullscreenElement && testActive) recordViolation('exited_fullscreen');
    };

    visibilityChangeHandler = () => {
        if (document.hidden && testActive) recordViolation('tab_hidden');
    };

    document.addEventListener('fullscreenchange', fullscreenChangeHandler);
    document.addEventListener('visibilitychange', visibilityChangeHandler);
}

// ------------------ History ------------------
async function loadHistory() {
    if (!currentUser) return;
    const container = document.getElementById('historyContainer');
    if (container) container.innerHTML = '<p style="color:#666;">Loading history...</p>';

    try {
        const snap = await firestore.collection('submissions')
            .where('studentEmail', '==', currentUser.email)
            .orderBy('timestamp', 'desc')
            .get();
        const subs = snap.docs.map(doc => {
            const d = doc.data();
            return {
                timestamp: d.timestamp ? d.timestamp.toDate() : new Date(),
                studentName: d.studentName,
                studentEmail: d.studentEmail,
                day: d.day,
                q1_answer: d.q1Answer,
                q2_answer: d.q2Answer,
                q3_answer: d.q3Answer,
                q1_correct: d.q1Correct,
                q2_correct: d.q2Correct,
                q1_time: d.q1Time,
                q2_time: d.q2Time,
                q3_time: d.q3Time,
                totalTime: d.totalTime,
                exitCount: d.exitCount,
                exitLogs: d.exitLogs,
                q3_score: d.q3Score,
                q3_feedback: d.q3Feedback
            };
        });

        if (!container) return;
        if (subs.length === 0) {
            container.innerHTML = '<p style="color:#666; text-align:center;">No submissions yet.</p>';
            return;
        }

        container.innerHTML = '';
        subs.forEach(sub => {
            const card = document.createElement('div');
            card.className = 'score-card';
            const date = sub.timestamp ? new Date(sub.timestamp).toLocaleString() : '';
            const q1Points = sub.q1_correct ? 4 : 0;
            const q2Points = sub.q2_correct ? 6 : 0;
            const q3Points = parseInt(sub.q3_score || 0);
            const totalPoints = q1Points + q2Points + q3Points;
            let feedbackHTML = '';
            if (sub.q3_feedback) {
                let feedbackContent = sub.q3_feedback
                    .replace(/\\usepackage\{[^}]+\}/g, '')
                    .replace(/\\title\{[^}]*\}/g, '')
                    .replace(/\\author\{[^}]*\}/g, '')
                    .replace(/\\date\{[^}]*\}/g, '')
                    .replace(/\\maketitle/g, '');
                const docMatch = feedbackContent.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/);
                if (docMatch) feedbackContent = docMatch[1].trim();
                const fid = `feedback_${Math.random().toString(36).slice(2)}`;
                feedbackHTML = `<div class="feedback-box"><h4>Q3 Feedback</h4><div id="${fid}" style="line-height: 1.6;">${feedbackContent}</div></div>`;
                setTimeout(() => {
                    const div = document.getElementById(fid);
                    if (div && window.MathJax) MathJax.typesetPromise([div]).catch(() => { });
                }, 100);
            }
            card.innerHTML = `
                        <div class="score-header"><h3>Day ${sub.day}</h3><span style="color: #666; font-size: 14px;">${date}</span></div>
                <div style="background: #EA5A2F; color: white; padding: 15px; border-radius: 8px; margin-bottom: 15px; text-align: center;"><strong style="font-size: 24px;">Total Score: ${totalPoints}/20</strong></div>
                <div class="score-details">
                    <div class="score-item"><strong>Q1:</strong> <span class="${sub.q1_correct ? 'correct' : 'incorrect'}">${sub.q1_correct ? 'Correct (+4 pts)' : 'Incorrect (0 pts)'}</span></div>
                    <div class="score-item"><strong>Q2:</strong> <span class="${sub.q2_correct ? 'correct' : 'incorrect'}">${sub.q2_correct ? 'Correct (+6 pts)' : 'Incorrect (0 pts)'}</span></div>
                    <div class="score-item"><strong>Q3 Score:</strong> ${sub.q3_score !== undefined && sub.q3_score !== '' ? sub.q3_score + '/10 (+' + sub.q3_score + ' pts)' : 'Pending'}</div>
                    <div class="score-item"><strong>Time:</strong> ${formatMinutes(sub.totalTime || 0)}</div>
                </div>
                ${feedbackHTML}
                    `;
            container.appendChild(card);
        });
    } catch (error) {
        if (container) container.innerHTML = '<p style="color: #dc3545;">Error loading history</p>';
    }
}

// ------------------ LaTeX helper / AI ------------------
function updateLatexPreview() {
    if (latexUpdateTimer) clearTimeout(latexUpdateTimer);
    latexUpdateTimer = setTimeout(() => {
        const inputEl = document.getElementById('latexInput');
        const preview = document.getElementById('latexPreview');
        const input = inputEl ? inputEl.value : '';
        if (!preview) return;

        if (!input.trim()) {
            preview.innerHTML = '<p style="color: #999;">Your formatted proof will appear here...</p>';
            return;
        }

        let content = input;
        // Strip preamble commands (handle optional args like [12pt] and whitespace)
        content = content.replace(/\\documentclass(\[[^\]]*\])?\s*\{[^}]+\}/g, '');
        content = content.replace(/\\usepackage(\[[^\]]*\])?\s*\{[^}]+\}/g, '');

        // Strip metadata
        content = content.replace(/\\title\{[^}]*\}/g, '');
        content = content.replace(/\\author\{[^}]*\}/g, '');
        content = content.replace(/\\date\{[^}]*\}/g, '');
        content = content.replace(/\\maketitle/g, '');

        // Try to extract document body
        const docMatch = content.match(/\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/);
        if (docMatch) {
            content = docMatch[1];
        } else {
            // Fallback: just remove the tags if they exist individually to prevent "Unknown environment" error
            content = content.replace(/\\begin\s*\{document\}/g, '');
            content = content.replace(/\\end\s*\{document\}/g, '');
        }

        content = content.trim();

        preview.innerHTML = formatRichText(content) || '<p style="color: #999;">Write your proof...</p>';

        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetClear([preview]);
            MathJax.typesetPromise([preview]).catch((err) => {
                console.error('MathJax error:', err);
                preview.innerHTML += '<p style="color: #dc3545; font-size: 12px; margin-top: 10px;"><strong>LaTeX Error:</strong> Check your syntax</p>';
            });
        }
    }, 500);
}

// ------------------ Tabs ------------------
function switchMainTab(tab) {
    const evt = typeof event !== 'undefined' ? event : null;
    document.querySelectorAll('#mainPortal .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#mainPortal .tab-content').forEach(c => c.classList.remove('active'));
    if (evt && evt.target) evt.target.classList.add('active');
    const targetTab = document.getElementById(`${tab}Tab`);
    if (targetTab) targetTab.classList.add('active');
    if (tab === 'today') {
        if (!statusCacheHTML) {
            setStatusHTML('<p style="color:#666;">Loading today\'s test...</p>');
        } else {
            setStatusHTML(statusCacheHTML);
        }
        checkTodayTest();
    }
    if (tab === 'history') loadHistory();
    if (tab === 'leaderboard') loadLeaderboard();
}

function toggleAIHelper() {
    const ai = document.getElementById('aiHelper');
    if (ai) ai.classList.toggle('show');
}

function showLatexHelp() {
    const d = document.getElementById('latexHelpDropdown');
    if (d) d.classList.add('show');
}

function hideLatexHelp() {
    const d = document.getElementById('latexHelpDropdown');
    if (d) d.classList.remove('show');
}

function handleAIEnter(event) {
    if (event.key === 'Enter') sendAIMessage();
}

async function sendAIMessage() {
    const input = document.getElementById('aiInput');
    const message = input ? input.value.trim() : '';
    if (!message) return;

    addAIMessage(message, 'user');
    if (input) input.value = '';

    const pendingMsg = addAIMessage('Thinking...', 'assistant');

    try {
        const response = await fetch('/api/latex-helper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        if (!response.ok) throw new Error('Request failed');

        const data = await response.json();
        const reply = data.reply;

        if (pendingMsg) pendingMsg.innerHTML = renderAIMessageHTML(reply);
        else addAIMessage(reply, 'assistant');
    } catch (error) {
        console.error('AI Helper Error:', error);
        const errorText = 'I cannot answer right now. Please try again.';
        if (pendingMsg) pendingMsg.innerHTML = renderAIMessageHTML(errorText);
        else addAIMessage(errorText, 'assistant');
    }
}

function addAIMessage(message, type) {
    const container = document.getElementById('aiChatContainer') || document.getElementById('aiChat');
    if (!container) return;
    const msg = document.createElement('div');
    msg.className = 'ai-message ' + type;
    msg.innerHTML = renderAIMessageHTML(message);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return msg;
}

function renderAIMessageHTML(text) {
    if (!text) return '';
    const escapeHTML = (str) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    let escaped = escapeHTML(text);

    // Handle fenced code blocks ```lang ... ```
    escaped = escaped.replace(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g, (_m, code) => {
        const cleaned = code.replace(/^\n+|\n+$/g, '');
        return `<pre><code>${cleaned}</code></pre>`;
    });

    // Handle inline code `...`
    escaped = escaped.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);

    return escaped;
}

document.addEventListener('keydown', (e) => {
    if (testActive) {
        const blocked = [
            e.keyCode === 123,
            (e.ctrlKey || e.metaKey) && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74),
            (e.ctrlKey || e.metaKey) && e.keyCode === 85,
            e.keyCode === 27
        ];
        if (blocked.some(x => x)) {
            e.preventDefault();
            return false;
        }
    }
});

document.addEventListener('contextmenu', (e) => {
    if (testActive) {
        e.preventDefault();
    }
});

window.addEventListener('beforeunload', (e) => {
    if (testActive) {
        e.preventDefault();
        e.returnValue = '';
        recordViolation('attempted_close');
        return '';
    }
});
// Start periodic autosave of current answers into activeTests
function startAutoSave() {
    // clear any prior interval
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    autoSaveInterval = setInterval(async () => {
        if (!testActive || !currentUser || currentDay === null) return;
        try {
            const payload = {
                q1Answer: (document.getElementById('q1Answer') && document.getElementById('q1Answer').value) || '',
                q2Answer: (document.getElementById('q2Answer') && document.getElementById('q2Answer').value) || '',
                q3Answer: (document.getElementById('latexInput') && document.getElementById('latexInput').value) || '',
                currentQuestion: typeof currentQuestion === 'number' ? currentQuestion : 0,
                exitCount: exitCount || 0,
                exitLogs: exitLogs || []
            };
            await firestore.collection('activeTests').doc(`${currentUser.uid}_day${currentDay}`).set(payload, { merge: true });
        } catch (e) {
            // don't spam console, but note occasionally
            console.warn('autosave failed', e);
        }
    }, 5000); // every 5s
}

// Stop autosave when test ends
function stopAutoSave() {
    if (autoSaveInterval) {
        clearInterval(autoSaveInterval);
        autoSaveInterval = null;
    }
}

function formatRichText(raw) {
    if (!raw) return '';
    let html = String(raw);

    function buildList(body, tag) {
        const items = body.split(/\\item/g).map(s => s.trim()).filter(Boolean);
        if (!items.length) return body;
        return `<${tag}>${items.map(i => `<li>${i}</li>`).join('')}</${tag}>`;
    }

    html = html.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_, body) => buildList(body, 'ul'));
    html = html.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, (_, body) => buildList(body, 'ol'));
    html = html.replace(/(^|[^$])\\textbf\{([^}]*)\}/g, '$1<strong>$2</strong>');
    html = html.replace(/(^|[^$])\\textit\{([^}]*)\}/g, '$1<em>$2</em>');
    html = html.replace(/(^|[^$])\\underline\{([^}]*)\}/g, '$1<u>$2</u>');
    html = html.replace(/\\vspace\{([^}]+)\}/g, (_, val) => `<div style="height:${val};"></div>`);
    html = html.replace(/\n{2,}/g, '<br><br>');
    return html;
}

// Ensure renderQuestions displays instructions and includes instructions in MathJax typeset
function renderQuestions(q) {
    if (!q) return;
    const q1Text = document.getElementById('q1Text');
    const q2Text = document.getElementById('q2Text');
    const q3Text = document.getElementById('q3Text');
    const instructionsContent = document.getElementById('instructionsContent');

    if (instructionsContent) instructionsContent.innerHTML = formatRichText(q.instructions || '');
    if (q1Text) q1Text.innerHTML = formatRichText(q.q1_text || '');
    if (q2Text) q2Text.innerHTML = formatRichText(q.q2_text || '');
    if (q3Text) q3Text.innerHTML = formatRichText(q.q3_text || '');

    const q1Img = document.getElementById('q1Image');
    const q2Img = document.getElementById('q2Image');
    const q3Img = document.getElementById('q3Image');
    if (q1Img) {
        if (q.q1_image) {
            q1Img.src = q.q1_image;
            q1Img.style.display = 'block';
        } else {
            q1Img.style.display = 'none';
        }
    }
    if (q2Img) {
        if (q.q2_image) {
            q2Img.src = q.q2_image;
            q2Img.style.display = 'block';
        } else {
            q2Img.style.display = 'none';
        }
    }
    if (q3Img) {
        if (q.q3_image) {
            q3Img.src = q.q3_image;
            q3Img.style.display = 'block';
        } else {
            q3Img.style.display = 'none';
        }
    }

    if (window.MathJax && window.MathJax.typesetPromise) {
        setTimeout(() => {
            const toTypeset = [instructionsContent, q1Text, q2Text, q3Text].filter(Boolean);
            if (toTypeset.length) MathJax.typesetPromise(toTypeset).catch(() => { });
        }, 50);
    }
}
console.log('Student Portal Logic Loaded');

