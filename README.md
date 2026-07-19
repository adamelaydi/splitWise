# Frontend Onboarding Guide — Alredwan Courses Center

Welcome to the **Alredwan Courses Center** frontend codebase, a project by **Redwan Oasis** (واحة الرضوان التعليمية).

This document is the single source of truth for new frontend developers joining the team.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Business Logic & Domain Model](#2-business-logic--domain-model)
3. [Tech Stack](#3-tech-stack)
4. [How to Run the Project](#4-how-to-run-the-project)
5. [Project Structure](#5-project-structure)
6. [Path Aliases](#6-path-aliases)
7. [Architecture Patterns](#7-architecture-patterns)
8. [Backend API Reference](#8-backend-api-reference)
9. [Authentication Flow](#9-authentication-flow)
10. [Git Conventions](#10-git-conventions)
11. [Coding Conventions](#11-coding-conventions)
12. [Design Reference](#12-design-reference)
13. [Completed Features](#13-completed-features)
14. [Pending / Future Tasks](#14-pending--future-tasks)

---

## 1. Project Overview

Alredwan Courses Center is a **courses management platform** for a mosque / educational center. It allows students to browse and enroll in courses, instructors to manage their lectures and attendance, parents to register and track their children, and admins/supervisors to oversee the entire operations and track and manage enrollments and attendances of instructors and supervisors.

The platform consists of:

- **Public-facing landing page** — course catalogue, instructor profiles, testimonials, about/contact pages.
- **Role-based dashboards** — different views for students, instructors, parents, supervisors, and admins.

| Component        | Technology                                       |
| ---------------- | ------------------------------------------------ |
| Frontend         | Next.js 16 (App Router) — this codebase          |
| Backend          | Django REST Framework + Djoser (JWT)             |
| Real-time        | Django Channels + Redis (WebSocket on port 8001) |
| Database         | PostgreSQL 17                                    |
| Containerization | Docker Compose                                   |

### User Roles

| Role                        | Description                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Student**                 | Browse courses, enroll, view own enrollments & attendance                                                                                                                                                                             |
| **Parent**                  | Manage children, enroll children, view children's enrollments                                                                                                                                                                         |
| **Instructor** (Normal)     | Assigned to courses. Teaches lectures. Attendance is tracked per-lecture via fingerprint device. Can mark student attendance for their own lectures within 24 hours.                                                                  |
| **Instructor** (Supervisor) | Everything a normal instructor can do, **plus**: has a separate weekly `SupervisorSchedule` that generates supervision attendance records (not tied to any lecture). Can also manage enrollment requests and view attendance reports. |
| **Admin**                   | Full access — manages courses, seasons, users, enrollments, devices, schedules, and can edit any attendance record (including historical).                                                                                            |

> **Key distinction — Normal Instructor vs Supervisor:** A normal instructor's attendance records are always linked to a specific lecture they teach. A supervisor can have _additional_ attendance records of type `supervision` generated from their `SupervisorSchedule` — these exist independently of any course or lecture. Both types check in and out via the same fingerprint device.

---

## 2. Business Logic & Domain Model

This section explains how the platform works from a business perspective so you can understand the _why_ behind every page you build.

### 2.1 Seasons

All courses belong to a **Season** (e.g. "Winter 2026", "Summer Camp 2026"). A season has a type (`school`, `summer_camp`, etc.), start/end dates, and an `is_active` flag. Usually Only one season is active at a time. When filtering courses, attendance, or enrollments, season context matters.

### 2.2 Courses & Lectures

A **Course** is created by an admin and assigned to one instructor. Each course has:

- A **schedule** — a set of weekly time slots (e.g. Sunday 10:00–12:00, Tuesday 10:00–12:00).
- **Lectures** — individual class sessions auto-generated from the schedule by a backend cron job. Each lecture has a date, start/end time, title, and a status (`pending` or `submitted` — i.e. attendance has been recorded).
- Capacity, price, tags, age restrictions, and an `is_active` flag.
- Ratings — students can rate a course after attending.

```
Season
 └── Course (has an instructor, a schedule, tags, capacity, price)
      ├── Schedule (weekly: Sunday 10:00–12:00, Tuesday 10:00–12:00)
      ├── Lecture 1 (auto-generated, 2026-02-02, 10:00–12:00, pending)
      ├── Lecture 2 (auto-generated, 2026-02-04, 10:00–12:00, submitted)
      └── ...
```

### 2.3 Enrollment Workflow

Students and parents don't enroll directly — they submit an **Enrollment Request** which goes through an approval workflow:

```
┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌───────────┐
│  Student  │────►│   PENDING   │────►│PROCESSING│────►│  ACCEPTED │──► Enrollment created
│ or Parent │     │  (created)  │     │(reviewed) │     │ (approved)│
└──────────┘     └──────┬──────┘     └─────┬─────┘     └───────────┘
                        │                   │
                        ▼                   ▼
                   CANCELLED            REJECTED
                  (by user)          (by admin)
```

- **Parents** must specify which `child` the enrollment is for.
- **Students** enroll themselves.
- Once accepted, an `Enrollment` record is created (status: `active`) and optionally a `Payment` record.
- Enrollment requests **expire** after a configurable period if not acted upon.

> **Important — how enrollment requests are approved today:** There is currently **no frontend UI and no dedicated REST API endpoint** for supervisors to approve/reject enrollment requests. All enrollment approval/rejection is done through the **Django Admin Panel** (see [§2.9](#29-django-admin-panel)). Building a frontend for this is a pending task.

**Validation rules:** The course must be active, have available spots, the participant must meet age requirements, and no duplicate pending request or active enrollment can exist.

### 2.4 Instructor & Supervisor Attendance (Fingerprint System)

This is one of the most important subsystems. The center tracks whether instructors and supervisors show up using **physical fingerprint devices** installed at the building entrance.

#### How it works

1. **Attendance records are pre-generated** — A backend cron job runs daily and creates attendance records for the day based on:
   - **Course schedules** → generates `lecture` type records for the instructor assigned to each course.
   - **SupervisorSchedule** → generates `supervision` type records for supervisors on their scheduled days.

2. **Fingerprint scan** — When an instructor/supervisor arrives and scans their finger:
   - The device calls `POST /api/attendance/scan/` with the `fingerprint_id` and `device_id`.
   - The backend finds matching attendance record(s) for today and marks check-in.
   - A second scan marks check-out. A third scan is treated as re-entry.
   - Rapid scans (< 2 min apart) are ignored as duplicates.

3. **Status is determined automatically:**

   | Status        | Meaning                                         |
   | ------------- | ----------------------------------------------- |
   | `not_started` | The scheduled time hasn't arrived yet           |
   | `pending`     | Scheduled time has passed, waiting for check-in |
   | `present`     | Checked in within the grace period              |
   | `late`        | Checked in after the grace period               |
   | `absent`      | Cron job marked them absent (never checked in)  |

4. **Admin rates attendance** — After an instructor is present or late, an admin can assign a performance **rating** (1.00–10.00) with optional notes. Only `present` and `late` records can be rated.

5. **WebSocket real-time updates** — Every check-in, check-out, and rating triggers a WebSocket message to the admin dashboard so it updates live without polling.

#### Two types of attendance

| Type          | Linked to                      | Created from                | Example                                                 |
| ------------- | ------------------------------ | --------------------------- | ------------------------------------------------------- |
| `lecture`     | A specific lecture in a course | Course schedule + cron      | "Instructor Ahmed has a Quran lecture at 10:00"         |
| `supervision` | Nothing (standalone shift)     | `SupervisorSchedule` + cron | "Supervisor Khaled has a supervision shift 08:00–14:00" |

> A supervisor who also teaches courses will have **both** `lecture` and `supervision` attendance records on the same day.

#### Fingerprint device endpoints (no JWT needed)

| Endpoint                          | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `POST /api/attendance/scan/`      | **Unified scan** — auto-detects check-in vs check-out |
| `POST /api/attendance/check-in/`  | Legacy — explicit check-in                            |
| `POST /api/attendance/check-out/` | Legacy — explicit check-out                           |

These endpoints authenticate via `device_id` (hardware identifier), not JWT. The `fingerprint_id` is mapped to an instructor profile.

#### Admin attendance management

| Endpoint                                      | Purpose                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/attendance/today/`                  | Today's attendance list                                                              |
| `GET /api/attendance/today/summary/`          | Today's summary (counts by status)                                                   |
| `GET /api/attendance/date/{YYYY-MM-DD}/`      | Attendance for a specific date                                                       |
| `GET /api/attendance/all/`                    | All records with filters (date range, instructor, status, type, season, rated, etc.) |
| `PATCH /api/attendance/all/{id}/`             | Edit any record (admin only — including historical)                                  |
| `POST /api/attendance/{id}/rate/`             | Rate an attendance record (1–10)                                                     |
| `POST /api/attendance/{id}/manual-check-in/`  | Manual check-in (for missed scans)                                                   |
| `POST /api/attendance/{id}/manual-check-out/` | Manual check-out                                                                     |
| `POST /api/attendance/{id}/mark-absent/`      | Force-mark as absent                                                                 |
| `POST /api/attendance/generate/`              | Generate records for a date range                                                    |

#### Device management (admin)

| Endpoint                                         | Purpose                             |
| ------------------------------------------------ | ----------------------------------- |
| `GET/POST /api/attendance/devices/`              | List / register fingerprint devices |
| `GET/PATCH/DELETE /api/attendance/devices/{id}/` | Manage a specific device            |

#### Supervisor schedule management (admin)

| Endpoint                                           | Purpose                                   |
| -------------------------------------------------- | ----------------------------------------- |
| `GET/POST /api/attendance/schedules/`              | List / create supervisor weekly schedules |
| `GET/PATCH/DELETE /api/attendance/schedules/{id}/` | Manage a specific schedule                |

A schedule entry defines: which instructor, which day of week, start/end time, grace period, and auto-absent timeout.

### 2.5 Student Lecture Attendance

Separate from instructor attendance. When an instructor opens a lecture in the dashboard, they can **mark student attendance** — recording who was present in that specific class session.

- **Single mark:** `POST /api/attendance/lecture/{lecture_id}/mark/` — marks one student/child using their unique `code`.
- **Bulk mark:** `POST /api/attendance/lecture/{lecture_id}/mark-bulk/` — marks multiple students at once with ratings and notes.
- Instructors can only mark attendance for **past lectures within 24 hours**. Admins/supervisors have no time restriction.
- Each student attendance can include a **rating** (1–10) and **notes**.

### 2.6 Parents & Children

Parents register on the platform and then add their **children** (who are typically minors and don't have their own account). A parent can:

- Create, update, and delete children (`/api/parents/children/`).
- Enroll children in courses (via enrollment requests).
- View their children's enrollments and attendance.

Each child has a `code` (auto-generated, like `C12345`) used for lecture attendance marking.

### 2.7 WebSocket — Real-time Attendance

The admin dashboard can open a WebSocket connection to receive **live updates** as instructors scan in/out:

```
ws://localhost:8001/ws/attendance/?ticket=<one-time-ticket>
```

| Event                    | When it fires                                |
| ------------------------ | -------------------------------------------- |
| `connection_established` | On successful WebSocket connect              |
| `attendance_update`      | Instructor checks in (fingerprint or manual) |
| `attendance_check_out`   | Instructor checks out                        |
| `attendance_rated`       | Admin rates an attendance record             |
| `summary_response`       | Response to a `request_summary` message      |

**Auth flow:** The client first calls `POST /api/attendance/ws-ticket/` (with JWT) to get a single-use ticket (valid 30 seconds), then connects to the WebSocket with `?ticket=<ticket>`. This is more secure than passing JWT in the query string.

### 2.8 Ratings System

There are **two separate rating systems**:

| What                           | Who rates  | Scale                | Where                                         |
| ------------------------------ | ---------- | -------------------- | --------------------------------------------- |
| **Instructor attendance**      | Admin      | 1.00–10.00 (decimal) | After instructor checks in (present/late)     |
| **Student lecture attendance** | Instructor | 1–10 (integer)       | When marking student attendance for a lecture |

There are also **course ratings** and **instructor ratings** that students can submit, but these don't have frontend UI yet.

### 2.9 Django Admin Panel

The backend includes a fully configured **Django Admin Panel** — a server-rendered admin interface provided by Django itself. This is the current primary tool for back-office operations that don't yet have a frontend UI.

|            |                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **URL**    | `http://localhost:8000/Al-Redwan-superadmin-dashboard/`                                                       |
| **Access** | Requires a **superuser** account (see [§4 — Creating a Superuser](#creating-a-superuser-django-admin-access)) |

**Global features across all models:**

- **Excel export** — Every admin model uses `ExcelExportMixin`; the "Export to Excel" action is always available.
- **Arabic UI** — All labels, filters, fieldsets, and messages are in Arabic.
- **Emoji-coded filters** — Status filters use emoji indicators (✅, ❌, ⏳, etc.) for quick visual scanning.

---

#### 2.9.1 Users Module

**CustomUser** — The base user model for all roles.

- **List columns:** Full name, Phone 1, Phone 2, Role, Gender, Date joined, Verified (✓/✗), Active (✓/✗)
- **Filters:** Role, Verified, Active, Gender, Date joined
- **Search:** Phone, first/last name, email, identity number
- **Fieldsets:** Login info → Personal info (name, email, phones, DOB, gender, identity, address, location) → Permissions (active, verified, staff, superuser, role, groups) → Dates (last login, joined)
- **Add form:** Phone + password + name + DOB + gender + role

**StudentUser** — Student profile linked to a CustomUser.

- **List columns:** Unique code, Full name, Phone, Gender, Image
- **Filters:** Gender, Verified
- **Search:** Unique code, name, phone
- **Actions:** `📋 Export students info`, `🖼️ Download single card image (PNG)`, `📑 Download ID cards PDF` (bulk)

**Instructor** — Instructor profile (normal or supervisor).

- **List columns:** Full name, Type (normal/supervisor), Monthly salary, Phone, Tags (colored badges, max 3), Joined date, Fingerprint ID
- **Filters:** Type, Tags, Joined date
- **Search:** Name, phone, fingerprint ID
- **Inlines:** SupervisorSchedule (collapsible), InstructorAttendance (last 10, read-only), Lectures (last 10 read-only)
- **Fieldsets:** Info (user, type, bio, salary, fingerprint_id) → Tags → Images (NID front/back, profile — collapsible)

**LandingPageInstructor** — Controls which instructors appear on the public landing page.

- **List columns:** Order badge, Instructor link, Type, Courses count, Bio preview, Created at
- **Fieldset:** Instructor + Order (higher numbers appear first)

---

#### 2.9.2 Courses Module

**Season** — Time periods that group courses.

- **List columns:** Name, Season type, Date range (start → end), Active status (🟢/🔴), Courses count (blue badge), Created at
- **Filters:** Season type, Active status (🟢/🔴), Start date
- **Actions:** `✅ Activate`, `❌ Deactivate`, `📋 Duplicate`
- **Fieldsets:** Season info (name, type, description) → Dates & Status (start, end, is_active)

**Course** — The central model.

- **List columns:** Name, Instructor (clickable link), Season, Date range, **Capacity bar** (visual progress bar: green < 80%, yellow 80–100%, red = full), Price (EGP), Active status (🟢/🔴)
- **Filters:** Active status, **Capacity status** (🔴 Full / 🟡 Almost full / 🟢 Available / ⚪ Empty), Season, Instructor, For adults, Date range (today/this week/this month/next week/past/upcoming), Tags
- **Search:** Name, description, slug, instructor name
- **Actions:** `✅ Activate`, `❌ Deactivate`, `📋 Duplicate`
- **Inlines (on edit):** CourseSchedule (up to 7 weekday slots), Lectures (last 10), CourseEnrollments
- **Inline (on add):** CourseSchedule only (simplified add form)
- **Fieldsets:** Basic info (name, slug, description, image) → Instructor & Season → Dates & Lectures (start, end, num_lectures) → Capacity & Price → Age group (collapsible: for_adults, min_age, max_age) → Extra settings (tags, is_active — collapsible)

**Lecture** — Individual class sessions within a course.

- **List columns:** Title (#N), Course link, Lecture number, Day, Time range, Instructor, Status badge, Acceptance status, Attendance taken status
- **Filters:** Status, Is accepted, Attendance taken, Date range, Season, Course, Instructor
- **Actions:** `✅ Mark completed`, `❌ Mark cancelled`, `📋 Reschedule to next week` (duplicates lecture +7 days)
- **Fieldsets:** Lecture info (title, course, number) → Instructor (optional — defaults to course instructor) → Timing (day, start, end) → Status & Attendance

**Exam** — Exams tied to a course.

- **List columns:** Name, Exam type badge (📝 quiz / 📋 midterm / 📚 final / 🔧 practical), Course link, Instructor, Scheduled at, Total marks, Results summary
- **Inlines:** ExamResult (student/child, marks, percentage, passed — inline editing)
- **Fieldsets:** Exam info → Course & Instructor → Timing & Marks

**Tag** — Categories for courses and instructors.

- **List columns:** Name, Courses count (purple badge), Instructors count (blue badge), Created at
- **Inlines:** TagCourse (linked courses), TagInstructor (linked instructors) — both collapsible

**LandingPageCourse** — Controls which courses appear on the public landing page.

- **List columns:** Order (gold/silver/bronze badges for top 3), Course info + season badge, Instructor, Enrollment status, Active status, Drag handle
- **Fieldset:** Course + Order

**CourseSchedule** — Weekly recurring time slots (managed as inline on Course).

---

#### 2.9.3 Enrollment & Payments Module

**EnrollmentRequest** — **The most critical admin model.** This is currently the _only_ way to approve or reject enrollment requests.

- **List columns:** Participant name, Course link, Price, Status badge, Payment method badge, Expiry status, Created at, Processed-by info
- **Filters:**
  - Status: ⏳ Pending, 🔄 Processing, ✅ Approved, ❌ Rejected, ⌛ Expired
  - Payment method: 💵 Cash, 💳 Card, 🏦 Bank transfer, 📱 Instapay, 📲 Vodafone Cash
  - Participant type: 🧑‍🎓 Student, 👦 Child
  - Expiry: 🔴 Expired, 🟡 Expiring soon, 🟢 Valid
  - Course season, Course, Created at
- **Search:** Student/child/parent name, course name, notes, ID
- **Actions (bulk):**
  - `✅ Approve selected` — approves pending/processing requests, tracks partial payments
  - `❌ Reject selected` — rejects with reason "bulk reject from admin panel"
  - `🔄 Mark as processing` — changes pending → processing
  - `⏳ Extend expiry (7 days)` — adds 7 days to expiration
- **Dynamic fieldsets:** Different forms for Add vs Edit:
  - **Add:** Course → Participant (student or child) → Payment (optional, collapsible) → Notes (collapsible)
  - **Edit:** Participant info (read-only) → Course info (read-only) → Payment → Status & Notes → Processing info (collapsible) → System info (collapsible)
- After approval, the request auto-creates an Enrollment + Payment record

**Enrollment** — Active course memberships.

- **List columns:** Participant, Course link, Amount paid display, Status badge, Payment status, Enrolled at, Processed by
- **Filters:**
  - Status: ✅ Active, ⏸️ Suspended, 🎓 Completed, ❌ Dropped, 💸 Refunded
  - Payment status: 💚 Fully paid, 🟡 Partial, 🔴 Unpaid, 🔵 Overpaid
  - Participant type: 🧑‍🎓 Student, 👦 Child
  - Enrolled period: 📅 Today, 📆 This week, 🗓️ This month, 📜 Older
  - Course
- **Actions (bulk):**
  - `⏸️ Suspend enrollments` (active → suspended)
  - `✅ Reactivate enrollments` (suspended → active)
  - `🎓 Mark as completed` (active → completed)
  - `❌ Drop enrollments` (active/suspended → dropped)
  - `🔄 Auto-complete check` — checks if courses are finished and auto-completes

**Payment** — Financial transactions linked to enrollments.

- **List columns:** Payer name, Enrollment link, Amount, Method badge, Status badge, Processed date, Processed by, Reference number
- **Filters:**
  - Status: ⏳ Pending, ✅ Paid, 💸 Refunded, ❌ Void
  - Method: 💵 Cash, 💳 Card, 🏦 Bank transfer, 📱 Instapay, 📲 Vodafone Cash, 📋 Other
  - Payer type: 👨‍👩‍👧 Parent, 🧑‍🎓 Student
  - Amount range: < 500 EGP, 500–1000, 1000–2000, > 2000 EGP
  - Payment period: Today / This week / This month / Older
  - Course
- **Actions (bulk):**
  - `✅ Confirm payment` (pending → paid)
  - `💸 Refund payments` (paid → refunded)
  - `❌ Void payments` (pending → void)

---

#### 2.9.4 Parents Module

**Parent** — Parent/guardian accounts.

- **List columns:** Full name, Phone (clickable tel: link), Email, Children count (badge), Total payments (EGP), Verified badge (✓/✗)
- **Filters:** Has children (yes/no), Has payments (yes/no), Verified, Gender
- **Search:** Name, phone, email, child name, child unique code
- **Inlines:** Primary children (with age & enrollment count), Extra children (secondary links), Payments (with course info & status badges)
- **Summary card:** Visual dashboard showing primary children, extra children, total paid (EGP), pending payments count

**Child** — Children managed by parents.

- **List columns:** Unique code badge, Full name, Gender badge (👦/👧), Age, Primary parent link, Enrollments badge (active/total), Phone, Image
- **Filters:** Gender, Age group (0–5, 6–10, 11–15, 16–18, 18+), Has enrollments (yes/no/active only), Created at
- **Search:** Unique code, name, phone, parent phone
- **Inlines:** Enrollments (with course, status badge, remaining amount), Extra parents, Link requests
- **Summary card:** Active enrollments, total enrollments, remaining payments

**ParentLinkRequest** — Requests from parents to link to existing children (managed as inline on Child).

---

#### 2.9.5 Attendance Module

**InstructorAttendance** — Daily attendance records for instructors.

- **List columns:** Instructor, Date, Status, Check-in time, Check-out time, Rating, Rated by
- **Filters:** Status, Date, Season, Check-in method
- **Fieldsets:** Attendance info (instructor, date, season, status) → Timing (check-in/out time, method, device) → Lecture & Schedule → Rating (rating, rated_by, notes)

**SupervisorSchedule** — Defines when supervisors are expected to be present (used for automatic attendance tracking).

- **List columns:** Instructor name, Day (Arabic), Time range (colored start–end), Grace period minutes, Auto-absent-after minutes
- **Filters:** Day of week
- **Fieldsets:** Supervisor info → Schedule (day, start, end) → Attendance settings (grace period, auto-absent threshold)

**AttendanceDevice** — Fingerprint scanner hardware.

- **List columns:** Device ID, Name, Location, Active (✓/✗)
- **Filters:** Active
- **Fieldset:** Device info (ID, name, location, active)

**FingerprintScanLog** — Raw scan events from devices (system-generated, not manually created).

- **List columns:** Instructor name, Scan time, Action (color-coded: green check-in / blue check-out), Device name, Processed (✓/✗), Notes preview
- **Filters:** Action, Processed, Device, Scan time
- **Read-only fields:** instructor, attendance, scan_time, received_time, device, action, is_processed, device_sequence
- **Permissions:** Cannot add manually; only superusers can delete; notes field is editable

**LectureAttendance** — Per-lecture student/child attendance.

- **List columns:** Lecture, Participant, Present (✓/✗), Rating, Marked by, Marked via, Marked at
- **Filters:** Present, Course, Marked via, Marked at
- **Fieldsets:** Attendance info (lecture, student, child) → Status & Rating → Registration info (marked_by, method, time) → Dates

**AttendanceCronLog** — System logs for automated attendance jobs (fully read-only).

- **List columns:** Job name, Timestamp, Details
- **Filters:** Job name, Timestamp

---

#### 2.9.6 Ratings Module

Four rating models — all share the same simple structure:

- **StudentInstructorRating** — Student rates an instructor (for a specific course)
- **ParentInstructorRating** — Parent rates an instructor
- **StudentCourseRating** — Student rates a course
- **ParentCourseRating** — Parent rates a course

Each shows: rater, target, course, rating value, created date.

---

> **Why this matters for frontend devs:** Many operations (especially enrollment approval, course/season creation, and device registration) are currently only possible through this panel. As you build admin dashboard pages in the frontend, you'll be replacing these Django Admin workflows with custom UI. Refer to the Django Admin Panel to understand what fields exist, what filters/actions exist, and what business logic is enforced (e.g., enrollment status transitions, payment confirmation flows, capacity checks).

---

## 3. Tech Stack

### Core

| Dependency                                    | Version | Purpose                                      |
| --------------------------------------------- | ------- | -------------------------------------------- |
| [Next.js](https://nextjs.org/)                | 16      | React framework (App Router, Server Actions) |
| [React](https://react.dev/)                   | 19      | UI library                                   |
| [TypeScript](https://www.typescriptlang.org/) | 5+      | Type safety                                  |
| [Tailwind CSS](https://tailwindcss.com/)      | v4      | Utility-first styling                        |

### UI Components

| Dependency                                           | Purpose                                                 |
| ---------------------------------------------------- | ------------------------------------------------------- |
| [shadcn/ui](https://ui.shadcn.com/) (new-york style) | Base component library                                  |
| [Radix UI](https://www.radix-ui.com/)                | Accessible primitives (dialog, dropdown, tooltip, etc.) |
| [MUI](https://mui.com/) (`@mui/x-date-pickers`)      | Date & time pickers                                     |
| [Lucide React](https://lucide.dev/)                  | Icon library                                            |

### Data & Forms

| Dependency                                      | Purpose                            |
| ----------------------------------------------- | ---------------------------------- |
| [Axios](https://axios-http.com/)                | HTTP client for API calls          |
| [react-hook-form](https://react-hook-form.com/) | Form state management & validation |
| [date-fns](https://date-fns.org/)               | Date manipulation & formatting     |

### UX & Animation

| Dependency                                           | Purpose                  |
| ---------------------------------------------------- | ------------------------ |
| [Motion](https://motion.dev/) (Framer Motion)        | Animations & transitions |
| [Swiper](https://swiperjs.com/)                      | Carousels / sliders      |
| [react-hot-toast](https://react-hot-toast.com/)      | Toast notifications      |
| [react-day-picker](https://react-day-picker.js.org/) | Calendar / date picker   |

### Auth

| Dependency                                                     | Purpose                       |
| -------------------------------------------------------------- | ----------------------------- |
| [NextAuth v4](https://next-auth.js.org/)                       | Authentication (JWT strategy) |
| [jwt-decode](https://github.com/nicolevanderhoeven/jwt-decode) | Client-side token decoding    |

### Package Manager

**pnpm** — always use `pnpm` (not npm or yarn).

```bash
pnpm install      # install dependencies
pnpm dev           # start dev server
pnpm build         # production build
pnpm lint          # run ESLint
```

---

## 4. How to Run the Project

> **The frontend requires the backend to be running.** There is no offline / mock-only mode.

### Option A — Docker (Recommended)

From the **project root**:

1. Create and populate the required environment files:

- `frontend/.env`
- `backend/.env`
- `backend/db.env`

2. Install frontend dependencies locally (for editor IntelliSense):

```bash
pnpm --dir frontend install
```

> This local install is required for editor IntelliSense/type resolution and does not happen automatically from Docker image builds.

3. Start everything (PostgreSQL, backend, frontend):

```bash
# First run only (or when Dockerfiles/dependencies change)
docker compose up --build --watch

# Next runs
docker compose up --watch
```

> `--build` is mainly for the first run so Docker builds images before starting containers.

| Service           | URL                   |
| ----------------- | --------------------- |
| Frontend          | http://localhost:3000 |
| Backend REST API  | http://localhost:8000 |
| Backend WebSocket | ws://localhost:8001   |

### Option B — Standalone Frontend

If the backend + database are already running (e.g. via Docker or locally):

```bash
cd frontend
pnpm install
pnpm dev
```

### Environment Variables

`frontend/.env` (NextJS container):

```env
# NextAuth base URL
NEXTAUTH_URL=http://localhost:3000

# JWT signing secret (must match across environments)
NEXTAUTH_SECRET=<your-secret-here>

# Backend API base URL
# Use "http://redwan-backend:8000" when running via Docker (service name resolves internally)
# Use "http://localhost:8000" when running standalone
NEXT_PUBLIC_API_URL=http://redwan-backend:8000
```

> When running the frontend **standalone** (Option B), change `NEXT_PUBLIC_API_URL` to `http://localhost:8000`.

### Backend Environment Variables

The backend also needs its own env files to run. These are at the **project root**, not inside `backend/`:

**`backend/.env`** (Django container):

```env
# Django
DJANGO_SECRET_KEY=<your-django-secret>
DEBUG=True
DJANGO_SETTINGS_MODULE=Redwan_courses_center.settings
DJANGO_LOGLEVEL=info
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,redwan-backend

# Database
DATABASE_ENGINE=postgresql_psycopg2
DATABASE_NAME=redwan_courses_center_dev_db
DATABASE_USERNAME=redwan_courses_center_dev
DATABASE_PASSWORD=<your-db-password>
DATABASE_HOST=redwan-db
DATABASE_PORT=5432

# Cloudinary (for image uploads — optional for local dev)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Image upload settings
MAX_IMAGE_SIZE_MB=5
IMAGE_COMPRESSION_QUALITY=80
IMAGE_MAX_WIDTH=1920
IMAGE_MAX_HEIGHT=1920
TARGET_IMAGE_SIZE_KB=500
```

**`db.env`** (PostgreSQL container):

```env
POSTGRES_DB=redwan_courses_center_dev_db
POSTGRES_USER=redwan_courses_center_dev
POSTGRES_PASSWORD=<same-password-as-above>
```

A `frontend/.env.example`, `backend/.env.example` and `backend/db.env.example` are provided in the repo — copy and fill them in.

> **The backend will not start without these files.** If you see database connection errors on `docker compose up`, this is likely the cause.

### If Django Migrations Break (Development Only)

If you run into migration issues and want to recreate migrations from scratch, run:

```powershell
docker compose down -v
cd .\backend\
Get-ChildItem -Path . -Recurse -Directory -Filter "migrations" | Get-ChildItem -Filter "*.py" -Exclude "__init__.py" | Remove-Item -Force
cd ..
docker compose run --rm -v "${PWD}/backend:/app" --entrypoint bash redwan-backend -c "python manage.py makemigrations"
docker compose up --build --watch
```

> This resets local database volumes and local migration files. Use this only in local development.
> If images are already built, you can run `docker compose up --watch` instead of `docker compose up --build --watch`.

### Creating a Superuser (Django Admin Access)

To access the Django Admin Panel, you need a superuser account. Run this while the backend container is running:

```bash
# Docker
docker compose exec redwan-backend python manage.py createsuperuser

# Local (if running backend outside Docker)
cd backend
python manage.py createsuperuser
```

You'll be prompted for a phone number (in E.164 format, e.g. `+201234567890`) and password.

---

## 5. Project Structure

```
frontend/src/
├── app/                          # Next.js App Router pages
│   ├── (public)/                 # Public pages (no auth required)
│   │   ├── page.tsx              # Landing page (home)
│   │   ├── about/                # About page
│   │   ├── activities/           # Activities page
│   │   ├── contact-us/           # Contact page
│   │   ├── courses/              # Public course catalogue
│   │   ├── login/                # Login page (Legacy)
│   │   ├── signup/               # Signup page (Legacy)
│   │   └── layout.tsx            # Public layout (navbar + footer)
│   │
│   ├── dashboard/                # Authenticated dashboard
│   │   ├── (instructor)/         # Instructor-only route group
│   │   │   └── todays-schedule/  # Today's lectures view
│   │   ├── (parent)/             # Parent-only route group
│   │   │   └── my-children/      # Children management
│   │   ├── courses/              # All courses (shared across roles)
│   │   ├── my-courses/           # My enrolled/assigned courses
│   │   ├── overview/             # Dashboard overview
│   │   ├── profile/              # User profile
│   │   ├── layout.tsx            # Dashboard layout (sidebar + header)
│   │   └── page.tsx              # Dashboard root (redirects by role)
│   │
│   ├── api/auth/                 # NextAuth API routes
│   ├── layout.tsx                # Root layout (providers, fonts, RTL)
│   └── not-found.tsx             # 404 page
│
├── components/                   # Reusable UI components
│   ├── auth/                     # Login, signup, logout components
│   ├── courses/                  # Course cards, details, lectures view
│   ├── attendance/               # Attendance views, notes
│   ├── lectures/                 # Lecture tables, configs
│   ├── dashboard/                # Dashboard-specific components
│   │   ├── enrollments/          # Enrollment cards & lists
│   │   ├── instructor/           # Instructor dashboard components
│   │   ├── parent/               # Parent dashboard components
│   │   └── student/              # Student dashboard components
│   ├── landing-page/             # All landing page sections
│   ├── layout/                   # Layout shells (dashboard, landing)
│   ├── feedback/                 # Error and empty state UIs
│   ├── icons/                    # Custom icon components
│   └── ui/                       # Primitive UI components
│       ├── data-view/            # ⭐ DataView — reusable table/card system
│       ├── navigation/           # Nav components
│       ├── Button.tsx, Modal.tsx, Calendar.tsx, etc.
│       └── ...
│
├── actions/                      # Next.js Server Actions
│   ├── auth.ts                   # Signup, getUser, protect, JWT helpers
│   ├── courses.ts                # Course CRUD, instructor courses
│   ├── enrollments.ts            # Enrollment actions
│   ├── landing.ts                # Landing page data fetching
│   └── lectures.ts               # Lecture actions
│
├── hooks/                        # Custom React hooks
│   ├── useFilterData.ts          # Filter data by URL search params
│   ├── useSearchData.ts          # Text search across data fields
│   ├── useSortData.ts            # Sort data by configurable fields
│   └── useMutateSearchParams.ts  # URL search param manipulation
│
├── lib/                          # Shared utilities
│   ├── axios.ts                  # Public Axios instance (no auth)
│   ├── auth-api.ts               # Authenticated Axios instance (JWT injected)
│   ├── config.ts                 # App-level constants
│   └── utils.ts                  # cn(), Arabic digit helpers, date formatting
│
├── types/                        # TypeScript type definitions
│   ├── auth.ts                   # UserEntity, LoginInputs, SignupInputs
│   ├── entities.ts               # Course, Lecture, Instructor, Enrollment, etc.
│   ├── config.ts                 # PaginatedResponse, JSONResponse
│   └── components.ts             # DataView config types, StatusMap
│
├── providers/                    # React context providers
│   ├── AuthProvider.tsx           # NextAuth SessionProvider wrapper
│   ├── LocalizationProvider.tsx   # MUI locale provider (Arabic)
│   └── ToastProvider.tsx          # react-hot-toast config
│
├── dev-data/                     # Mock / seed data for development
│   ├── db.ts
│   ├── statistics.ts
│   └── testimonials.ts
│
├── assets/                       # Static assets (images, etc.)
├── tailwind-plugins/             # Custom Tailwind CSS plugins
└── proxy.ts                      # NextAuth middleware (auth guard + role-based redirects)
```

---

## 6. Path Aliases

| Alias | Resolves to |
| ----- | ----------- |
| `@/*` | `./src/*`   |

Example: `import { cn } from "@/lib/utils"` resolves to `./src/lib/utils.ts`.

shadcn components use a separate alias tree (`@/shadcn/...`) — configured in `components.json`.

---

## 7. Architecture Patterns

### Server Actions (Data Fetching)

All backend communication goes through **Next.js Server Actions** in `src/actions/`. These are `"use server"` functions that run on the Node.js server—not in the browser.

- **`src/lib/axios.ts`** — public Axios instance (no auth header). Used for unauthenticated requests.
- **`src/lib/auth-api.ts`** — `getAuthApiClient()` returns an Axios instance with the user's JWT injected from the server-side session. Used in all protected server actions.

```
Browser → Server Action (actions/*.ts) → Axios → Django REST API (port 8000)
```

### Auth Middleware (`proxy.ts`)

`src/proxy.ts` is a **Next.js middleware** (using `withAuth` from NextAuth) that:

1. **Guards** all `/dashboard/*` routes — unauthenticated users are redirected to `/?login=true`.
2. **Role-based redirects** — when a user hits `/dashboard`:
   - Instructors → `/dashboard/todays-schedule`
   - Students & Parents → `/dashboard/overview`

### DataView Component System

`src/components/ui/data-view/` is a **custom reusable table/card system** for listing data with built-in search, filter, sort, and pagination. It is the primary pattern used on all "list" pages.

**Key files:**

| File                                   | Purpose                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DataView.tsx`                         | Context provider — wraps the entire view. Accepts `data`, `sortConfig`, `filterConfig`, `gridLayout`. |
| `DataViewBody.tsx`                     | Renders rows or cards based on current layout                                                         |
| `DataViewRow.tsx` / `DataViewCell.tsx` | Table row / cell components                                                                           |
| `DataViewSearch.tsx`                   | Search input (syncs with `?search=` URL param)                                                        |
| `DataViewFilter.tsx`                   | Filter controls (syncs with `?filter=` URL param)                                                     |
| `DataViewSort.tsx`                     | Sort controls (syncs with `?sort-by=` URL param)                                                      |
| `DataViewPagination.tsx`               | Page navigation (syncs with `?page=` URL param)                                                       |
| `DataViewLayoutToggle.tsx`             | Toggle between table and card views                                                                   |

**How to use it for a new page:**

1. Define a **config file** (e.g. `my-page-view.config.ts`) that exports `sortConfig`, `filterConfig`, and `statusMap`.
2. Wrap your page content in `<DataView data={items} sortConfig={...} filterConfig={...} gridLayout="...">`.
3. Compose child components: `<DataViewSearch />`, `<DataViewSort />`, `<DataViewFilter />`, `<DataViewBody>`, `<DataViewPagination />`.

See existing examples:

- `src/components/courses/course-lectures-view.config.ts`
- `src/components/dashboard/dashboard-all-courses-view-config.ts`
- `src/components/lectures/lectures-view.config.ts`

### Hooks

The custom hooks power the DataView but can also be used independently:

| Hook                    | What it does                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `useFilterData`         | Reads `?filter=` from URL, applies filter logic to data array                                |
| `useSearchData`         | Reads `?search=` from URL, searches across all string fields                                 |
| `useSortData`           | Reads `?sort-by=` from URL, applies sort comparator                                          |
| `useMutateSearchParams` | Utility to push/replace URL search params without full navigation (To be replaced with Nuqs) |

### RTL & Arabic

The app is rendered **right-to-left** (`dir="rtl"`, `lang="ar"` on `<html>`). Fonts:

| Font                          | Variable         | Usage                     |
| ----------------------------- | ---------------- | ------------------------- |
| **El Messiri** (Google Fonts) | `--font-messiri` | Primary Arabic typeface   |
| **Medad Platinum** (local)    | `--font-medad`   | Decorative / heading font |

Utility helpers in `src/lib/utils.ts`:

- `toHindiDigits()` — converts `123` → `١٢٣`
- `formatDate()` — Arabic-locale date formatting
- `formatTime()` — Arabic-locale time formatting with AM/PM
- `getWeekDay()` — returns Arabic weekday name

---

## 8. Backend API Reference

The **single source of truth** for the backend API is:

📂 **`backend/docs_v2/`**

| Document            | What it covers                                                |
| ------------------- | ------------------------------------------------------------- |
| `authentication.md` | Login, register, JWT tokens, password management              |
| `courses-api.md`    | Courses, lectures, schedules, landing page, ratings           |
| `users-api.md`      | Instructor listing, details, ratings, landing page            |
| `parents-api.md`    | Child management (create, list, update, delete)               |
| `enrollment-api.md` | Enrollment requests, approvals, user & instructor enrollments |
| `attendance-api.md` | Instructor & student attendance, fingerprint devices, ratings |
| `websocket.md`      | Real-time attendance updates (WebSocket on port 8001)         |

### API Prefixes

| Module                 | Prefix                            |
| ---------------------- | --------------------------------- |
| Authentication         | `/auth/`                          |
| Courses & Lectures     | `/api/courses/`                   |
| Users & Instructors    | `/api/users/`                     |
| Parents & Children     | `/api/parents/`                   |
| Enrollment Requests    | `/api/enrollment-requests/`       |
| Enrollments            | `/api/enrollments/`               |
| Admin Enrollment Mgmt  | `/api/admin/enrollment-requests/` |
| Instructor Enrollments | `/api/instructor/`                |
| Attendance             | `/api/attendance/`                |

### Ports

| Port | Server          | Protocol    |
| ---- | --------------- | ----------- |
| 8000 | Gunicorn (WSGI) | HTTP / REST |
| 8001 | Uvicorn (ASGI)  | WebSocket   |

### Auth Header

All protected endpoints require:

```
Authorization: JWT <access_token>
```

> **Important:** The prefix is `JWT`, not `Bearer`.

---

## 9. Authentication Flow

```
┌───────────────────────────────────────────────────────────────────────┐
│  1. User enters phone number + password on the login form             │
│  2. NextAuth calls POST /auth/jwt/create/ → receives access + refresh │
│  3. Tokens are stored in an encrypted NextAuth session cookie         │
│  4. Server Actions read the session and inject JWT into Axios headers │
│  5. Token refresh is handled by NextAuth callbacks                    │
│  6. proxy.ts middleware guards /dashboard/* and redirects by role     │
└───────────────────────────────────────────────────────────────────────┘
```

**Key files:**

| File                                      | Purpose                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth route handler + config (JWT callbacks, provider)     |
| `src/actions/auth.ts`                     | `signUp()`, `getUser()`, `protect()`, `getServerJwtToken()`   |
| `src/lib/auth-api.ts`                     | `getAuthApiClient()` — returns Axios instance with JWT header |
| `src/providers/AuthProvider.tsx`          | Wraps app in NextAuth `SessionProvider`                       |
| `src/proxy.ts`                            | Middleware — auth guard + role-based redirects                |

### Role-based protection in pages

Use the `protect()` server action at the top of any page that should be restricted:

```tsx
// In a Server Component page
import { protect } from "@/actions/auth";

export default async function InstructorPage() {
  await protect(["instructor", "admin"]);
  // ... render page
}
```

---

## 10. Git Conventions

### Branch Naming

```
feature/<short-description>     # New feature
fix/<short-description>         # Bug fix
docs/<short-description>        # Documentation change
```

Examples: `feature/add-parent-child-form`, `fix/enrollment-status-display`, `docs/update-onboarding`

### Pull Request Process

- All PRs must target **`dev_branch`**.
- CODEOWNERS requires review from **`@Al-Redwan-Courses-Center/code-reviewers`**.

---

## 11. Coding Conventions

### Linting & Formatting

| Tool         | Config                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **ESLint**   | `next/core-web-vitals` + `next/typescript`. `@typescript-eslint/no-explicit-any` is **off** (any is allowed). |
| **Prettier** | With `prettier-plugin-tailwindcss` for automatic class sorting.                                               |

### shadcn/ui

- Style preset: **new-york**
- Components install to `@/shadcn/components/ui/` (Requires Manual Integration)
- Utility: `@/shadcn/lib/utils`

To add a new shadcn component:

```bash
pnpm dlx shadcn@latest add <component-name>
```

### General Patterns

- **Server Actions** for all data fetching / mutations (not client-side `fetch`).
- **URL search params** for state (search, filter, sort, pagination) — not React state.
- **Arabic UI text** hardcoded in components (no i18n library — Arabic only).
- **`cn()` helper** for merging Tailwind classes (combines `clsx` + `tailwind-merge`).

---

## 12. Design Reference

The Figma design files for the project:

- [Main Design File](https://www.figma.com/design/KCnwQOtTJxkL7OxI7RAAwn/Al-Redwan-Courses-Center)

Request access from the team lead if you don't have it.

---

## 13. Completed Features

### Public Pages (Landing)

| Feature                              | Status   |
| ------------------------------------ | -------- |
| Hero section                         | ✅ ~Done |
| Features grid                        | ✅ ~Done |
| Courses listing section              | ✅ ~Done |
| Instructors section + row            | ✅ ~Done |
| Testimonials section (list + slider) | ✅ ~Done |
| Statistics section                   | ✅ ~Done |
| Activities section                   | ✅ ~Done |
| Goals section                        | ✅ ~Done |
| Why Us section                       | ✅ ~Done |
| Call-to-action section               | ✅ ~Done |
| Picture grid                         | ✅ ~Done |
| About page                           | ✅ ~Done |
| Contact page                         | ✅ ~Done |
| Public courses catalogue & details   | ✅ ~Done |

> Landing page is ~95% complete — pending responsive design retrofi, final QA and product owner sign-off.

### Authentication

| Feature                         | Status  |
| ------------------------------- | ------- |
| Login form (phone + password)   | ✅ Done |
| Signup form (full registration) | ✅ Done |
| Signup modal                    | ✅ Done |
| Auth modal (login prompt)       | ✅ Done |
| Logout button                   | ✅ Done |
| NextAuth JWT integration        | ✅ Done |
| Role-based middleware redirect  | ✅ Done |

### Dashboard — Shared

| Feature                                 | Status  |
| --------------------------------------- | ------- |
| Dashboard layout (sidebar + header)     | ✅ Done |
| Role-based routing (route groups)       | ✅ Done |
| All Courses view (DataView table/cards) | ✅ Done |
| My Courses view                         | ✅ Done |
| Course detail + lectures list           | ✅ Done |
| Profile page                            | ✅ Done |
| Notifications drawer                    | ✅ Done |
| 404 Not Found page                      | ✅ Done |

### Dashboard — Student

| Feature                    | Status  |
| -------------------------- | ------- |
| Overview page with header  | ✅ Done |
| My courses page with cards | ✅ Done |
| Course card view           | ✅ Done |

### Dashboard — Instructor

| Feature                           | Status  |
| --------------------------------- | ------- |
| My courses page                   | ✅ Done |
| Today's schedule (lectures table) | ✅ Done |

### Dashboard — Parent

| Feature                           | Status  |
| --------------------------------- | ------- |
| Overview page with children cards | ✅ Done |
| My children page                  | ✅ Done |
| Child card / row components       | ✅ Done |

### Attendance

| Feature                   | Status  |
| ------------------------- | ------- |
| Lecture attendance view   | ✅ Done |
| Add lecture notes (modal) | ✅ Done |

### Enrollments

| Feature                   | Status  |
| ------------------------- | ------- |
| Enrollment card component | ✅ Done |
| Enrollments list          | ✅ Done |

### Reusable UI Library

| Component                                                           | Location         |
| ------------------------------------------------------------------- | ---------------- |
| DataView system (table/cards with search, filter, sort, pagination) | `ui/data-view/`  |
| Button, Input, Modal, Calendar, Checkbox                            | `ui/`            |
| DatePicker, TimePicker, WeekdayPicker                               | `courses/`       |
| StatusBadge, ProgressBar, ProgressBarWithLabel                      | `ui/`            |
| DropdownMenu, Popover, Tooltip, Toggle                              | `ui/`            |
| CopyToClipboardButton                                               | `ui/`            |
| Navigation components                                               | `ui/navigation/` |

---

## 14. Pending / Future Tasks

### High Priority — Core Functionality

| Task                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Relevant API Docs                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **All-attendances admin page**           | The centrepiece of the admin experience. A real-time attendance dashboard that: (1) shows today's attendance records (both `lecture` and `supervision` types), (2) integrates with WebSocket for live check-in/check-out updates from fingerprint devices, (3) allows admins to manually check-in/check-out, mark absent, and rate instructors, (4) supports filtering by date range, instructor, status, type, season, etc. See [§2.4](#24-instructor--supervisor-attendance-fingerprint-system) for full business logic.                                                                                                                                                               | `attendance-api.md`, `websocket.md`       |
| **WebSocket integration**                | Connect to `ws://localhost:8001/ws/attendance/` for live attendance updates. Use ticket-based auth (POST `/api/attendance/ws-ticket/` → connect with `?ticket=`). Handle events: `attendance_update`, `attendance_check_out`, `attendance_rated`, `summary_response`. See [§2.7](#27-websocket--real-time-attendance).                                                                                                                                                                                                                                                                                                                                                                   | `websocket.md`                            |
| **Supervisor schedule management UI**    | Admin page to create and manage supervisor weekly schedules. Define which supervisor works which days, with start/end times, grace period, and auto-absent timeout. These schedules drive the `supervision`-type attendance records. See [§2.4](#24-instructor--supervisor-attendance-fingerprint-system).                                                                                                                                                                                                                                                                                                                                                                               | `attendance-api.md` (Schedule Management) |
| **Season schedules overview page**       | A page that lists **all schedules for a given season** in one view — both course schedules (weekday/time per course) and supervisor schedules. This doesn't exist yet on either side: the frontend has no season-wide schedule view (only per-course fragments and an instructor "Today's Schedule" page), and the backend currently has no single endpoint that aggregates all course schedules + supervisor schedules for a season. **Backend work needed:** add an endpoint (or extend the season detail) that returns all course schedules and supervisor schedules for a season in one response. **Frontend work:** build the page, API action, and listing component from scratch. | `courses-api.md`, `attendance-api.md`     |
| **Parent: child CRUD forms**             | Forms for parents to create, update, and delete children. Backend API is ready. See [§2.6](#26-parents--children).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `parents-api.md`                          |
| **Signup flow — parent adding children** | After a parent signs up, they should be guided to add their first child before enrolling (when they try to enroll they should get redirected to the add child form).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `parents-api.md`                          |

### Medium Priority — Feature Completion

| Task                                                  | Description                                                                                                                                   | Relevant API Docs                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Admin instructor detail page**                      | View instructor bio/tags/info, timetable, and jump to instructor-filtered attendances. For supervisors, also show their `SupervisorSchedule`. | `users-api.md`, `attendance-api.md`           |
| **Profile: role-specific view/edit**                  | Each role can view/edit their own profile only, with role-specific fields.                                                                    | `authentication.md` (Get/Update Current User) |
| **Password management UI**                            | Change password and reset password flows.                                                                                                     | `authentication.md`                           |
| **Course and instructors ratings / review UI**        | Students can submit and view course ratings.                                                                                                  | `courses-api.md` (Ratings)                    |
| **Instructor ratings UI**                             | View instructor ratings breakdown.                                                                                                            | `users-api.md` (Ratings)                      |
| **Attendance record generation UI**                   | Admin can trigger `POST /api/attendance/generate/` to pre-create or backfill attendance records for a date range.                             | `attendance-api.md`                           |
| **Responsive design — student & parent dashboard**    | Fully responsive across mobile / tablet / desktop.                                                                                            |
| **Responsive design — instructor & admin dashboards** | Existing pages responsive; ensure consistency.                                                                                                |
| **Landing page spacing polish**                       | Fine-tune spacing and layout on smaller screens.                                                                                              |
| **Excel export from frontend**                        | Trigger Excel exports for admin data (attendance, enrollments).                                                                               |
| **Production deployment optimisation**                | Image optimisation, bundle analysis, caching headers if applicable.                                                                           |

---

_Last updated: April 2026_
