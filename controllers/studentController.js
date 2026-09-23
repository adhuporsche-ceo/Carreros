const Student = require('../models/Student');
const AuditLog = require('../models/AuditLog');
const { calculateProfileCompletion } = require('../services/profileCompletionService');
const { calculateAcademicTrend, evaluateMentorAttention } = require('../services/insightService');
const { analyzeSkillGap } = require('../services/skillGapService');
const { ROLES } = require('../config/permissions');

const editableStudentFields = [
  'personalDetails', 'familyDetails', 'semesters', 'arrears',
  'technicalProfile', 'selfEvaluation', 'careerGoal', 'mentorInterventions',
  'consent', 'mentorId',
];

const studentScope = (req) => {
  const query = {};
  if (!(req.user.role === ROLES.SUPER_ADMIN && req.query.includeDeleted === 'true')) query.deletedAt = null;
  if (req.user.role === ROLES.HOD) query['personalDetails.department'] = req.user.department.toUpperCase();
  if (req.user.role === ROLES.FACULTY_MENTOR) query.mentorId = req.user._id;
  return query;
};

const canAccessStudent = (student, req) => {
  if ([ROLES.SUPER_ADMIN, ROLES.PLACEMENT_COORDINATOR].includes(req.user.role)) return true;
  if (req.user.role === ROLES.HOD) return student.personalDetails.department === String(req.user.department || '').toUpperCase();
  return req.user.role === ROLES.FACULTY_MENTOR && String(student.mentorId || '') === String(req.user._id);
};

const auditDiff = (before, after) => ({
  before: before.toObject ? before.toObject() : before,
  after: after.toObject ? after.toObject() : after,
});

const emitStudentEvent = (req, event, student) => {
  const io = req.app.get('io');
  if (!io || !student) return;
  const payload = { id: student._id, department: student.personalDetails.department, mentorId: student.mentorId || null };
  io.to('role:SUPER_ADMIN').to('role:PLACEMENT_COORDINATOR').to(`dept:${student.personalDetails.department}`).emit(event, payload);
  if (student.mentorId) io.to(`mentor:${student.mentorId}`).emit(event, payload);
  io.emit('eligibility:updated', payload);
};

