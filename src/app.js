require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const passport = require('./config/passport');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const logger = require('./utils/logger');

// Import routes
const authRoutes = require('./routes/auth.routes');
const scoresRoutes = require('./routes/scores.routes');
const healthRoutes = require('./routes/health.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const bossRoutes = require('./routes/boss.routes');
const adminRoutes = require('./routes/admin.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const collectionRoutes = require('./routes/collection.routes');
const rpgRoutes = require('./routes/rpg.routes');

const app = express();

// Trust proxy (for rate limiting and IP logging behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://sad-cats.org',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Cookie parsing middleware
app.use(cookieParser());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Initialize Passport
app.use(passport.initialize());

// Request logging — skip health checks, debug for success, warn for errors
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip
    });
  });
  next();
});

// Routes (each route file applies its own rate limiter)
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/scores', scoresRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/boss', bossRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/collection', collectionRoutes);
app.use('/api/rpg', rpgRoutes);

// Dev-only auth backdoor (mint a JWT without Discord OAuth). Double-gated:
// not mounted in production, and the router itself 404s if NODE_ENV is production.
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/dev', require('./routes/dev.routes'));
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Sad Cats API',
    version: '1.0.0',
    status: 'running'
  });
});

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

module.exports = app;
