# ADMS - Attendance Device Management System

A Node.js server for managing eSSL biometric attendance devices. Receives real-time attendance data from eSSL devices and provides a REST API for dashboard integration.

## Features

- 🔌 **eSSL Device Integration** - Receives attendance data via ADMS protocol
- 📊 **REST API** - JSON endpoints for dashboard/frontend apps
- 🗄️ **PostgreSQL Database** - Supabase compatible
- 👥 **Employee Management** - Track employees and departments
- 📈 **Attendance Reports** - Daily summaries and filtered queries

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/rishabh-salty/ADMS.git
cd ADMS
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
DB_HOST=your-database-host
DB_PORT=5432
DB_USER=your-database-user
DB_PASSWORD=your-database-password
DB_NAME=postgres
```

### 3. Run Server

```bash
node app.js
```

Server starts at `http://localhost:8080`

## eSSL Device Configuration

Configure your biometric device with these settings:

| Setting | Value |
|---------|-------|
| Server Mode | ADMS |
| Server Address | `http://YOUR_SERVER_IP` |
| Server Port | `8080` |

The device will automatically push attendance data to `/iclock/cdata`

## API Endpoints

### Device Endpoints (eSSL Protocol)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/iclock/cdata` | Device handshake/registration |
| POST | `/iclock/cdata` | Receive attendance data |
| POST | `/iclock/getrequest` | Device heartbeat |

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List all employees |
| POST | `/api/employees` | Add new employee |
| GET | `/api/attendance` | Get attendance records |
| GET | `/api/attendance/today` | Today's summary |
| GET | `/api/devices` | List connected devices |
| GET | `/api/reports/daily` | Daily attendance report |

### Query Parameters

**GET /api/attendance**
- `emp_id` - Filter by employee ID
- `start_date` - Start date (YYYY-MM-DD)
- `end_date` - End date (YYYY-MM-DD)
- `limit` - Max records (default: 100)

**GET /api/reports/daily**
- `start_date` - Required
- `end_date` - Required

## Database Schema

### devices
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| device_sn | VARCHAR(50) | Device serial number |
| device_name | VARCHAR(100) | Device name |
| last_activity | TIMESTAMP | Last communication |
| status | VARCHAR(10) | online/offline |

### employees
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| emp_id | VARCHAR(20) | Employee ID |
| name | VARCHAR(100) | Full name |
| department | VARCHAR(50) | Department |
| email | VARCHAR(100) | Email address |

### attendance
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| device_sn | VARCHAR(50) | Source device |
| emp_id | VARCHAR(20) | Employee ID |
| punch_time | TIMESTAMP | Punch timestamp |
| punch_state | INT | 0=In, 1=Out, 2=Break, 3=OT |
| verify_mode | INT | 0=Password, 1=FP, 15=Face |

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (Supabase)
- **Driver**: pg

## License

MIT
