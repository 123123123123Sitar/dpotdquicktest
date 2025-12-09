// D.PotD Enhanced Admin Portal Logic
// Features: AI Grading, Multi-Grader System, Email Notifications

const firestore = firebase.firestore();
const appAuth = firebase.auth();
const secondaryApp = firebase.apps.find(app => app.name === 'secondary') || firebase.initializeApp(firebase.apps[0].options, 'secondary');
const secondaryAuth = secondaryApp.auth();

let cachedSubmissions = [];
let filteredSubmissions = [];
let currentSubmissionIndex = 0;
let latexUpdateTimers = {};
let isAuthenticated = false;
let adminCredentials = { email: '', password: '' };
let cachedGraders = [];
let gradingStats = { pending: 0, assigned: 0, ai_graded: 0, human_graded: 0 };
let rawSubmissions = [];

async function getAdminEmails() {
    if (window._dpotd_adminEmails) return window._dpotd_adminEmails;
    const set = new Set();
    try {
        const snap = await firestore.collection('users').where('isAdmin', '==', true).get();
        snap.forEach(doc => { const e = doc.data().email; if (e) set.add(e.toLowerCase()); });
        window._dpotd_adminEmails = set;
    } catch (e) { console.warn('getAdminEmails failed', e); }
    return set;
}

// Auth
appAuth.onAuthStateChanged(async (user) => {
    if (!user) {
        isAuthenticated = false;
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('adminPanel').style.display = 'none';
        return;
    }
    let data = null;
    let userDoc = await firestore.collection('users').doc(user.uid).get();
    if (userDoc.exists) data = userDoc.data();
    if (!data || data.isAdmin !== true) {
        try {
            const settingsDoc = await firestore.collection('settings').doc('appSettings').get();
            const settingsEmail = settingsDoc.exists ? settingsDoc.data().adminEmail : '';
            if (settingsEmail && settingsEmail.toLowerCase() === (user.email || '').toLowerCase()) data = { isAdmin: true };
        } catch (e) { }
    }
    if (!data || data.isAdmin !== true) {
        document.getElementById('loginError').textContent = 'Not authorized';
        document.getElementById('loginError').style.display = 'block';
        await appAuth.signOut();
        return;
    }
    isAuthenticated = true;
    adminCredentials.email = user.email || '';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    loadQuestions();
    loadSettings();
    loadGradingStats();
});

async function checkPassword() {
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    const loginError = document.getElementById('loginError');
    loginError.style.display = 'none';
    try {
        await appAuth.signInWithEmailAndPassword(email, password);
        adminCredentials = { email, password };
    } catch (err) {
        loginError.textContent = err.message || 'Login failed';
        loginError.style.display = 'block';
    }
}

function handlePasswordKeyPress(event) { if (event.key === 'Enter') checkPassword(); }

