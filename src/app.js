import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import morgan from 'morgan';
import { ENV } from './env.js';

import auth from './routes/auth.js';
import health from './routes/health.js';
import importsRouter from './routes/imports.js';
import assetsRouter from './routes/assets.js';
import locationsRouter from './routes/locations.js';
import issuesRouter from './routes/issues.js';
import movementsRouter from './routes/movements.js';
import userRouter from './routes/users.js';
import dashboardRoutes from './routes/dashboard.js';
import auditRouter from './routes/audit.js';
import settingsRouter from './routes/settings.js';
import externalLocationRouter from './routes/externalLocations.js';
import syncRouter from './routes/sync.js'




import { requireAuth } from './middleware/authz.js';
import { requirePortalAccess } from './middleware/portalGuard.js';

const app = express();

app.disable('x-powered-by');

// Always-on health endpoint (works even if health router changes)
app.get(['/health', '/api/health'], (req, res) => {
  res.type('text/plain').status(200).send('ok');
});


const allowedOrigins = [
  process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  process.env.MOBILE_ORIGIN || 'http://localhost:8081',
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow server-to-server, Postman, etc.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
// app.use(cors({
//   origin: FRONTEND_ORIGIN,
//   credentials: true,
// }));
app.use(express.json());
app.use(cookieParser());
app.use(morgan(ENV.NODE_ENV === 'production' ? 'combined' : 'dev'));

// simple request logger (temporary)
app.use((req, res, next) => {
  //console.log(`[API] ${req.method} ${req.url}`);
  next();
});


// root ping
app.get('/__ok', (req, res) => {
  res.json({ ok: true, scope: 'root' });
});

app.use('/health', health);
app.use('/auth', auth);
app.use('/imports', requireAuth, requirePortalAccess, importsRouter);
app.use('/assets', requireAuth, requirePortalAccess, assetsRouter);
app.use('/locations', requireAuth, requirePortalAccess, locationsRouter);
app.use('/issues', requireAuth, requirePortalAccess, issuesRouter);
app.use('/movements', requireAuth, requirePortalAccess, movementsRouter);
app.use('/users', requireAuth, requirePortalAccess, userRouter);
app.use('/dashboard', requireAuth, requirePortalAccess, dashboardRoutes);
app.use('/audits', requireAuth, requirePortalAccess, auditRouter);
app.use('/settings', requireAuth, requirePortalAccess, settingsRouter);
app.use('/external-locations', requireAuth, requirePortalAccess, externalLocationRouter);
app.use('/sync', requireAuth, requirePortalAccess, syncRouter);

export default app;