// @desc    Get all students with search, filters, sorting, pagination
// @route   GET /api/students
// @access  Private
const getStudents = async (req, res, next) => {
  try {
    const {
      search,
      department,
      section,
      category,
      careerGoal,
      arrearStatus,
      minCgpa,
      maxCgpa,
      minAttendance,
      sortBy,
      page = 1,
      limit = 10,
    } = req.query;

    const query = studentScope(req);

    // Search by Name or Register Number
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { 'personalDetails.name': searchRegex },
        { 'personalDetails.registerNumber': searchRegex },
      ];
    }

    // Filter by Department
    if (department && department.trim() !== '' && ![ROLES.HOD, ROLES.FACULTY_MENTOR].includes(req.user.role)) {
      query['personalDetails.department'] = department.trim().toUpperCase();
    }

    // Filter by Section
    if (section && section.trim() !== '') {
      query['personalDetails.section'] = section.trim().toUpperCase();
    }

    // Filter by Category
    if (category && category.trim() !== '') {
      query['personalDetails.category'] = category.trim();
    }

    // Filter by Career Goal
    if (careerGoal && careerGoal.trim() !== '') {
      query['careerGoal.primaryGoal'] = careerGoal.trim();
    }

    // Filter by Arrear Status
    if (arrearStatus && arrearStatus.trim() !== '') {
      if (arrearStatus === 'Pending') {
        query['arrears.status'] = 'Pending';
      } else if (arrearStatus === 'Cleared') {
        query['arrears.status'] = 'Cleared';
      } else if (arrearStatus === 'None') {
        query.arrears = { $size: 0 };
      }
    }

    // Execute query with lean()
    let students = await Student.find(query).lean();

    // In-memory filter for computed metrics (CGPA, Attendance, etc.)
    if (minCgpa !== undefined && minCgpa !== '') {
      const minVal = parseFloat(minCgpa);
      students = students.filter((s) => {
        const latestSem = s.semesters && s.semesters.length > 0 ? s.semesters[s.semesters.length - 1] : null;
        return latestSem ? latestSem.cgpa >= minVal : false;
      });
    }

    if (maxCgpa !== undefined && maxCgpa !== '') {
      const maxVal = parseFloat(maxCgpa);
      students = students.filter((s) => {
        const latestSem = s.semesters && s.semesters.length > 0 ? s.semesters[s.semesters.length - 1] : null;
        return latestSem ? latestSem.cgpa <= maxVal : false;
      });
    }

    if (minAttendance !== undefined && minAttendance !== '') {
      const minAtt = parseFloat(minAttendance);
      students = students.filter((s) => {
        const latestSem = s.semesters && s.semesters.length > 0 ? s.semesters[s.semesters.length - 1] : null;
        return latestSem ? latestSem.attendance >= minAtt : false;
      });
    }

    // Sorting
    if (sortBy) {
      switch (sortBy) {
        case 'name-asc':
          students.sort((a, b) => a.personalDetails.name.localeCompare(b.personalDetails.name));
          break;
        case 'name-desc':
          students.sort((a, b) => b.personalDetails.name.localeCompare(a.personalDetails.name));
          break;
        case 'cgpa-desc':
          students.sort((a, b) => {
            const cgpaA = a.semesters && a.semesters.length ? a.semesters[a.semesters.length - 1].cgpa : 0;
            const cgpaB = b.semesters && b.semesters.length ? b.semesters[b.semesters.length - 1].cgpa : 0;
            return cgpaB - cgpaA;
          });
          break;
        case 'cgpa-asc':
          students.sort((a, b) => {
            const cgpaA = a.semesters && a.semesters.length ? a.semesters[a.semesters.length - 1].cgpa : 0;
            const cgpaB = b.semesters && b.semesters.length ? b.semesters[b.semesters.length - 1].cgpa : 0;
            return cgpaA - cgpaB;
          });
          break;
        case 'attendance-desc':
          students.sort((a, b) => {
            const attA = a.semesters && a.semesters.length ? a.semesters[a.semesters.length - 1].attendance : 0;
            const attB = b.semesters && b.semesters.length ? b.semesters[b.semesters.length - 1].attendance : 0;
            return attB - attA;
          });
          break;
        case 'arrears-desc':
          students.sort((a, b) => {
            const arrA = a.arrears ? a.arrears.filter((arr) => arr.status === 'Pending').length : 0;
            const arrB = b.arrears ? b.arrears.filter((arr) => arr.status === 'Pending').length : 0;
            return arrB - arrA;
          });
          break;
        default:
          students.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
    } else {
      students.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    const totalCount = students.length;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = pageNum * limitNum;
    const paginatedStudents = students.slice(startIndex, endIndex);

    // Map summary fields and completion score
    const result = paginatedStudents.map((s) => {
      const sortedSems = s.semesters ? [...s.semesters].sort((a, b) => b.semesterNumber - a.semesterNumber) : [];
      const latestSem = sortedSems[0] || null;
      const pendingArrearsCount = s.arrears ? s.arrears.filter((arr) => arr.status === 'Pending').length : 0;
      const completion = calculateProfileCompletion(s);

      return {
        _id: s._id,
        registerNumber: s.personalDetails.registerNumber,
        name: s.personalDetails.name,
        department: s.personalDetails.department,
        section: s.personalDetails.section,
        category: s.personalDetails.category,
        currentCGPA: latestSem ? latestSem.cgpa : 0,
        latestAttendance: latestSem ? latestSem.attendance : 0,
        pendingArrearsCount,
        careerGoal: s.careerGoal && s.careerGoal.primaryGoal,
        profileCompletion: completion.percentage,
        createdAt: s.createdAt,
        deletedAt: s.deletedAt || null,
      };
    });

    res.status(200).json({
      success: true,
      data: result,
      pagination: {
        total: totalCount,
        page: pageNum,
        pages: Math.ceil(totalCount / limitNum) || 1,
        limit: limitNum,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single student with full details and analytics
// @route   GET /api/students/:id
// @access  Private
const getStudentById = async (req, res, next) => {
  try {
    const student = await Student.findOne({ _id: req.params.id, ...studentScope(req) });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    const completion = calculateProfileCompletion(student);
    const trend = calculateAcademicTrend(student.semesters);
    const attention = evaluateMentorAttention(student);
    const skillGap = analyzeSkillGap(student);

    res.status(200).json({
      success: true,
      data: {
        student,
        analytics: {
          completion,
          academicTrend: trend,
          mentorAttention: attention,
          skillGap,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new student
// @route   POST /api/students
// @access  Private
const createStudent = async (req, res, next) => {
  try {
    const { personalDetails, consent } = req.body;

    if (!consent) {
      return res.status(400).json({
        success: false,
        message: 'Consent confirmation is required for profiling.',
      });
    }

    if (!personalDetails || !personalDetails.registerNumber) {
      return res.status(400).json({
        success: false,
        message: 'Register Number is required.',
      });
    }

    // Check duplicate register number
    const existing = await Student.findOne({
      'personalDetails.registerNumber': personalDetails.registerNumber.toUpperCase().trim(),
      deletedAt: null,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Student with Register Number '${personalDetails.registerNumber}' already exists.`,
      });
    }

    const student = await Student.create({
      ...req.body,
      createdBy: req.user._id,
      createdByRole: req.user.role,
      updatedBy: req.user._id,
      updatedByRole: req.user.role,
      deletedAt: null,
    });

    // Audit log
    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      userRole: req.user.role,
      action: 'STUDENT_CREATED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: JSON.stringify({ action: `Created student profile for ${student.personalDetails.name} (${student.personalDetails.registerNumber})`, diff: auditDiff({}, student) }),
      ipAddress: req.ip || '',
    });
    emitStudentEvent(req, 'student:created', student);

    res.status(201).json({
      success: true,
      message: 'Student profile created successfully',
      data: student,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update student
// @route   PUT /api/students/:id
// @access  Private
const updateStudent = async (req, res, next) => {
  try {
    let student = await Student.findOne({ _id: req.params.id, deletedAt: null });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    if (!canAccessStudent(student, req)) return res.status(403).json({ success: false, message: 'You cannot edit this student.' });
    if (req.body.version !== undefined && Number(req.body.version) !== student.__v) {
      return res.status(409).json({ success: false, message: 'Student was changed by another user. Reload before saving.' });
    }
    const before = student.toObject();
    const safeBody = Object.fromEntries(Object.entries(req.body).filter(([key]) => editableStudentFields.includes(key)));

    // If register number is changed, check uniqueness
    if (
      safeBody.personalDetails &&
      safeBody.personalDetails.registerNumber &&
      safeBody.personalDetails.registerNumber.toUpperCase() !== student.personalDetails.registerNumber
    ) {
      const duplicate = await Student.findOne({
        'personalDetails.registerNumber': safeBody.personalDetails.registerNumber.toUpperCase().trim(),
        _id: { $ne: student._id },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: `Register Number '${req.body.personalDetails.registerNumber}' is already used by another student.`,
        });
      }
    }

    Object.assign(student, safeBody, { updatedBy: req.user._id, updatedByRole: req.user.role });
    student.increment();
    await student.save();

    // Audit log
    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      userRole: req.user.role,
      action: 'STUDENT_UPDATED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: JSON.stringify({ action: `Updated student profile for ${student.personalDetails.name}`, diff: auditDiff(before, student) }),
      ipAddress: req.ip || '',
    });
    emitStudentEvent(req, 'student:updated', student);

    res.status(200).json({
      success: true,
      message: 'Student profile updated successfully',
      data: student,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete student
// @route   DELETE /api/students/:id
// @access  Private (Admin or Faculty with confirmation)
const deleteStudent = async (req, res, next) => {
  try {
    const student = await Student.findOne({ _id: req.params.id, deletedAt: null });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    const regNo = student.personalDetails.registerNumber;
    const name = student.personalDetails.name;
    if (!canAccessStudent(student, req)) return res.status(403).json({ success: false, message: 'You cannot delete this student.' });
    student.deletedAt = new Date();
    student.deletedBy = req.user._id;
    student.updatedBy = req.user._id;
    student.updatedByRole = req.user.role;
    await student.save();

    // Audit log
    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      userRole: req.user.role,
      action: 'STUDENT_DELETED',
      studentRegisterNumber: regNo,
      studentName: name,
      details: JSON.stringify({ action: `Soft-deleted student profile of ${name} (${regNo})`, diff: auditDiff({ deletedAt: null }, student) }),
      ipAddress: req.ip || '',
    });
    emitStudentEvent(req, 'student:updated', student);

    res.status(200).json({
      success: true,
      message: 'Student profile deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};

const restoreStudent = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    student.deletedAt = null;
    student.deletedBy = null;
    student.updatedBy = req.user._id;
    student.updatedByRole = req.user.role;
    await student.save();
    await AuditLog.create({ userId: req.user._id, userName: req.user.name, userRole: req.user.role, action: 'STUDENT_UPDATED', studentId: student._id, studentRegisterNumber: student.personalDetails.registerNumber, studentName: student.personalDetails.name, details: JSON.stringify({ action: 'Restored student', diff: { deletedAt: null } }), ipAddress: req.ip || '' });
    res.json({ success: true, message: 'Student restored successfully', data: student });
  } catch (err) { next(err); }
};

// --- DYNAMIC SEMESTER SUBDOCUMENTS ---

const addSemester = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const { semesterNumber } = req.body;
    // Check duplicate semester
    const exists = student.semesters.some((s) => s.semesterNumber === Number(semesterNumber));
    if (exists) {
      return res.status(400).json({
        success: false,
        message: `Semester ${semesterNumber} already exists for this student. Please edit it instead.`,
      });
    }

    student.semesters.push(req.body);
    student.semesters.sort((a, b) => a.semesterNumber - b.semesterNumber);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'SEMESTER_ADDED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Added Semester ${semesterNumber} record`,
    });

    res.status(201).json({
      success: true,
      message: `Semester ${semesterNumber} record added successfully`,
      data: student.semesters,
    });
  } catch (err) {
    next(err);
  }
};

const updateSemester = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const semester = student.semesters.id(req.params.semesterId);
    if (!semester) {
      return res.status(404).json({ success: false, message: 'Semester record not found' });
    }

    Object.assign(semester, req.body);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'SEMESTER_UPDATED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Updated Semester ${semester.semesterNumber} record`,
    });

    res.status(200).json({
      success: true,
      message: 'Semester record updated successfully',
      data: student.semesters,
    });
  } catch (err) {
    next(err);
  }
};

const deleteSemester = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const semester = student.semesters.id(req.params.semesterId);
    if (!semester) {
      return res.status(404).json({ success: false, message: 'Semester record not found' });
    }

    const semNum = semester.semesterNumber;
    student.semesters.pull(req.params.semesterId);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'SEMESTER_DELETED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Deleted Semester ${semNum} record`,
    });

    res.status(200).json({
      success: true,
      message: `Semester ${semNum} record deleted successfully`,
      data: student.semesters,
    });
  } catch (err) {
    next(err);
  }
};

// --- DYNAMIC ARREAR SUBDOCUMENTS ---

const addArrear = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    student.arrears.push(req.body);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'ARREAR_ADDED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Added arrear for subject ${req.body.subjectCode} - ${req.body.subjectName}`,
    });

    res.status(201).json({
      success: true,
      message: 'Arrear record added successfully',
      data: student.arrears,
    });
  } catch (err) {
    next(err);
  }
};

