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
