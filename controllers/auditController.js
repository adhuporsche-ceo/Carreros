const AuditLog = require('../models/AuditLog');
const Student = require('../models/Student');
const { ROLES } = require('../config/permissions');

// @desc    Get audit logs with search, action filter, pagination (Admin only)
// @route   GET /api/audit-logs
// @access  Private (Admin)
const getAuditLogs = async (req, res, next) => {
  try {
    const { action, search, page = 1, limit = 20 } = req.query;
    const query = {};
    if (req.user.role === ROLES.PLACEMENT_COORDINATOR) query.userId = req.user._id;
    if (req.user.role === ROLES.HOD) {
      const students = await Student.find({ 'personalDetails.department': String(req.user.department || '').toUpperCase() }).select('_id').lean();
      query.$or = [{ userId: req.user._id }, { studentId: { $in: students.map((student) => student._id) } }];
    }

    if (action && action.trim() !== '') {
      query.action = action.trim();
    }

    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { userName: searchRegex },
        { studentName: searchRegex },
        { studentRegisterNumber: searchRegex },
        { details: searchRegex },
      ];
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum) || 1,
        limit: limitNum,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAuditLogs };
