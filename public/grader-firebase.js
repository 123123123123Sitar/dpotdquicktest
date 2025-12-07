// D.PotD Grader Portal Logic

const firestore = firebase.firestore();
const appAuth = firebase.auth();

let currentGrader = null;
let assignedSubmissions = [];
let currentSubmissionIndex = 0;
let latexUpdateTimer = null;

// Auth
appAuth.onAuthStateChanged(async function (user) {
    if (!user) {
        currentGrader = null;
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('graderPanel').style.display = 'none';
        return;
    }

    // Check if user is a grader
    try {
        console.log('Checking grader status for user:', user.uid, user.email);
        const userDoc = await firestore.collection('users').doc(user.uid).get();

        if (!userDoc.exists) {
            console.error('User document does not exist for:', user.uid);
            document.getElementById('loginError').textContent = 'User profile not found';
            document.getElementById('loginError').style.display = 'block';
            await appAuth.signOut();
            return;
        }

        const userData = userDoc.data();
        console.log('User data:', userData);

        // Check if grader OR admin (admins can also use grader portal)
        if (!userData.isGrader && !userData.isAdmin) {
            console.error('User is not a grader:', userData);
            document.getElementById('loginError').textContent = 'Not authorized as grader';
            document.getElementById('loginError').style.display = 'block';
            await appAuth.signOut();
            return;
        }

        currentGrader = {
            uid: user.uid,
            email: user.email,
            name: userData.name || user.email
        };

        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('graderPanel').style.display = 'block';
        document.getElementById('graderName').textContent = 'Welcome, ' + currentGrader.name;
        loadQueue();
        loadStats();
    } catch (e) {
        console.error('Auth error:', e);
        document.getElementById('loginError').textContent = 'Error checking credentials: ' + e.message;
        document.getElementById('loginError').style.display = 'block';
    }
});

async function login() {
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    const loginError = document.getElementById('loginError');
    loginError.style.display = 'none';

    if (!email || !password) {
        loginError.textContent = 'Please enter email and password';
        loginError.style.display = 'block';
        return;
    }

    try {
        await appAuth.signInWithEmailAndPassword(email, password);
    } catch (err) {
        loginError.textContent = err.message || 'Login failed';
        loginError.style.display = 'block';
    }
}

function logout() {
    appAuth.signOut();
}

// Load grader's assigned submissions
async function loadQueue() {
    if (!currentGrader) return;
    const container = document.getElementById('queueContainer');
    container.innerHTML = '<p style="color:#666;text-align:center;">Loading your queue...</p>';

    try {
        // Get submissions assigned to this grader
        const snap = await firestore.collection('submissions')
            .where('assignedGrader', '==', currentGrader.uid)
            .where('gradingStatus', 'in', ['assigned', 'ai_graded'])
            .get();

        assignedSubmissions = snap.docs.map(function (doc) {
            const d = doc.data();
            return {
                id: doc.id,
                studentName: d.studentName || '',
                studentEmail: d.studentEmail || '',
                day: d.day,
                q3_answer: d.q3Answer || '',
                aiScore: d.aiScore,
                aiFeedback: d.aiFeedback,
                gradingStatus: d.gradingStatus,
                timestamp: d.timestamp ? d.timestamp.toDate() : null
            };
        });

        if (assignedSubmissions.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>All caught up!</h3><p>No submissions currently assigned to you.</p></div>';
            return;
        }

        renderQueue();
    } catch (e) {
        console.error('Load queue failed:', e);
        container.innerHTML = '<p style="color:#dc3545;text-align:center;">Error loading queue</p>';
    }
}

