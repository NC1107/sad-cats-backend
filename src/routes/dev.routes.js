const express = require('express');
const { devLogin } = require('../controllers/dev.controller');

const router = express.Router();

// Hard guard: the entire dev router is invisible in production. Even if it were
// mounted by mistake, every route 404s when NODE_ENV === 'production'.
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// Mint a real JWT for the fixed dev user (no Discord OAuth). Seeds cards on
// first call so the Cats RPG surfaces have data.
router.post('/login', devLogin);

module.exports = router;
