import jwt from 'jsonwebtoken';
import { COOKIE_NAME } from '../routes/auth.js';

// Auth: verify cookie and attach req.user
export function requireAuth(req, res, next) {
    try {
        // CHANGED: support Authorization: Bearer <token> (mobile) + cookie (web)
        const authHeader = req.headers?.authorization || '';
        const bearerToken = authHeader.startsWith('Bearer ')
            ? authHeader.slice(7).trim()
            : null;

        const cookieToken  = req.cookies?.[COOKIE_NAME];

        // CHANGED: prefer bearer token if present, otherwise cookie
        const token = bearerToken || cookieToken;

        if (!token) {
            //console.log('[auth]  no token -> 401');
            return res.status(401).json({ error: 'Unauthenticated' });
        }


        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // payload must contain { id, email, role, name }
        req.user = payload;

        return next();
    } catch (err) {
        console.log('[auth] verify error:', err?.message);
        console.error('Auth error:', err.message);
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
}

// Role guard: super_admin always allowed
export function requireRole(roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    return (req, res, next) => {
        //console.log('[role] → check for', allowed, 'on', req.originalUrl);

        if (!req.user) {
            console.log('[role]  no req.user (auth not run?) -> 401');
            return res.status(401).json({ error: 'Unauthenticated' });
        }
        const role = req.user.role;
        //console.log('[role] user role:', role);

        if (role === 'super_admin' || allowed.includes(role)) {
            console.log('[role] ✅ allowed');
            return next();
        }
        console.log('[role] ❌ forbidden -> 403');
        return res.status(403).json({ error: 'Forbidden' });
    };
}