function renderQueue() {
    const container = document.getElementById('queueContainer');
    let html = '';

    assignedSubmissions.forEach(function (sub, index) {
        const statusBadge = sub.gradingStatus === 'ai_graded'
            ? '<span class="badge ai-graded">AI Graded</span>'
            : '<span class="badge assigned">Pending</span>';

        html += '<div class="submission-card">';
        html += '<div class="submission-header">';
        html += '<h3>' + escapeHtml(sub.studentName) + ' - Day ' + sub.day + '</h3>';
        html += statusBadge;
        html += '</div>';

        // Strip boilerplate for preview
        let previewText = sub.q3_answer || '';
        previewText = previewText.replace(/\\documentclass\{[^}]+\}/g, '')
            .replace(/\\usepackage\{[^}]+\}/g, '')
            .replace(/\\begin\{document\}/g, '')
            .replace(/\\end\{document\}/g, '')
            .trim();
        // Truncate if too long
        if (previewText.length > 100) previewText = previewText.substring(0, 100) + '...';

        html += '<p style="color:#666; font-size: 14px; margin-bottom: 10px;">' + escapeHtml(previewText || 'No answer provided') + '</p>';
        if (sub.aiScore !== undefined) {
            html += '<p style="color:#0c5460;margin-bottom:10px;">AI suggested score: <strong>' + sub.aiScore + '/10</strong></p>';
        }

        html += '<button class="btn" onclick="openGrading(' + index + ')">Grade This Submission</button>';
        html += '</div>';
    });

    container.innerHTML = html;
}

function openGrading(index) {
    currentSubmissionIndex = index;
    const sub = assignedSubmissions[index];
    const container = document.getElementById('queueContainer');

    let html = '<div class="submission-card">';
    html += '<div class="submission-header">';
    html += '<h3>' + escapeHtml(sub.studentName) + ' - Day ' + sub.day + '</h3>';
    html += '<button class="btn-secondary" onclick="renderQueue()">← Back to Queue</button>';
    html += '</div>';

    // Question 3 Answer
    html += '<div class="question-group">';
    html += '<h4>Q3 Student Answer (Proof/Explanation)</h4>';
    // Strip boilerplate for full view display
    let cleanAnswer = sub.q3_answer || 'No answer provided';
    cleanAnswer = cleanAnswer.replace(/\\documentclass\{[^}]+\}/g, '')
        .replace(/\\usepackage\{[^}]+\}/g, '')
        .replace(/\\begin\{document\}/g, '')
        .replace(/\\end\{document\}/g, '')
        .trim();

    html += '<div class="answer-text" id="studentAnswer" style="min-height: 100px; padding: 15px; background: #fff; border: 1px solid #ddd; border-radius: 4px;">' + cleanAnswer + '</div>';
    html += '</div>';

    // AI Suggestion (if available)
    if (sub.aiScore !== undefined) {
        html += '<div class="rubric-display">';
        html += '<h5>AI Suggestion</h5>';
        html += '<p><strong>Score:</strong> ' + sub.aiScore + '/10</p>';
        if (sub.aiFeedback) {
            html += '<p style="margin-top:10px;"><strong>AI Feedback:</strong></p>';
            html += '<div style="background:white;padding:10px;border-radius:4px;margin-top:5px;">' + sub.aiFeedback + '</div>';
        }
        html += '</div>';
    }

    // Grading Section
    html += '<div class="grading-section">';
    html += '<h4>Your Grading</h4>';
    html += '<div class="form-group">';
    html += '<label for="gradeScore">Score (0-10):</label>';
    html += '<input type="number" id="gradeScore" min="0" max="10" value="' + (sub.aiScore || '') + '">';
    html += '</div>';
    html += '<div class="form-group">';
    html += '<label for="gradeFeedback">Feedback (LaTeX supported):</label>';
    html += '<textarea id="gradeFeedback" oninput="updatePreview()" style="min-height: 150px; font-family: monospace;">' + (sub.aiFeedback || '') + '</textarea>';
    html += '</div>';
    html += '</div>'; // End grading-section

    // Separate Feedback Preview Card
    html += '<div class="submission-card" style="margin-top: 20px; border-left: 4px solid #17a2b8;">';
    html += '<h4 style="color: #17a2b8; margin-bottom: 15px;">Feedback Preview</h4>';
    html += '<div class="latex-preview" id="feedbackPreview" style="min-height: 100px; padding: 15px; background: #f8f9fa; border-radius: 4px;">' + (sub.aiFeedback || 'Preview will appear here...') + '</div>';

    html += '<div class="action-buttons" style="margin-top: 25px; display: flex; gap: 15px;">';
    html += '<button class="btn" style="flex: 1;" onclick="submitGrade(\'' + sub.id + '\')">Submit Grade</button>';
    html += '<button class="btn-secondary" style="flex: 1;" onclick="renderQueue()">Cancel & Return to Queue</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;

    // Typeset MathJax
    if (window.MathJax && window.MathJax.typesetPromise) {
        MathJax.typesetPromise([document.getElementById('studentAnswer')]).catch(function () { });
        MathJax.typesetPromise([document.getElementById('feedbackPreview')]).catch(function () { });
    }
}

