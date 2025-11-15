const express = require('express');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const router = express.Router();

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'admin@anocab.com' && password === 'password123') {
    const token = generateToken('admin_user_id');
    return res.json({ message: 'Login successful', token });
  }
  return res.status(401).json({ message: 'Invalid credentials' });
});

module.exports = router;