// Helpers
function showStatus(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = 'status ' + type;
    el.style.display = 'block';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function formatMinutes(seconds) {
    return (Number(seconds || 0) / 60).toFixed(2) + ' min';
}

function generateStrongPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let password = 'A1a'; // Ensure at least one upper, one number, one lower
    for (let i = 0; i < 7; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (btn) btn.classList.add('active');
    const content = document.getElementById(tabName);
    if (content) content.classList.add('active');
    if (tabName === 'questions') loadQuestions();
    if (tabName === 'schedule') loadSchedule();
    if (tabName === 'settings') loadSettings();
    if (tabName === 'users') loadUsers();
    if (tabName === 'submissions') loadSubmissions();
    if (tabName === 'leaderboard') loadLeaderboard();
    if (tabName === 'graders') loadGraders();
}

// AI Grading
async function aiGradeSubmission(submissionId) {
    const sub = cachedSubmissions.find(s => s.id === submissionId);
    if (!sub) return alert('Submission not found');
    showStatus('submissionsStatus', 'AI is grading...', 'info');
    try {
        const questionDoc = await firestore.collection('questions').doc('day' + sub.day).get();
        const rubric = questionDoc.exists ? questionDoc.data().q3Rubric : [];
        const questionText = questionDoc.exists ? questionDoc.data().q3Text : '';
        const response = await fetch('/api/grade-submission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q3Answer: sub.q3_answer, rubric: rubric, questionText: questionText })
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);
        await firestore.collection('submissions').doc(submissionId).update({
            aiScore: result.score, q3Score: result.score, aiFeedback: result.feedback, q3Feedback: result.feedback, aiConfidence: result.confidence,
            gradingStatus: 'ai_graded', aiGradedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Update cached submission so save/notify work without refresh
        if (sub) {
            sub.q3_score = result.score;
            sub.q3_feedback = result.feedback;
            sub.gradingStatus = 'ai_graded';
        }
        const scoreEl = document.getElementById('score_' + submissionId);
        const feedbackEl = document.getElementById('feedback_latex_' + submissionId);
        if (scoreEl) scoreEl.value = result.score;
        if (feedbackEl) feedbackEl.value = result.feedback;
        updateLatexPreview(submissionId);
        showStatus('submissionsStatus', 'AI graded: ' + result.score + '/10 (' + result.confidence + ' confidence)', 'success');
    } catch (error) {
        showStatus('submissionsStatus', 'AI grading failed: ' + error.message, 'error');
    }
}

async function bulkAIGrade() {
    const pending = cachedSubmissions.filter(s => !s.q3_score && s.q3_answer);
    if (pending.length === 0) return alert('No pending submissions to grade');
    if (!confirm('AI grade ' + pending.length + ' pending submissions?')) return;
    let graded = 0, failed = 0;
    for (const sub of pending) {
        try { await aiGradeSubmission(sub.id); graded++; } catch (e) { failed++; }
        showStatus('submissionsStatus', 'Grading ' + (graded + failed) + '/' + pending.length + '...', 'info');
    }
    showStatus('submissionsStatus', 'Done! Graded: ' + graded + ', Failed: ' + failed, 'success');
    loadSubmissions();
}

// Grader Management
async function loadGraders() {
    if (!isAuthenticated) return;
    const container = document.getElementById('gradersContainer');
    if (!container) return;
    container.innerHTML = '<p style="color:#666;">Loading graders...</p>';
    try {
        const snap = await firestore.collection('users').where('isGrader', '==', true).get();
        cachedGraders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (cachedGraders.length === 0) {
            container.innerHTML = '<p style="color:#666;">No graders found. Add a grader below.</p>';
            return;
        }
        let html = '<div class="graders-list">';
        for (const grader of cachedGraders) {
            const workload = await getGraderWorkload(grader.id);
            html += '<div class="submission-card"><div style="display:flex;justify-content:space-between;align-items:center;"><div>';
            html += '<h3 style="margin:0;">' + escapeHtml(grader.name) + '</h3>';
            html += '<p style="color:#666;">' + escapeHtml(grader.email) + '</p>';
            html += '<p style="font-size:14px;">Assigned: ' + workload.assigned + ' | Completed: ' + workload.completed + '</p>';
            html += '</div><button class="btn-secondary" onclick="removeGrader(\'' + grader.id + '\')">Remove</button></div></div>';
        }
        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = '<p style="color:#dc3545;">Error loading graders</p>';
    }
}

async function getGraderWorkload(graderId) {
    try {
        const assigned = await firestore.collection('submissions').where('assignedGrader', '==', graderId).where('gradingStatus', '==', 'assigned').get();
        const completed = await firestore.collection('submissions').where('assignedGrader', '==', graderId).where('gradingStatus', '==', 'human_graded').get();
        return { assigned: assigned.size, completed: completed.size };
    } catch (e) { return { assigned: 0, completed: 0 }; }
}

async function addGrader() {
    const name = document.getElementById('newGraderName').value.trim();
    const email = document.getElementById('newGraderEmail').value.trim();
    if (!name || !email) return alert('Please fill name and email');
    const tempPassword = generateStrongPassword();
    try {
        const newUser = await secondaryAuth.createUserWithEmailAndPassword(email, tempPassword);
        await firestore.collection('users').doc(newUser.user.uid).set({
            name: name, email: email, isAdmin: false, isGrader: true,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await secondaryAuth.sendPasswordResetEmail(email);

        // Send custom grader welcome email via Gmail SMTP
        let emailSent = false;
        try {
            const response = await fetch('/api/send-notification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentEmail: email,
                    studentName: name,
                    type: 'grader_welcome'
                })
            });
            const result = await response.json();
            if (result.success) {
                emailSent = true;
                console.log('Grader welcome email sent:', result.messageId);
            } else {
                console.error('Grader email API error:', result.error);
            }
        } catch (emailErr) {
            console.error('Grader email failed:', emailErr);
        }

        alert('Grader created!' + (emailSent ? ' Welcome email sent.' : ' (Custom email failed - check console)'));
        document.getElementById('newGraderName').value = '';
        document.getElementById('newGraderEmail').value = '';
        loadGraders();
    } catch (error) { alert('Error: ' + error.message); }
}

async function removeGrader(graderId) {
    if (!confirm('Remove grader role from this user?')) return;
    try {
        await firestore.collection('users').doc(graderId).update({ isGrader: false });
        loadGraders();
    } catch (error) { alert('Error: ' + error.message); }
}

async function autoAssignSubmissions() {
    if (cachedGraders.length === 0) return alert('No graders available');
    const pending = cachedSubmissions.filter(s =>
        (!s.gradingStatus || s.gradingStatus === 'pending') &&
        s.gradingStatus !== 'human_graded' &&
        s.gradingStatus !== 'ai_graded' &&
        s.gradingStatus !== 'assigned'
    );
    if (pending.length === 0) return alert('No pending submissions');
    if (!confirm('Assign ' + pending.length + ' submissions to ' + cachedGraders.length + ' graders?')) return;
    let idx = 0;
    for (const sub of pending) {
        const grader = cachedGraders[idx % cachedGraders.length];
        await firestore.collection('submissions').doc(sub.id).update({
            assignedGrader: grader.id, assignedGraderName: grader.name, gradingStatus: 'assigned',
            assignedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        idx++;
    }
    alert('Assigned ' + pending.length + ' submissions');
    loadSubmissions();
    loadGradingStats();
}

// Email Notifications
async function sendNotification(submissionId) {
    const sub = cachedSubmissions.find(s => s.id === submissionId);
    if (!sub) return alert('Submission not found');
    if (!sub.q3_score) return alert('Grade submission first');
    const q1Points = sub.q1_correct ? 4 : 0;
    const q2Points = sub.q2_correct ? 6 : 0;
    const totalScore = q1Points + q2Points + parseInt(sub.q3_score || 0);
    try {
        const response = await fetch('/api/send-notification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentEmail: sub.studentEmail, studentName: sub.studentName,
                day: sub.day, score: totalScore, totalPossible: 20, type: 'feedback_ready'
            })
        });
        const result = await response.json();
        if (!result.success) throw new Error(result.error);
        await firestore.collection('submissions').doc(submissionId).update({
            notificationSent: true, notificationSentAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert('Notification sent!');
    } catch (error) { alert('Failed to send: ' + error.message); }
}

async function sendBulkNotifications() {
    const graded = cachedSubmissions.filter(s => s.q3_score && !s.notificationSent);
    if (graded.length === 0) return alert('No graded submissions pending notification');
    if (!confirm('Send notifications to ' + graded.length + ' students?')) return;
    let sent = 0;
    for (const sub of graded) {
        try { await sendNotification(sub.id); sent++; } catch (e) { }
    }
    alert('Sent ' + sent + '/' + graded.length + ' notifications');
}

// Grading Stats
async function loadGradingStats() {
    try {
        const snap = await firestore.collection('submissions').get();
        gradingStats = { pending: 0, assigned: 0, ai_graded: 0, human_graded: 0 };
        snap.forEach(doc => {
            const status = doc.data().gradingStatus || 'pending';
            if (gradingStats[status] !== undefined) gradingStats[status]++;
            else gradingStats.pending++;
        });
        updateStatsDisplay();
    } catch (e) { }
}

function updateStatsDisplay() {
    const el = document.getElementById('gradingStatsDisplay');
    if (!el) return;
    el.innerHTML = '<div class="stats-grid">' +
        '<div class="stat-card"><span class="stat-value">' + gradingStats.pending + '</span><span class="stat-label">Pending</span></div>' +
        '<div class="stat-card"><span class="stat-value">' + gradingStats.assigned + '</span><span class="stat-label">Assigned</span></div>' +
        '<div class="stat-card"><span class="stat-value">' + gradingStats.ai_graded + '</span><span class="stat-label">AI Graded</span></div>' +
        '<div class="stat-card"><span class="stat-value">' + gradingStats.human_graded + '</span><span class="stat-label">Completed</span></div>' +
        '</div>';
}

// Questions
async function loadQuestions() {
    if (!isAuthenticated) return;
    const dayEl = document.getElementById('questionDay');
    const day = dayEl ? dayEl.value : '1';
    try {
        const doc = await firestore.collection('questions').doc('day' + day).get();
        const data = doc.exists ? doc.data() : {};
        function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }
        setVal('instructions', data.instructions);
        setVal('q1Text', data.q1Text);
        setVal('q1Answer', data.q1Answer);
        setVal('q2Text', data.q2Text);
        setVal('q2Answer', data.q2Answer);
        setVal('q3Text', data.q3Text);
        setVal('q3Answer', data.q3Answer);
        ['q1', 'q2', 'q3'].forEach(function (q, i) {
            const imgData = data[q + 'Image'];
            const dataEl = document.getElementById(q + 'ImageData');
            const preview = document.getElementById(q + 'ImagePreview');
            if (dataEl) dataEl.value = imgData || '';
            if (preview) preview.innerHTML = imgData ? '<img src="' + imgData + '" alt="Q' + (i + 1) + '">' : '';
        });
        if (typeof renderRubricEditor === 'function') {
            let rubric = data.q3Rubric || [];
            if (typeof rubric === 'string') rubric = [{ title: '', columns: ['Rubric'], rows: [[rubric]] }];
            renderRubricEditor(Array.isArray(rubric) ? rubric : []);
        }
    } catch (e) { showStatus('questionStatus', 'Error: ' + e.message, 'error'); }
}

async function saveQuestions() {
    if (!isAuthenticated) return;
    const dayEl = document.getElementById('questionDay');
    const day = dayEl ? dayEl.value : '1';
    function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
    const rubric = typeof collectRubricData === 'function' ? collectRubricData() : [];
    const payload = {
        day: Number(day), instructions: getVal('instructions'),
        q1Text: getVal('q1Text'), q1Answer: getVal('q1Answer'), q1Image: getVal('q1ImageData'),
        q2Text: getVal('q2Text'), q2Answer: getVal('q2Answer'), q2Image: getVal('q2ImageData'),
        q3Text: getVal('q3Text'), q3Answer: getVal('q3Answer'), q3Image: getVal('q3ImageData'),
        q3Rubric: rubric
    };
    try {
        await firestore.collection('questions').doc('day' + day).set(payload, { merge: true });
        showStatus('questionStatus', 'Questions saved.', 'success');
    } catch (e) { showStatus('questionStatus', 'Error: ' + e.message, 'error'); }
}

// Schedule
function formatDateTimeLocal(date) {
    if (!date) return '';
    function pad(n) { return String(n).padStart(2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

async function loadSchedule() {
    if (!isAuthenticated) return;
    try {
        for (let i = 1; i <= 5; i++) {
            const doc = await firestore.collection('schedule').doc('day' + i).get();
            const openTime = doc.exists && doc.data().openTime ? doc.data().openTime.toDate() : null;
            const el = document.getElementById('day' + i);
            if (el) el.value = formatDateTimeLocal(openTime);
        }
        // Attach auto-fill listener to Day 1
        const d1 = document.getElementById('day1');
        if (d1) {
            d1.removeEventListener('change', autoFillSchedule); // avoid dupes
            d1.addEventListener('change', autoFillSchedule);
        }
    } catch (e) { showStatus('scheduleStatus', 'Error: ' + e.message, 'error'); }
}

function autoFillSchedule() {
    const d1 = document.getElementById('day1');
    if (!d1 || !d1.value) return;
    const date1 = new Date(d1.value);

    for (let i = 2; i <= 5; i++) {
        const nextDate = new Date(date1.getTime() + (i - 1) * 24 * 60 * 60 * 1000);
        const el = document.getElementById('day' + i);
        if (el) el.value = formatDateTimeLocal(nextDate);
    }
}

async function saveSchedule() {
    if (!isAuthenticated) return;
    try {
        const batch = firestore.batch();
        for (let i = 1; i <= 5; i++) {
            const el = document.getElementById('day' + i);
            const val = el ? el.value : '';
            if (!val) continue;
            const ref = firestore.collection('schedule').doc('day' + i);
            batch.set(ref, { day: i, openTime: firebase.firestore.Timestamp.fromDate(new Date(val)) }, { merge: true });
        }
        await batch.commit();
        showStatus('scheduleStatus', 'Schedule saved.', 'success');
    } catch (e) { showStatus('scheduleStatus', 'Error: ' + e.message, 'error'); }
}

// Settings
async function loadSettings() {
    if (!isAuthenticated) return;
    try {
        const doc = await firestore.collection('settings').doc('appSettings').get();
        const data = doc.exists ? doc.data() : {};
        function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }
        setVal('testDuration', data.testDuration || 120);
        setVal('adminName', data.adminName);
        setVal('adminEmail', data.adminEmail);
    } catch (e) { showStatus('settingsStatus', 'Error: ' + e.message, 'error'); }
}

async function saveSettings() {
    if (!isAuthenticated) return;
    try {
        const td = document.getElementById('testDuration');
        const an = document.getElementById('adminName');
        const ae = document.getElementById('adminEmail');
        await firestore.collection('settings').doc('appSettings').set({
            testDuration: Number(td ? td.value : 120) || 120,
            adminName: an ? an.value : '',
            adminEmail: ae ? ae.value : ''
        }, { merge: true });
        showStatus('settingsStatus', 'Settings saved.', 'success');
    } catch (e) { showStatus('settingsStatus', 'Error: ' + e.message, 'error'); }
}

// Users (Students only - filter out admins and graders)
async function loadUsers() {
    if (!isAuthenticated) return;
    const container = document.getElementById('usersContainer');
    if (!container) return;
    container.innerHTML = '<p style="color:#666;">Loading users...</p>';
    try {
        const snap = await firestore.collection('users').get();
        const students = snap.docs.filter(doc => {
            const data = doc.data();
            return !data.isAdmin && !data.isGrader;
        });
        if (students.length === 0) { container.innerHTML = '<p>No students found.</p>'; return; }
        container.innerHTML = '';
        students.forEach(function (doc) {
            const user = doc.data();
            const card = document.createElement('div');
            card.className = 'submission-card';
            card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div><h3 style="margin:0;">' + escapeHtml(user.name) + '</h3><p style="color:#666;">' + escapeHtml(user.email) + '</p></div>' +
                '<button class="btn-secondary" onclick="deleteUser(\'' + doc.id + '\')">Delete</button></div>';
            container.appendChild(card);
        });
    } catch (e) { showStatus('usersStatus', 'Error: ' + e.message, 'error'); }
}

async function addUser() {
    const nameEl = document.getElementById('newUserName');
    const emailEl = document.getElementById('newUserEmail');
    const name = nameEl ? nameEl.value.trim() : '';
    const email = emailEl ? emailEl.value.trim() : '';
    if (!name || !email) return alert('Please fill name and email');
    const tempPassword = generateStrongPassword();
    try {
        const newUser = await secondaryAuth.createUserWithEmailAndPassword(email, tempPassword);
        await firestore.collection('users').doc(newUser.user.uid).set({
            name: name, email: email, isAdmin: false, isGrader: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await secondaryAuth.sendPasswordResetEmail(email);
        alert('User created. Password reset email sent.');
        if (nameEl) nameEl.value = '';
        if (emailEl) emailEl.value = '';
        loadUsers();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteUser(userId) {
    if (!confirm('Delete this user?')) return;
    try {
        await firestore.collection('users').doc(userId).delete();
        loadUsers();
    } catch (e) { alert('Error: ' + e.message); }
}

// Submissions
async function loadSubmissions() {
    if (!isAuthenticated) return;
    const container = document.getElementById('submissionsContainer');
    if (container) container.innerHTML = '<p style="color:#666;">Loading...</p>';
    try {
        const adminEmails = await getAdminEmails();
        const snap = await firestore.collection('submissions').orderBy('timestamp', 'desc').get();
        cachedSubmissions = snap.docs.map(function (doc) {
            const d = doc.data();
            return {
                id: doc.id, timestamp: d.timestamp ? d.timestamp.toDate() : null,
                studentName: d.studentName || '', studentEmail: d.studentEmail || '', day: d.day,
                q1_answer: d.q1Answer || '', q2_answer: d.q2Answer || '', q3_answer: d.q3Answer || '',
                q1_correct: !!d.q1Correct, q2_correct: !!d.q2Correct,
                q1_time: d.q1Time || 0, q2_time: d.q2Time || 0, q3_time: d.q3Time || 0,
                totalTime: d.totalTime || 0, exitCount: d.exitCount || 0,
                q3_score: d.q3Score, q3_feedback: d.q3Feedback, gradingStatus: d.gradingStatus,
                assignedGrader: d.assignedGrader, notificationSent: d.notificationSent
            };
        }).filter(function (s) { return !adminEmails.has((s.studentEmail || '').toLowerCase()); });
        filterSubmissions();
        loadGradingStats();
    } catch (e) { showStatus('submissionsStatus', 'Error: ' + e.message, 'error'); }
}

function filterSubmissions() {
    const dayEl = document.getElementById('filterDay');
    const studentEl = document.getElementById('filterStudent');
    const dayFilter = dayEl ? dayEl.value : 'all';
    const studentFilter = studentEl ? studentEl.value : 'all';
    filteredSubmissions = cachedSubmissions.filter(function (s) {
        const dayMatch = dayFilter === 'all' || s.day == dayFilter;
        const studentMatch = studentFilter === 'all' || s.studentEmail === studentFilter;
        return dayMatch && studentMatch;
    });
    currentSubmissionIndex = 0;
    populateSubmissionSelector();
    displayCurrentSubmission();
}

function populateSubmissionSelector() {
    const selector = document.getElementById('submissionSelector');
    if (!selector) return;
    selector.innerHTML = '';
    filteredSubmissions.forEach(function (sub, i) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = sub.studentName + ' - Day ' + sub.day;
        selector.appendChild(opt);
    });
}

function selectSubmission() {
    const selector = document.getElementById('submissionSelector');
    currentSubmissionIndex = parseInt(selector ? selector.value : 0);
    displayCurrentSubmission();
}

function navigateSubmission(dir) {
    currentSubmissionIndex = Math.max(0, Math.min(filteredSubmissions.length - 1, currentSubmissionIndex + dir));
    const selector = document.getElementById('submissionSelector');
    if (selector) selector.value = currentSubmissionIndex;
    displayCurrentSubmission();
}

function updateLatexPreview(rowKey) {
    if (latexUpdateTimers[rowKey]) clearTimeout(latexUpdateTimers[rowKey]);
    latexUpdateTimers[rowKey] = setTimeout(function () {
        const input = document.getElementById('feedback_latex_' + rowKey);
        const preview = document.getElementById('feedback_preview_' + rowKey);
        if (!input || !preview) return;
        let content = input.value.replace(/\\documentclass\{[^}]+\}/g, '').replace(/\\usepackage\{[^}]+\}/g, '');
        const docMatch = content.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/);
        if (docMatch) content = docMatch[1].trim();
        preview.innerHTML = content || '<p style="color:#999;">Preview here</p>';
        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetClear([preview]);
            MathJax.typesetPromise([preview]).catch(function () { });
        }
    }, 500);
}

function displayCurrentSubmission() {
    const container = document.getElementById('submissionsContainer');
    const sub = filteredSubmissions[currentSubmissionIndex];
    if (!sub || !container) { if (container) container.innerHTML = '<p>No submissions.</p>'; return; }
    const q1P = sub.q1_correct ? 4 : 0;
    const q2P = sub.q2_correct ? 6 : 0;
    const total = q1P + q2P + parseInt(sub.q3_score || 0);
    const id = sub.id;
    const statusBadge = sub.gradingStatus === 'human_graded' ? 'Graded' : (sub.gradingStatus === 'ai_graded' ? 'AI Graded' : 'Pending');

    // Clean LaTeX for display
    let cleanAnswer = sub.q3_answer || '';
    cleanAnswer = cleanAnswer.replace(/\\documentclass(\[[^\]]*\])?\{[^}]+\}/g, '')
        .replace(/\\usepackage(\[[^\]]*\])?\{[^}]+\}/g, '')
        .replace(/\\begin\{document\}/g, '')
        .replace(/\\end\{document\}/g, '')
        .trim();
    if (!cleanAnswer) cleanAnswer = 'No answer provided';

    container.innerHTML = '<div class="submission-card" style="margin-top: 20px;">' +
        '<div class="submission-header" style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #eee;">' +
        '<h3>Day ' + sub.day + '</h3><span class="graded-badge ' + (sub.q3_score ? 'graded' : 'pending') + '">' + statusBadge + '</span></div>' +
        '<div class="submission-details">' +
        '<div class="detail-item"><span class="detail-label">Student:</span> ' + escapeHtml(sub.studentName) + ' (' + escapeHtml(sub.studentEmail) + ')</div>' +
        '<div class="detail-item"><span class="detail-label">Time:</span> ' + formatMinutes(sub.totalTime) + '</div>' +
        '<div class="detail-item"><span class="detail-label">Total:</span> ' + total + '/20</div>' +
        '</div>' +
        '<div class="question-group"><h3>Q1</h3><p>' + (escapeHtml(sub.q1_answer) || 'No answer') + '</p><p><strong>' + (sub.q1_correct ? 'Correct (+4)' : 'Incorrect') + '</strong></p></div>' +
        '<div class="question-group"><h3>Q2</h3><p>' + (escapeHtml(sub.q2_answer) || 'No answer') + '</p><p><strong>' + (sub.q2_correct ? 'Correct (+6)' : 'Incorrect') + '</strong></p></div>' +
        '<div class="question-group"><h3>Q3 (Proof)</h3>' +
        '<div id="adminStudentAnswer_' + id + '" class="answer-text" style="background:#f9f9f9; padding:15px; border-radius:4px; margin-bottom:15px; white-space:pre-wrap; border:1px solid #eee;">' +
        cleanAnswer +
        '</div>' +
        '<div class="latex-editor-container">' +
        '<div class="latex-input-section"><h4>Score (0-10)</h4><input type="number" id="score_' + id + '" min="0" max="10" value="' + (sub.q3_score || '') + '">' +
        '<h4>Feedback (LaTeX)</h4><textarea id="feedback_latex_' + id + '" oninput="updateLatexPreview(\'' + id + '\')">' + (sub.q3_feedback || '') + '</textarea></div>' +
        '<div class="latex-preview-section"><h4>Preview</h4><div id="feedback_preview_' + id + '" class="preview-content">' + (sub.q3_feedback || '') + '</div></div>' +
        '</div>' +
        '<div class="feedback-actions">' +
        '<button class="btn" onclick="aiGradeSubmission(\'' + id + '\')">AI Grade</button>' +
        '<button class="btn" onclick="saveFeedback(\'' + id + '\')">Save Feedback</button>' +
        '<button class="btn" onclick="sendNotification(\'' + id + '\')">Notify</button>' +
        '</div></div></div>';

    // Trigger MathJax
    if (window.MathJax && window.MathJax.typesetPromise) {
        // Typeset both the student answer and the feedback preview
        const toTypeset = [document.getElementById('adminStudentAnswer_' + id)];
        const fbPreview = document.getElementById('feedback_preview_' + id);
        if (fbPreview) toTypeset.push(fbPreview);

        MathJax.typesetPromise(toTypeset).catch(function (err) { console.log('MathJax error', err); });
    } else if (sub.q3_feedback) {
        // Fallback for just preview update if MathJax not fully ready/structured
        setTimeout(function () { updateLatexPreview(id); }, 100);
    }
}

