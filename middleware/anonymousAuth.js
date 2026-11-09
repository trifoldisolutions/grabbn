// middleware/anonymousAuth.js
import crypto from 'crypto';
import geoip from 'geoip-lite';
import User from '../models/user.js';
import Bucket from '../models/bucket.js';
import { sendAccountSuspendedEmail, sendAccountDeletedEmail } from '../services/email.js';

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded ? forwarded.split(',')[0].trim() : (req.ip || '');
  return raw.replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6 prefix
}

function lookupRegion(req) {
  const ip = getClientIp(req);
  const geo = geoip.lookup(ip);
  if (!geo) {
    console.log(`[geo] ip=${ip} → no match`);
    return { country: null, region: null, city: null };
  }
  console.log(`[geo] ip=${ip} → ${geo.country} / ${geo.region} / ${geo.city}`);
  return { country: geo.country || null, region: geo.region || null, city: geo.city || null };
}

/**
 * Middleware to handle anonymous user sessions
 * Creates or retrieves anonymous user based on session token
 */
export async function anonymousAuth(req, res, next) {
  if (req.user) return next();
  try {
    // Check for existing session token in cookie or header
    const sessionToken =
      req.cookies?.anonymousId ||
      req.headers['x-anonymous-id'];

    let user;

    if (sessionToken) {
      // Try to find existing anonymous user
      user = await User.findOne({ anonymousId: sessionToken });
      
      if (user) {
        // Update last active timestamp
        await user.touch();
      }
    }

    // If no user found, create new anonymous user
    if (!user) {
      const newAnonymousId = crypto.randomUUID();
      const { country, region, city } = lookupRegion(req);

      user = await User.create({
        anonymousId: newAnonymousId,
        isAnonymous: true,
        country,
        region,
        city
      });
    } else if (!user.country) {
      // Lazy backfill for existing users created before geo tracking was added
      const { country, region, city } = lookupRegion(req);
      if (country) {
        user.country = country;
        user.region = region;
        user.city = city;
        await user.save();
      }
    }

    // Always refresh the cookie so existing users get the updated SameSite attribute.
    // SameSite=None + Secure is required for the cookie to be sent from cross-site
    // iframes (e.g. the bookmarklet popup embedded on third-party pages).
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('anonymousId', user.anonymousId, {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
    });

    // Attach user to request object
    req.user = user;
    req.anonymousId = user.anonymousId;

    next();
  } catch (error) {
    console.error('Anonymous auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional: Middleware to require authentication
 */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

const TWO_HOURS_MS   = 2  * 60 * 60 * 1000;
const SEVENTY_HRS_MS = 70 * 60 * 60 * 1000;

/**
 * Middleware to block registered users who have not verified their email.
 * Applies lazy suspension (at 2h) and deletion (at 2h+70h) logic.
 * Anonymous users are always passed through.
 */
export async function requireVerification(req, res, next) {
  // Anonymous users and already-verified users pass through
  if (!req.user || req.user.isAnonymous || req.user.isEmailVerified) return next();

  const user = req.user;
  const now = Date.now();

  try {
    if (user.accountSuspendedAt) {
      if (now - user.accountSuspendedAt.getTime() > SEVENTY_HRS_MS) {
        const email = user.email;
        await Bucket.deleteMany({ userId: user._id });
        await User.findByIdAndDelete(user._id);
        await sendAccountDeletedEmail(email);
        res.clearCookie('anonymousId');
        return res.status(403).json({
          code: 'ACCOUNT_DELETED',
          error: 'Your account has been permanently deleted because your email was not verified. Please sign up again.'
        });
      }
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        email: user.email,
        error: 'Your account is suspended. Please verify your email address to regain access.'
      });
    }

    if (now - new Date(user.createdAt).getTime() > TWO_HOURS_MS) {
      user.accountSuspendedAt = new Date();
      await user.save();
      await sendAccountSuspendedEmail(user.email);
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        email: user.email,
        error: 'Your account has been suspended because your email was not verified within 2 hours. You have 70 hours to verify before your account is deleted.'
      });
    }

    return res.status(403).json({
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email,
      error: 'Please verify your email to continue. Check your inbox for the verification code sent at signup.'
    });
  } catch (error) {
    console.error('requireVerification error:', error);
    return res.status(500).json({ error: 'Verification check failed' });
  }
}