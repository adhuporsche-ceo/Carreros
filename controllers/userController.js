const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { ROLES } = require('../config/permissions');

const listUsers = async (req, res, next) => {
  try {
    const users = await User.find().select('-password').sort({ name: 1 }).lean();
    res.json({ success: true, data: users });
  } catch (error) { next(error); }
};

const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role, department, registerNumber, studentProfileId } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ success: false, message: 'Name, email, password, and role are required.' });
    if (!Object.values(ROLES).includes(role) || role === ROLES.SUPER_ADMIN && req.user.role !== ROLES.SUPER_ADMIN) return res.status(400).json({ success: false, message: 'Invalid or restricted role.' });
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    const user = await User.create({ name, email, password, role, department, registerNumber, studentProfileId });
    await AuditLog.create({ userId: req.user._id, userName: req.user.name, userRole: req.user.role, action: 'USER_CREATED', details: `Created ${role} user ${user.email}`, ipAddress: req.ip || '' });
    res.status(201).json({ success: true, message: 'User created successfully.', data: user.toObject({ transform: (_, value) => { delete value.password; return value; } }) });
  } catch (error) { next(error); }
};

const updateUser = async (req, res, next) => {
  try {
    const updates = {};
    ['name', 'department', 'registerNumber', 'studentProfileId', 'role'].forEach((field) => { if (req.body[field] !== undefined) updates[field] = req.body[field]; });
    if (updates.role && !Object.values(ROLES).includes(updates.role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    await AuditLog.create({ userId: req.user._id, userName: req.user.name, userRole: req.user.role, action: 'USER_UPDATED', details: `Updated user ${user.email}`, ipAddress: req.ip || '' });
    res.json({ success: true, data: user });
  } catch (error) { next(error); }
};

module.exports = { listUsers, createUser, updateUser };
