const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Student = require('../models/Student');
const AuditLog = require('../models/AuditLog');
const { normalizeRole } = require('../config/permissions');

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign(
    { id },
    process.env.JWT_SECRET || 'college_student_profiling_jwt_secret_key_viva_2026_secure',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// @desc    Auth user & get token
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both email/register number and password',
      });
    }

    const input = email.trim().toLowerCase();

    // 1. Check for user by email or register number
    let user = await User.findOne({
      $or: [
        { email: input },
        { registerNumber: input },
        { registerNumber: input.toUpperCase() },
      ],
    }).select('+password');

    // Student accounts must be provisioned by SUPER_ADMIN through /api/users.
    if (!user) {
      const student = await Student.findOne({
        $or: [
          { 'personalDetails.registerNumber': input.toUpperCase() },
          { 'personalDetails.registerNumber': input },
          { 'personalDetails.institutionalEmail': input },
          { 'personalDetails.personalEmail': input },
        ],
      });

      if (student) {
        // Allow student login with password 'Student@123' or their register number
        if (password === 'Student@123' || password.toUpperCase() === student.personalDetails.registerNumber.toUpperCase()) {
          user = await User.findOne({ email: student.personalDetails.institutionalEmail }).select('+password');
        }
      }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. User does not exist.',
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Incorrect password.',
      });
    }

    // If student user has no studentProfileId, dynamically attach it
    if (user.role === 'student' && !user.studentProfileId) {
      const studentRec =
        (await Student.findOne({
          $or: [
            { 'personalDetails.registerNumber': user.registerNumber },
            { 'personalDetails.institutionalEmail': user.email },
          ],
        })) || (await Student.findOne());
      if (studentRec) {
        user.studentProfileId = studentRec._id;
        await User.findByIdAndUpdate(user._id, { studentProfileId: studentRec._id });
      }
    }

    const token = generateToken(user._id);

    // Audit log
    await AuditLog.create({
      userId: user._id,
      userName: user.name,
      userRole: user.role,
      action: 'LOGIN',
      details: `User ${user.email} (${user.role.toUpperCase()}) logged in successfully`,
      ipAddress: req.ip || req.connection.remoteAddress || '',
    });

    res.status(200).json({
      success: true,
      message: 'Logged in successfully',
      data: {
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: normalizeRole(user.role),
          department: user.department,
          registerNumber: user.registerNumber,
          studentProfileId: user.studentProfileId,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Logout user / clear audit
// @route   POST /api/auth/logout
// @access  Private
const logout = async (req, res, next) => {
  try {
    if (req.user) {
      await AuditLog.create({
        userId: req.user._id,
        userName: req.user.name,
        userRole: req.user.role,
        action: 'LOGOUT',
        details: `User ${req.user.email} logged out`,
        ipAddress: req.ip || req.connection.remoteAddress || '',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const responseUser = user.toObject();
    responseUser.role = normalizeRole(responseUser.role);
    res.status(200).json({
      success: true,
      data: responseUser,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { login, logout, getMe };