async function saveFeedback(docId) {
    const scoreEl = document.getElementById('score_' + docId);
    const feedbackEl = document.getElementById('feedback_latex_' + docId);
    const score = parseInt(scoreEl ? scoreEl.value : '');
    const feedback = feedbackEl ? feedbackEl.value : '';
    if (isNaN(score) || score < 0 || score > 10) return alert('Score must be 0-10');
    try {
        await firestore.collection('submissions').doc(docId).update({
            q3Score: score, q3Feedback: feedback, gradingStatus: 'human_graded',
            humanGradedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert('Saved!');
        loadSubmissions();
    } catch (e) { alert('Error: ' + e.message); }
}

async function overrideScore(docId, qNum, isCorrect) {
    if (!confirm('Mark Q' + qNum + ' as ' + (isCorrect ? 'correct' : 'incorrect') + '?')) return;
    const field = qNum === 1 ? 'q1Correct' : 'q2Correct';
    try {
        await firestore.collection('submissions').doc(docId).update({ [field]: isCorrect });
        loadSubmissions();
    } catch (e) { alert('Error: ' + e.message); }
}

// Leaderboard
async function loadLeaderboard() {
    if (!isAuthenticated) return;
    const container = document.getElementById('leaderboardContainer');
    if (container) container.innerHTML = '<p style="color:#666;">Loading...</p>';
    try {
        const adminEmails = await getAdminEmails();
        const snap = await firestore.collection('submissions').get();
        rawSubmissions = snap.docs.map(function (doc) {
            const d = doc.data();
            return {
                email: (d.studentEmail || '').toLowerCase(), name: d.studentName || '',
                q1: d.q1Correct ? 4 : 0, q2: d.q2Correct ? 6 : 0, q3: parseInt(d.q3Score || 0),
                totalTime: d.totalTime || 0, day: d.day
            };
        }).filter(function (s) { return !adminEmails.has(s.email); });
        renderLeaderboardTable();
    } catch (e) { if (container) container.innerHTML = '<p style="color:#dc3545;">Error loading</p>'; }
}

function renderLeaderboardTable() {
    const container = document.getElementById('leaderboardContainer');
    if (!container) return;
    const byStudent = {};
    rawSubmissions.forEach(function (s) {
        if (!byStudent[s.email]) byStudent[s.email] = { name: s.name, email: s.email, total: 0, time: 0, days: 0 };
        byStudent[s.email].total += s.q1 + s.q2 + s.q3;
        byStudent[s.email].time += s.totalTime;
        byStudent[s.email].days++;
    });
    const arr = Object.values(byStudent).sort(function (a, b) { return b.total - a.total || a.time - b.time; });
    if (arr.length === 0) { container.innerHTML = '<p>No submissions.</p>'; return; }
    let html = '<table class="leaderboard-table"><thead><tr><th>Rank</th><th>Name</th><th>Total</th><th>Time</th><th>Days</th></tr></thead><tbody>';
    arr.forEach(function (e, i) {
        html += '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(e.name) + '</td><td>' + e.total + '</td><td>' + formatMinutes(e.time) + '</td><td>' + e.days + '</td></tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

function exportToCSV() {
    if (cachedSubmissions.length === 0) return alert('No data');
    const headers = ['Name', 'Email', 'Day', 'Q1', 'Q2', 'Q3', 'Total', 'Time'];
    const rows = cachedSubmissions.map(function (s) {
        const q1P = s.q1_correct ? 4 : 0;
        const q2P = s.q2_correct ? 6 : 0;
        const q3P = parseInt(s.q3_score || 0);
        return [s.studentName, s.studentEmail, s.day, q1P, q2P, q3P, q1P + q2P + q3P, (s.totalTime / 60).toFixed(2)];
    });
    const csv = [headers.join(',')].concat(rows.map(function (r) { return r.join(','); })).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'submissions.csv';
    a.click();
}

// Image upload helper
function handleImageUpload(slot) {
    const fileInput = document.getElementById('q' + slot + 'Image');
    const dataInput = document.getElementById('q' + slot + 'ImageData');
    const preview = document.getElementById('q' + slot + 'ImagePreview');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    const reader = new FileReader();
    reader.onload = function () {
        if (dataInput) dataInput.value = reader.result;
        if (preview) preview.innerHTML = '<img src="' + reader.result + '" alt="Q' + slot + '">';
    };
    reader.readAsDataURL(fileInput.files[0]);
}

// Rubric Editor Logic
function renderRubricEditor(rubricData) {
    const container = document.getElementById('rubricEditorContainer');
    if (!container) return;

    // Ensure rubricData is an array
    if (!Array.isArray(rubricData)) rubricData = [];

    let html = '<div class="rubric-editor">';
    html += '<div id="rubricItems">';

    if (rubricData.length === 0) {
        // Add one empty row by default if empty
        rubricData.push({ criteria: '', points: '' });
    }

    rubricData.forEach((item, index) => {
        html += createRubricRow(index, item.criteria, item.points);
    });

    html += '</div>';
    html += '<button class="btn-secondary" style="margin-top:10px;font-size:14px;" onclick="addRubricRow()">+ Add Criteria</button>';
    html += '</div>';

    container.innerHTML = html;
}

function createRubricRow(index, criteria, points) {
    return `
        <div class="rubric-row" style="display:flex;gap:10px;margin-bottom:10px;align-items:center;">
            <input type="text" class="rubric-criteria" placeholder="Criteria description (e.g. 'Correct proof logic')" value="${escapeHtml(criteria || '')}" style="flex:3;">
            <input type="number" class="rubric-points" placeholder="Pts" value="${points || ''}" style="width:70px;">
            <button class="btn-secondary" style="padding:5px 10px;color:#dc3545;border-color:#dc3545;" onclick="removeRubricRow(this)">X</button>
        </div>
    `;
}

function addRubricRow() {
    const container = document.getElementById('rubricItems');
    if (container) {
        const div = document.createElement('div');
        div.innerHTML = createRubricRow(Date.now(), '', ''); // Use timestamp as temp index
        container.appendChild(div.firstElementChild);
    }
}

function removeRubricRow(btn) {
    btn.parentElement.remove();
}

function collectRubricData() {
    const rows = document.querySelectorAll('.rubric-row');
    const rubric = [];
    rows.forEach(row => {
        const criteria = row.querySelector('.rubric-criteria').value.trim();
        const points = row.querySelector('.rubric-points').value.trim();
        if (criteria || points) {
            rubric.push({ criteria, points });
        }
    });
    return rubric;
}

// Expose functions globally for inline onclick handlers
window.addRubricRow = addRubricRow;
window.removeRubricRow = removeRubricRow;
window.renderRubricEditor = renderRubricEditor;
window.collectRubricData = collectRubricData;
