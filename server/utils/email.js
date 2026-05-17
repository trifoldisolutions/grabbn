import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendOtpEmail(toEmail, code) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Your Grabbn verification code</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Use the code below to complete your sign-in. It expires in 10 minutes.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <div style="display: inline-block; background: #f3e8ff; border: 2px solid #a21caf;
                        border-radius: 12px; padding: 20px 40px;">
                <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #a21caf;">
                    ${code}
                </span>
            </div>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            If you didn't request this code, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Your Grabbn verification code',
        html
    });
}

export async function sendAccountSuspendedEmail(toEmail) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Your Grabbn account has been suspended</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Your account was suspended because your email address was not verified within 2 hours of signing up.
        </p>
        <p style="color: #4b5563; line-height: 1.6;">
            You have <strong>70 hours</strong> to verify your email before your account is permanently deleted.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <a href="${process.env.APP_URL || 'http://localhost:3000'}/v2/login"
               style="background-color: #a21caf; color: white; padding: 12px 32px;
                      text-decoration: none; border-radius: 6px; font-weight: 600;
                      display: inline-block;">
                Verify My Email
            </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            Click the button above, then request a new verification code on the login page.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Action required: verify your Grabbn email',
        html
    });
}

export async function sendAccountDeletedEmail(toEmail) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Your Grabbn account has been deleted</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Your Grabbn account has been permanently deleted because your email address was not verified
            within the required timeframe.
        </p>
        <p style="color: #4b5563; line-height: 1.6;">
            You are welcome to sign up again at any time.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Your Grabbn account has been deleted',
        html
    });
}

export async function sendPartnerApprovedEmail(toEmail) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">You're a Grabbn Partner</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Your application has been reviewed and approved. You now have full access to the Grabbn Partner Program.
        </p>
        <p style="color: #4b5563; line-height: 1.6;">
            Your revenue share begins from today. You can manage your ad and monetization settings from within any bucket you own.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <a href="${process.env.APP_URL || 'http://localhost:3000'}/showroom"
               style="background-color: #a21caf; color: white; padding: 12px 32px;
                      text-decoration: none; border-radius: 6px; font-weight: 600;
                      display: inline-block;">
                Go to Grabbn
            </a>
        </div>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: "You're a Grabbn Partner",
        html
    });
}

export async function sendPartnerRejectedEmail(toEmail, reason) {
    const reasonBlock = reason
        ? `<p style="color: #4b5563; line-height: 1.6;"><strong>Reason:</strong> ${reason}</p>`
        : '';

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Partner application not approved</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Thank you for applying to the Grabbn Partner Program. After review, we're unable to approve your application at this time.
        </p>
        ${reasonBlock}
        <p style="color: #4b5563; line-height: 1.6;">
            You're welcome to continue using Grabbn and re-apply in the future.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Your Grabbn Partner application',
        html
    });
}

export async function sendDataExportEmail(toEmail, downloadUrl) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Your Grabbn data export is ready</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            Your data export has been prepared. Click the button below to download your archive.
            This link expires in 7 days.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <a href="${downloadUrl}"
               style="background-color: #a21caf; color: white; padding: 12px 32px;
                      text-decoration: none; border-radius: 6px; font-weight: 600;
                      display: inline-block;">
                Download your data
            </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            The archive contains your account information, buckets, grabs, and followers.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Your Grabbn data export is ready',
        html
    });
}

export async function sendPasswordResetEmail(toEmail, resetUrl) {
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Reset Your Password</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            We received a request to reset the password for your Grabbn account.
            Click the button below to choose a new password.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <a href="${resetUrl}"
               style="background-color: #a21caf; color: white; padding: 12px 32px;
                      text-decoration: none; border-radius: 6px; font-weight: 600;
                      display: inline-block;">
                Reset Password
            </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Reset your Grabbn password',
        html
    });
}

export async function sendAccountDeletionEmail(toEmail) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1f2937; margin-bottom: 16px;">Your Grabbn account has been deleted</h2>
        <p style="color: #4b5563; line-height: 1.6;">
            We've received your request to delete your Grabbn account. Your account is now closed.
        </p>
        <p style="color: #4b5563; line-height: 1.6;">
            <strong>Changed your mind?</strong> You can log back in within <strong>90 days</strong> to
            fully recover your account and all your data.
        </p>
        <div style="text-align: center; margin: 32px 0;">
            <a href="${appUrl}/login"
               style="background-color: #a21caf; color: white; padding: 12px 32px;
                      text-decoration: none; border-radius: 6px; font-weight: 600;
                      display: inline-block;">
                Recover My Account
            </a>
        </div>
        <p style="color: #4b5563; line-height: 1.6;">
            You also have the right to request permanent deletion of your personal data at any time
            under GDPR Article 17. To exercise this right, visit your account settings after logging back in,
            or <a href="${appUrl}/contact" style="color: #a21caf;">contact us</a> directly.
        </p>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            If you do not log back in within 90 days, your account will be permanently closed.
            Your data will be retained until you request its deletion.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">Grabbn &bull; Link Grabber</p>
    </div>`;

    await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: toEmail,
        subject: 'Your Grabbn account has been deleted',
        html
    });
}

// ── Notification emails ───────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function notifBase(body) {
    return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">${body}<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"><p style="color:#9ca3af;font-size:12px;">Grabbn &bull; <a href="${APP_URL}/settings/notifications" style="color:#9ca3af;">Manage notifications</a></p></div>`;
}

