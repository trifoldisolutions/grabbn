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
