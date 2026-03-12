// src/middleware/roles.js
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  next();
}

export function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];

  return (req, res, next) => {
    console.log('[role] → check for', allowed, 'on', req.originalUrl);
    if (!req.user) {
      console.log('[role] ❌ no req.user (auth not run?) -> 401');
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const role = req.user.role;
    console.log('[role] user role:', role);

    if (role === 'super_admin' || allowed.includes(role)) {
      console.log('[role] ✅ allowed');
      return next();
    }

    console.log('[role] ❌ forbidden -> 403');
    return res.status(403).json({ error: 'Forbidden' });
  };
}