function notifBtn(href, label) {
    return `<div style="text-align:center;margin:28px 0;"><a href="${href}" style="background-color:#a21caf;color:white;padding:11px 28px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;">${label}</a></div>`;
}

export async function sendNotificationEmail(type, toEmail, data) {
    const subjects = {
        new_follower:         `${data.followerUsername} followed you on Grabbn`,
        bucket_grabbed:       `${data.grabberUsername} grabbed your bucket`,
        bucket_unlocked:      `Someone unlocked "${data.bucketName}"`,
        new_bucket_published: `${data.curatorUsername} published a new bucket`,
        comment_mention:      `${data.commenterUsername} mentioned you in a comment`,
        comment_reply:        `${data.replierUsername} replied to your comment`,
        new_dm:               `New message from ${data.senderUsername}`,
    };

    const bodies = {
        new_follower: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">New follower</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.followerUsername}</strong> started following you.</p>
             ${notifBtn(`${APP_URL}/@${data.followerUsername}`, 'View profile')}`
        ),
        bucket_grabbed: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">Bucket grabbed</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.grabberUsername}</strong> grabbed your bucket <strong>${data.bucketName}</strong>.</p>
             ${notifBtn(`${APP_URL}/bucket/${data.bucketId}`, 'View bucket')}`
        ),
        bucket_unlocked: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">Bucket unlocked</h2>
             <p style="color:#4b5563;line-height:1.6;">Someone unlocked your bucket <strong>${data.bucketName}</strong> and you earned <strong>${data.creditsEarned} credits</strong>.</p>
             ${notifBtn(`${APP_URL}/bucket/${data.bucketId}`, 'View bucket')}`
        ),
        new_bucket_published: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">New bucket from ${data.curatorUsername}</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.curatorUsername}</strong> just published a new bucket: <strong>${data.bucketName}</strong>.</p>
             ${notifBtn(`${APP_URL}/bucket/${data.bucketId}`, 'Check it out')}`
        ),
        comment_mention: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">You were mentioned</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.commenterUsername}</strong> mentioned you in a comment on <strong>${data.bucketName}</strong>:</p>
             <blockquote style="border-left:3px solid #e5e7eb;margin:16px 0;padding:8px 16px;color:#6b7280;font-style:italic;">${data.snippet}</blockquote>
             ${notifBtn(`${APP_URL}/bucket/${data.bucketId}`, 'View comment')}`
        ),
        comment_reply: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">New reply to your comment</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.replierUsername}</strong> replied to your comment on <strong>${data.bucketName}</strong>:</p>
             <blockquote style="border-left:3px solid #e5e7eb;margin:16px 0;padding:8px 16px;color:#6b7280;font-style:italic;">${data.snippet}</blockquote>
             ${notifBtn(`${APP_URL}/bucket/${data.bucketId}`, 'View reply')}`
        ),
        new_dm: notifBase(
            `<h2 style="color:#1f2937;margin-bottom:16px;">New message</h2>
             <p style="color:#4b5563;line-height:1.6;"><strong>${data.senderUsername}</strong> sent you a message:</p>
             <blockquote style="border-left:3px solid #e5e7eb;margin:16px 0;padding:8px 16px;color:#6b7280;font-style:italic;">${data.preview}</blockquote>
             ${notifBtn(`${APP_URL}/messages`, 'Reply')}`
        ),
    };

    const subject = subjects[type];
    const html    = bodies[type];
    if (!subject || !html) return;

    await resend.emails.send({ from: process.env.RESEND_FROM, to: toEmail, subject, html });
}

// Fire-and-forget: fetch recipient's email + pref, send if opted in.
export async function maybeSendNotificationEmail(userId, type, data) {
    try {
        const User = (await import('../models/user.js')).default;
        const user = await User.findById(userId).select('email emailNotificationPrefs').lean();
        if (!user?.email) return;
        if (user.emailNotificationPrefs?.[type] !== true) return;
        await sendNotificationEmail(type, user.email, data);
    } catch (err) {
        console.error(`[email] maybeSendNotificationEmail ${type}:`, err);
    }
}
