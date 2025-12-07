const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        })
    });
}

function createTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    });
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { email } = req.body;
        console.log(`[Password Reset] Request received for: ${email}`);

        if (!email) {
            console.error('[Password Reset] Error: Email is missing from request body');
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check Gmail Config
        if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
            console.error('[Password Reset] Error: Gmail credentials missing in env vars');
            return res.status(500).json({ error: 'Server configuration error: Missing SMTP credentials' });
        }

        // Generate password reset link using Firebase Admin SDK
        console.log('[Password Reset] Generating link via Firebase Admin SDK...');

        // Determine return URL from request or default
        // const returnUrl = req.headers.origin || 'https://dpotd-app.firebaseapp.com';

        // Force the firebaseapp domain for now to ensure standard handler
        const actionCodeSettings = {
            url: 'https://dpotd-app.firebaseapp.com/student.html',
            handleCodeInApp: false
        };

        const link = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);
        console.log('[Password Reset] Link generated successfully:', link);

        // Send custom email via Nodemailer
        console.log(`[Password Reset] Creating transport for ${process.env.GMAIL_USER}...`);
        const transporter = createTransporter();

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <tr>
            <td style="background-color: #EA5A2F; padding: 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">D.PotD Password Reset</h1>
            </td>
        </tr>
        <tr>
            <td style="padding: 40px 30px;">
                <h2 style="color: #333; margin: 0 0 20px 0; font-size: 24px;">Reset Your Password</h2>
                <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                    We received a request to reset the password for your D.PotD account. Click the button below to set a new password.
                </p>
                
                <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                        <td align="center" style="padding: 20px 0;">
                            <a href="${link}" style="display: inline-block; padding: 15px 30px; background-color: #EA5A2F; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">Reset Password</a>
                        </td>
                    </tr>
                </table>
                
                <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 25px 0 0 0;">
                    If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="color: #EA5A2F; font-size: 12px; margin: 10px 0; word-break: break-all;">
                    ${link}
                </p>
                <p style="color: #999; font-size: 14px; margin: 30px 0 0 0;">
                    If you didn't request a password reset, you can safely ignore this email.
                </p>
            </td>
        </tr>
        <tr>
            <td style="background-color: #f8f9fa; padding: 25px 30px; text-align: center; border-top: 1px solid #e9ecef;">
                <p style="color: #999; font-size: 12px; margin: 0;">
                    D.PotD Support Team
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
        `;

        const mailOptions = {
            from: `D.PotD Support <${process.env.GMAIL_USER}>`,
            to: email,
            subject: 'D.PotD - Reset Your Password',
            html: html,
            text: `Reset your D.PotD password by visiting: ${link}`
        };

        console.log(`[Password Reset] Attempting to send email to ${email}...`);
        const info = await transporter.sendMail(mailOptions);
        console.log('[Password Reset] Email sent successfully. MessageID:', info.messageId);

        return res.status(200).json({ success: true, message: 'Password reset email sent' });

    } catch (error) {
        console.error('[Password Reset] CRITICAL ERROR:', error);

        // Return detailed error if possible for debugging (remove in prod if needed, but useful now)
        return res.status(500).json({
            error: error.message || 'Failed to send password reset email',
            details: error.toString()
        });
    }
};
