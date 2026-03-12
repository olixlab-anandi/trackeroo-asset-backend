// src/middleware/portalGuard.js
export function requirePortalAccess(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });

    const allowed = ['super_admin', 'admin', 'portal_user', 'portal_mobile_user'];
    if (allowed.includes(req.user.role)) return next();

    return res.status(403).json({ error: 'Access denied: portal not allowed for this role' });
  } catch (err) {
    console.error('[portalGuard] error:', err);
    return res.status(403).json({ error: 'Access denied' });
  }
}