const updateArrear = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const arrear = student.arrears.id(req.params.arrearId);
    if (!arrear) {
      return res.status(404).json({ success: false, message: 'Arrear record not found' });
    }

    Object.assign(arrear, req.body);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'ARREAR_UPDATED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Updated arrear for ${arrear.subjectCode} (Status: ${arrear.status})`,
    });

    res.status(200).json({
      success: true,
      message: 'Arrear record updated successfully',
      data: student.arrears,
    });
  } catch (err) {
    next(err);
  }
};

const deleteArrear = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const arrear = student.arrears.id(req.params.arrearId);
    if (!arrear) {
      return res.status(404).json({ success: false, message: 'Arrear record not found' });
    }

    const subCode = arrear.subjectCode;
    student.arrears.pull(req.params.arrearId);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'ARREAR_DELETED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Removed arrear record for subject ${subCode}`,
    });

    res.status(200).json({
      success: true,
      message: 'Arrear record removed successfully',
      data: student.arrears,
    });
  } catch (err) {
    next(err);
  }
};

// --- MENTOR INTERVENTIONS ---

const addIntervention = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    if (!canAccessStudent(student, req)) return res.status(403).json({ success: false, message: 'You cannot counsel this student.' });

    const interventionData = {
      ...req.body,
      mentorName: req.user.name,
      mentorId: req.user._id,
      date: req.body.date || new Date(),
    };

    student.mentorInterventions.push(interventionData);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      userRole: req.user.role,
      action: 'INTERVENTION_ADDED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Logged mentor intervention note: "${req.body.reason}"`,
    });

    res.status(201).json({
      success: true,
      message: 'Mentor intervention logged successfully',
      data: student.mentorInterventions,
    });
  } catch (err) {
    next(err);
  }
};

const updateIntervention = async (req, res, next) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const intervention = student.mentorInterventions.id(req.params.interventionId);
    if (!intervention) {
      return res.status(404).json({ success: false, message: 'Intervention record not found' });
    }

    Object.assign(intervention, req.body);
    await student.save();

    await AuditLog.create({
      userId: req.user._id,
      userName: req.user.name,
      action: 'INTERVENTION_UPDATED',
      studentId: student._id,
      studentRegisterNumber: student.personalDetails.registerNumber,
      studentName: student.personalDetails.name,
      details: `Updated mentor intervention status to ${intervention.status}`,
    });

    res.status(200).json({
      success: true,
      message: 'Mentor intervention updated successfully',
      data: student.mentorInterventions,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getStudents,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  restoreStudent,
  addSemester,
  updateSemester,
  deleteSemester,
  addArrear,
  updateArrear,
  deleteArrear,
  addIntervention,
  updateIntervention,
};