function updatePreview() {
    if (latexUpdateTimer) clearTimeout(latexUpdateTimer);
    latexUpdateTimer = setTimeout(function () {
        const input = document.getElementById('gradeFeedback');
        const preview = document.getElementById('feedbackPreview');
        if (!input || !preview) return;

        let content = input.value;
        content = content.replace(/\\documentclass\{[^}]+\}/g, '');
        content = content.replace(/\\usepackage\{[^}]+\}/g, '');
        const docMatch = content.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/);
        if (docMatch) content = docMatch[1].trim();

        preview.innerHTML = content || 'Preview will appear here...';

        if (window.MathJax && window.MathJax.typesetPromise) {
            MathJax.typesetClear([preview]);
            MathJax.typesetPromise([preview]).catch(function () { });
        }
    }, 500);
}

async function submitGrade(submissionId) {
    const scoreEl = document.getElementById('gradeScore');
    const feedbackEl = document.getElementById('gradeFeedback');
    const score = parseInt(scoreEl ? scoreEl.value : '');
    const feedback = feedbackEl ? feedbackEl.value : '';

    if (isNaN(score) || score < 0 || score > 10) {
        alert('Please enter a valid score between 0 and 10');
        return;
    }

    if (!feedback.trim()) {
        alert('Please provide feedback for the student');
        return;
    }

    try {
        // Fetch submission first to get student details for email
        const subDoc = await firestore.collection('submissions').doc(submissionId).get();
        if (!subDoc.exists) throw new Error("Submission not found");
        const subData = subDoc.data();

        await firestore.collection('submissions').doc(submissionId).update({
            q3Score: score,
            q3Feedback: feedback,
            gradingStatus: 'human_graded',
            gradedBy: currentGrader.uid,
            gradedByName: currentGrader.name,
            humanGradedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Send email notification with calculated total score
        const q1Score = subData.q1Correct ? 4 : 0;
        const q2Score = subData.q2Correct ? 6 : 0;
        const totalScore = q1Score + q2Score + score;

        fetch('/api/send-notification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'submission_graded',
                studentEmail: subData.studentEmail,
                studentName: subData.studentName,
                day: subData.day,
                score: totalScore,
                totalPossible: 20
            })
        }).catch(err => console.error("Failed to send notification:", err));

        alert('Grade submitted successfully!');
        loadQueue();
        loadStats();
    } catch (e) {
        alert('Error submitting grade: ' + e.message);
    }
}

async function loadStats() {
    if (!currentGrader) return;

    try {
        // Assigned count
        const assignedSnap = await firestore.collection('submissions')
            .where('assignedGrader', '==', currentGrader.uid)
            .where('gradingStatus', 'in', ['assigned', 'ai_graded'])
            .get();
        document.getElementById('assignedCount').textContent = assignedSnap.size;

        // Completed count
        const completedSnap = await firestore.collection('submissions')
            .where('gradedBy', '==', currentGrader.uid)
            .get();
        document.getElementById('completedCount').textContent = completedSnap.size;

        // Today count
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todaySnap = await firestore.collection('submissions')
            .where('gradedBy', '==', currentGrader.uid)
            .get();
        // Filter in memory to avoid needing a composite index
        let todayCount = 0;
        todaySnap.forEach(doc => {
            const d = doc.data();
            if (d.humanGradedAt && d.humanGradedAt.toDate() >= today) {
                todayCount++;
            }
        });
        document.getElementById('todayCount').textContent = todayCount;
    } catch (e) {
        console.error('Load stats failed:', e);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
