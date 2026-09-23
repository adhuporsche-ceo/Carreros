const bcrypt = require('bcryptjs');
const Settings = require('../models/Settings');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

const defaults = () => ({
  attendanceThreshold: Number(process.env.ATTENDANCE_ATTENTION_THRESHOLD || 75),
  cgpaThreshold: Number(process.env.CGPA_ATTENTION_THRESHOLD || 6.5),
});

const getSettings = async (req, res, next) => {
  try {
    let settings = await Settings.findOne().lean();
    if (!settings) settings = defaults();
    res.json({ success: true, data: settings });
  } catch (error) { next(error); }
};

const updateSettings = async (req, res, next) => {
  try {
    const values = {
      attendanceThreshold: Number(req.body.attendanceThreshold),
      cgpaThreshold: Number(req.body.cgpaThreshold),
    };
    if (!Number.isFinite(values.attendanceThreshold) || values.attendanceThreshold < 0 || values.attendanceThreshold > 100 ||
        !Number.isFinite(values.cgpaThreshold) || values.cgpaThreshold < 0 || values.cgpaThreshold > 10) {
      return res.status(400).json({ success: false, message: 'Threshold values are outside the allowed range.' });
    }
    const settings = await Settings.findOneAndUpdate({}, { ...values, updatedBy: req.user._id }, { new: true, upsert: true, setDefaultsOnInsert: true });
    await AuditLog.create({ userId: req.user._id, userName: req.user.name, action: 'UPDATE_SETTINGS', details: 'Updated mentor attention thresholds', ipAddress: req.ip });
    res.json({ success: true, data: settings, message: 'Settings saved.' });
  } catch (error) { next(error); }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: 'A current password and a new password of at least 6 characters are required.' });
    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    user.password = newPassword;
    await user.save();
    await AuditLog.create({ userId: req.user._id, userName: req.user.name, action: 'CHANGE_PASSWORD', details: 'Changed account password', ipAddress: req.ip });
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) { next(error); }
};

module.exports = { getSettings, updateSettings, changePassword };
